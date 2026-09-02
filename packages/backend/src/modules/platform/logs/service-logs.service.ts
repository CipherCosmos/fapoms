import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import {
  LOG_SERVICES, LOG_TAIL_DEFAULT, LOG_TAIL_MAX, LOG_RESPONSE_MAX_BYTES,
  isKnownLogService, type LogLine, type ServiceLogsPage, type LogServiceDescriptor,
} from '@fapoms/shared';
import { DockerEngineClient, type ContainerSummary } from './docker-engine.client';
import { DockerLogParser } from './docker-log-parser';
import { redactLogLine } from './log-redaction';

export interface AvailableService extends LogServiceDescriptor {
  readonly running: boolean;
  readonly state: string;
  readonly containerName: string;
}

export interface HistoryOptions {
  readonly tail?: number;
  readonly since?: string;
  readonly until?: string;
  readonly q?: string;
}

@Injectable()
export class ServiceLogsService {
  private readonly log = new Logger(ServiceLogsService.name);

  constructor(private readonly docker: DockerEngineClient) {}

  get enabled(): boolean {
    return this.docker.configured;
  }

  /** The services this stack actually runs, in catalogue order rather than Docker's. */
  async listAvailable(): Promise<AvailableService[]> {
    const containers = await this.visibleContainers();
    const out: AvailableService[] = [];
    for (const descriptor of LOG_SERVICES) {
      const c = containers.find((x) => x.service === descriptor.service);
      if (!c) continue;
      out.push({ ...descriptor, running: c.running, state: c.state, containerName: c.name });
    }
    return out;
  }

  /**
   * Read back through a service's log.
   *
   * Filtering happens here rather than in the browser so that the cap counts lines the reader
   * asked for. Searching for one request id in a service that logs a thousand lines a minute is
   * the whole point; a client-side filter over the last 500 lines would almost always show
   * nothing and give no hint that the answer was just outside the window.
   */
  async history(service: string, opts: HistoryOptions): Promise<ServiceLogsPage> {
    const container = await this.resolve(service);
    const detail = await this.docker.inspect(container.id);

    const tail = clampTail(opts.tail);
    const stream = await this.docker.openLogStream(container.id, {
      tail,
      since: parseMoment(opts.since, 'since'),
      until: parseMoment(opts.until, 'until'),
    });

    const needle = opts.q?.trim().toLowerCase() || null;
    const parser = new DockerLogParser(detail.tty);
    const lines: LogLine[] = [];
    let bytes = 0;
    let truncated = false;

    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of parser.push(value)) {
          if (needle && !line.text.toLowerCase().includes(needle)) continue;
          const safe = { ...line, text: redactLogLine(line.text) };
          bytes += safe.text.length;
          lines.push(safe);
          // Two independent ceilings. Line count protects the browser; byte count protects the
          // API, because a single line can be a megabyte of stack trace and a thousand of those
          // is a response nobody can hold in memory on either end.
          if (lines.length >= tail || bytes >= LOG_RESPONSE_MAX_BYTES) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }
      if (!truncated) {
        for (const line of parser.flush()) {
          if (needle && !line.text.toLowerCase().includes(needle)) continue;
          lines.push({ ...line, text: redactLogLine(line.text) });
        }
      }
    } finally {
      // Cancel rather than merely dropping the reference: an un-cancelled body leaves the socket
      // to the proxy open until GC, and this endpoint is polled.
      await reader.cancel().catch(() => undefined);
    }

    return {
      service,
      lines,
      truncated,
      running: detail.running,
      containerStartedAt: detail.startedAt,
    };
  }

  /**
   * Follow a service's log, yielding lines as they are written.
   *
   * `tail` seeds the stream with recent history so the viewer is not blank until something
   * happens — on a quiet service that could be minutes, which reads as "the feature is broken".
   */
  async *follow(
    service: string,
    tail: number,
    signal: AbortSignal,
  ): AsyncGenerator<LogLine, void, unknown> {
    const container = await this.resolve(service);
    const detail = await this.docker.inspect(container.id);
    const stream = await this.docker.openLogStream(container.id, {
      tail: clampTail(tail),
      follow: true,
      signal,
    });

    const parser = new DockerLogParser(detail.tty);
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of parser.push(value)) {
          yield { ...line, text: redactLogLine(line.text) };
        }
      }
      for (const line of parser.flush()) yield { ...line, text: redactLogLine(line.text) };
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  /**
   * Name to container, through the allowlist.
   *
   * Two filters, both necessary. The catalogue stops a caller naming a container that is none of
   * this platform's business; the project check stops the name resolving to another stack's
   * container on a daemon that hosts more than one.
   */
  private async resolve(service: string): Promise<ContainerSummary> {
    if (!isKnownLogService(service)) {
      throw new NotFoundException(`'${service}' is not a service whose logs this platform serves.`);
    }
    const container = (await this.visibleContainers()).find((c) => c.service === service);
    if (!container) {
      throw new NotFoundException(`The service '${service}' is not part of this deployment.`);
    }
    return container;
  }

  private async visibleContainers(): Promise<ContainerSummary[]> {
    const [all, project] = await Promise.all([
      this.docker.listContainers(),
      this.docker.currentProject(),
    ]);
    return all.filter((c) => {
      if (!c.service || !isKnownLogService(c.service)) return false;
      return project ? c.project === project : true;
    });
  }
}

function clampTail(tail: number | undefined): number {
  if (tail === undefined || Number.isNaN(tail)) return LOG_TAIL_DEFAULT;
  return Math.min(Math.max(Math.trunc(tail), 1), LOG_TAIL_MAX);
}

/**
 * Accept both an absolute instant and the relative shorthand people actually type.
 *
 * "15m" is what someone reaching for logs after an incident means, and making them compute an
 * ISO timestamp for it is the kind of friction that sends them back to asking the hosting team.
 */
const RELATIVE = /^(\d+)\s*(s|m|h|d)$/i;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseMoment(value: string | undefined, field: string): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();

  const rel = RELATIVE.exec(trimmed);
  if (rel) {
    const seconds = Number(rel[1]) * UNIT_SECONDS[rel[2].toLowerCase()];
    return Math.floor(Date.now() / 1000) - seconds;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new BadRequestException(
      `'${field}' must be an ISO-8601 instant or a relative window like 15m, 2h or 3d — got '${value}'.`,
    );
  }
  return Math.floor(parsed / 1000);
}
