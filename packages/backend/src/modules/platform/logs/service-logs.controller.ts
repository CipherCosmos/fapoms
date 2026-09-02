import {
  Controller, Get, Param, Query, Req, Res, UseGuards, ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { SystemRole, LOG_STREAM_MAX_SECONDS, LOG_TAIL_DEFAULT, type LogLine } from '@fapoms/shared';
import { EventCategory } from '@fapoms/shared';
import { JwtAuthGuard, RolesGuard, Roles } from '../../auth/guards';
import { AuditService } from '../../../core/audit/audit.service';
import { NOT_A_RECORD_ENTITY_ID } from '../../../core/audit/audit-event';
import { NoEnvelope } from '../../../infrastructure/http/response.interceptor';
import { ServiceLogsService } from './service-logs.service';

/**
 * Container logs, for administrators who cannot reach the machine.
 *
 * Gated on the role itself rather than a grantable permission, deliberately and for the same
 * reason the rule-bypass screen is: logs are the least filtered view of the system that exists.
 * They carry request paths, identifiers, error contexts and — despite the redaction pass on the
 * way out — whatever a dependency decided to print. That is not a capability that should be
 * addable to a role by editing a role.
 *
 * Every read is written to the audit trail. A feature whose purpose is to show one person
 * everything the platform did should record who looked and at what; without that, the log viewer
 * is the one action in the system that leaves no trace.
 */
@ApiTags('Service Logs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(SystemRole.ADMIN)
@Controller('admin/logs')
export class ServiceLogsController {
  constructor(
    private readonly logs: ServiceLogsService,
    private readonly audit: AuditService,
  ) {}

  /** Which services this deployment runs, and whether each is currently up. */
  @Get('services')
  @ApiOperation({ summary: 'Services whose logs are readable on this deployment' })
  async services() {
    this.assertEnabled();
    return { success: true, data: { services: await this.logs.listAvailable() } };
  }

  /**
   * Read back through one service's log.
   *
   * `format=text` returns text/plain rather than JSON, which is what makes this usable from a
   * terminal without a JSON processor — the shape of the answer to "paste me the last 200 lines".
   *
   * The token goes in the Authorization header and never in the query string: URLs end up in
   * shell history, proxy logs and the browser's address bar, and a credential that reaches any
   * of those has effectively been published.
   */
  @Get(':service')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  // Opted out of the response envelope, and it is `format=text` that needs it. `@Res({
  // passthrough: true })` does not send headers, so without this the interceptor would wrap the
  // plain-text body into `{"success":true,"data":"…"}` — turning the one output shape meant to be
  // read by a terminal into escaped JSON. The JSON branch below already returns the envelope by
  // hand, so opting out changes nothing for it.
  @NoEnvelope()
  @ApiOperation({ summary: 'Historical log lines for one service' })
  async history(
    @Param('service') service: string,
    @Query('tail') tail: string | undefined,
    @Query('since') since: string | undefined,
    @Query('until') until: string | undefined,
    @Query('q') q: string | undefined,
    @Query('format') format: string | undefined,
    @Query('download') download: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertEnabled();
    const page = await this.logs.history(service, {
      tail: tail ? Number(tail) : undefined,
      since, until, q,
    });

    await this.record(req, 'SERVICE_LOG_READ', service, {
      tail: tail ?? LOG_TAIL_DEFAULT, since, until, query: q, format: format ?? 'json',
      linesReturned: page.lines.length, truncated: page.truncated,
    });

    if (format === 'text') {
      res.type('text/plain; charset=utf-8');
      if (download === '1') {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        res.setHeader('Content-Disposition', `attachment; filename="${service}-${stamp}.log"`);
      }
      return page.lines.map(renderLine).join('\n');
    }
    return { success: true, data: page };
  }

  /**
   * Follow one service's log over server-sent events.
   *
   * SSE rather than the websocket the platform already runs, because this is a one-way firehose
   * of text to a single screen: it needs no client-to-server channel, it survives a proxy that
   * only understands HTTP, and it reconnects on its own. Putting it on the socket.io namespace
   * would have meant giving the realtime gateway a reason to hold a Docker connection open.
   *
   * The stream closes itself after a bounded window. A tab left open overnight otherwise pins a
   * connection to the Docker proxy for as long as the browser lives, and the failure is invisible
   * until the proxy runs out of them.
   */
  @Get(':service/stream')
  // 10/min was too tight in practice. This stack runs `nest start --watch`, so the API
  // restarts on every code change and takes every open stream with it; the client redials,
  // and a handful of restarts plus a couple of open tabs exhausted the budget and locked the
  // feature out for the rest of the minute. Still low enough to bound Docker connections.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @NoEnvelope()
  @ApiOperation({ summary: 'Live-follow one service, as server-sent events' })
  async stream(
    @Param('service') service: string,
    @Query('tail') tail: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    this.assertEnabled();
    await this.record(req, 'SERVICE_LOG_STREAM', service, { tail: tail ?? 200 });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Caddy and nginx will otherwise buffer the response and the stream arrives in one lump
      // when it ends, which looks exactly like the feature not working.
      'X-Accel-Buffering': 'no',
    });

    const controller = new AbortController();
    const stopAt = setTimeout(() => controller.abort(), LOG_STREAM_MAX_SECONDS * 1000);
    // A browser tab closing does not produce an error on the generator; without this the read
    // loop keeps pulling from Docker into a socket nobody is holding.
    req.on('close', () => controller.abort());

    // A comment frame every 25s keeps intermediaries from reaping an idle connection, and tells
    // the client the stream is alive on a service that simply has nothing to say.
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);

    try {
      for await (const line of this.logs.follow(service, tail ? Number(tail) : 200, controller.signal)) {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(stopAt);
      res.end();
    }
  }

  private assertEnabled(): void {
    if (!this.logs.enabled) {
      throw new ServiceUnavailableException(
        'The service-log viewer is disabled on this deployment (SERVICE_LOGS_ENABLED=false).',
      );
    }
  }

  private async record(
    req: Request,
    eventType: string,
    service: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const user = (req as any).user ?? {};
    await this.audit.recordEventSafe({
      category: EventCategory.USER,
      eventType,
      entityType: 'ServiceLog',
      entityId: NOT_A_RECORD_ENTITY_ID,
      userId: user.id,
      userDisplayName: user.fullName ?? user.username ?? user.email ?? null,
      ipAddress: req.ip,
      remarks: `Read logs for '${service}'`,
      metadata: { service, ...metadata },
    });
  }
}

/** One line, as a terminal would show it: timestamp, stream marker for stderr, text. */
function renderLine(line: LogLine): string {
  const ts = line.ts ? `${line.ts} ` : '';
  const marker = line.stream === 'stderr' ? '[stderr] ' : '';
  return `${ts}${marker}${line.text}`;
}
