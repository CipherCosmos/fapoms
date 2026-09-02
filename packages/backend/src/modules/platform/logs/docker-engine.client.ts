import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as os from 'os';

/**
 * A deliberately small client for the Docker Engine API.
 *
 * It does NOT talk to /var/run/docker.sock. The socket is mounted into a separate, read-only
 * proxy container which permits GET on /containers and nothing else; this client speaks HTTP to
 * that. The distinction matters more than it looks: the Docker socket is root on the host with
 * extra steps — anything holding it can start a privileged container and mount the filesystem.
 * Putting it inside the API process would mean that any remote-code-execution bug in the backend,
 * a process that parses uploaded spreadsheets and renders PDFs, escalates straight to the host
 * that stores the audit record. The proxy makes the worst case "an attacker can read logs",
 * which is bad but bounded, and is a strictly smaller set of powers than the ones the backend
 * already has over its own data.
 *
 * Only the four calls the log viewer needs are implemented. There is no generic request helper,
 * on purpose: the next person wanting `POST /containers/{id}/stop` should have to add it and
 * explain why, rather than find it already sitting there.
 */

export interface ContainerSummary {
  readonly id: string;
  readonly name: string;
  /** The compose service this container implements, from its labels. Null if not compose-managed. */
  readonly service: string | null;
  readonly project: string | null;
  readonly state: string;
  readonly running: boolean;
  readonly createdAt: string | null;
}

export interface ContainerDetail {
  readonly id: string;
  /** Whether a TTY was allocated, which decides whether the log stream is framed. */
  readonly tty: boolean;
  readonly running: boolean;
  readonly startedAt: string | null;
}

export interface LogFetchOptions {
  readonly tail?: number;
  /** Unix seconds. */
  readonly since?: number;
  readonly until?: number;
  readonly follow?: boolean;
  readonly signal?: AbortSignal;
}

@Injectable()
export class DockerEngineClient {
  private readonly log = new Logger(DockerEngineClient.name);
  private readonly base: string;
  /** Cached because it requires a lookup and never changes for the life of the process. */
  private ownProject: string | null | undefined;

  constructor() {
    // The proxy's address. Kept as a URL rather than a socket path so that the only way to reach
    // Docker from this process is over a network hop something else is allowed to refuse.
    this.base = (process.env.DOCKER_API_URL ?? 'http://dockerproxy:2375').replace(/\/+$/, '');
  }

  /** Whether the feature can work at all here. Absent proxy => the viewer reports it, cleanly. */
  get configured(): boolean {
    return process.env.SERVICE_LOGS_ENABLED !== 'false';
  }

  async listContainers(): Promise<ContainerSummary[]> {
    const raw = await this.get<any[]>('/containers/json?all=1');
    return raw.map((c) => {
      const labels: Record<string, string> = c.Labels ?? {};
      return {
        id: c.Id,
        // Docker returns names with a leading slash.
        name: (c.Names?.[0] ?? '').replace(/^\//, ''),
        service: labels['com.docker.compose.service'] ?? null,
        project: labels['com.docker.compose.project'] ?? null,
        state: c.State ?? 'unknown',
        running: c.State === 'running',
        createdAt: c.Created ? new Date(c.Created * 1000).toISOString() : null,
      };
    });
  }

  async inspect(id: string): Promise<ContainerDetail> {
    // Only four fields are read. The full inspect payload includes the container's environment,
    // which is why nothing here returns it or logs it.
    const raw = await this.get<any>(`/containers/${encodeURIComponent(id)}/json`);
    return {
      id: raw.Id,
      tty: Boolean(raw.Config?.Tty),
      running: Boolean(raw.State?.Running),
      startedAt: raw.State?.StartedAt ?? null,
    };
  }

  /**
   * Open the log stream. Returns the raw body; framing is the parser's problem.
   *
   * `follow` turns this into a long-lived response that never completes on its own — the caller
   * must abort it, and every caller here does, via a timeout and the client's disconnect.
   */
  async openLogStream(id: string, opts: LogFetchOptions): Promise<ReadableStream<Uint8Array>> {
    const q = new URLSearchParams({ stdout: '1', stderr: '1', timestamps: '1' });
    if (opts.follow) q.set('follow', '1');
    if (opts.tail !== undefined) q.set('tail', String(opts.tail));
    if (opts.since !== undefined) q.set('since', String(opts.since));
    if (opts.until !== undefined) q.set('until', String(opts.until));

    const url = `${this.base}/containers/${encodeURIComponent(id)}/logs?${q}`;
    const res = await this.fetchOrThrow(url, opts.signal);
    if (!res.body) throw new ServiceUnavailableException('Docker returned no log stream.');
    return res.body as ReadableStream<Uint8Array>;
  }

  /**
   * Which compose project this backend belongs to.
   *
   * Used to refuse containers from any other stack sharing the daemon. Without it, "read the
   * logs of the service called postgres" would resolve to whichever postgres the daemon happened
   * to list first — someone else's, on a shared box.
   *
   * Derived from our own container: Docker sets the hostname to the short container id unless
   * told otherwise, so we can look ourselves up and read our own labels.
   */
  async currentProject(): Promise<string | null> {
    if (this.ownProject !== undefined) return this.ownProject;

    const explicit = process.env.COMPOSE_PROJECT_NAME?.trim();
    if (explicit) return (this.ownProject = explicit);

    try {
      const self = os.hostname();
      const containers = await this.listContainers();
      const mine = containers.find((c) => c.id.startsWith(self) || c.name === self);
      this.ownProject = mine?.project ?? null;
      if (!this.ownProject) {
        this.log.warn(
          'Could not determine this container\'s compose project; service-log lookups will not be ' +
            'restricted to one project. Set COMPOSE_PROJECT_NAME to restore that restriction.',
        );
      }
      return this.ownProject;
    } catch {
      this.ownProject = null;
      return null;
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchOrThrow(`${this.base}${path}`);
    return (await res.json()) as T;
  }

  private async fetchOrThrow(url: string, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      // Distinguished from a Docker-level error because the remedy is completely different:
      // this one means the proxy container is missing or not on this network.
      throw new ServiceUnavailableException(
        `Cannot reach the Docker log proxy at ${this.base}. Is the 'dockerproxy' service running? ` +
          `(${(err as Error).message})`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 403) {
        throw new ServiceUnavailableException(
          'The Docker log proxy refused this call. It is configured to permit only container reads.',
        );
      }
      throw new ServiceUnavailableException(`Docker API returned ${res.status}: ${body.slice(0, 200)}`);
    }
    return res;
  }
}
