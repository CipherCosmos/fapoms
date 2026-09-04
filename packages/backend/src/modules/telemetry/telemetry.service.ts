import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ActivityTelemetryEntity } from './activity-telemetry.entity';
import { sanitizeTelemetryEvent, type RawTelemetryEvent } from './telemetry-scrub';

/** The identity/context a telemetry batch is attributed to — taken from the request, not the client. */
export interface TelemetryContext {
  userId: string;
  sessionId?: string | null;
  ipAddress?: string | null;
}

/** How many events one POST may carry — a bound on abuse and on one insert. */
export const MAX_TELEMETRY_BATCH = 50;

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(
    @InjectRepository(ActivityTelemetryEntity)
    private readonly repo: Repository<ActivityTelemetryEntity>,
  ) {}

  /**
   * Ingest a batch of UI events. Identity comes from `ctx` (the authenticated principal + session +
   * IP), never from the payload; each event is sanitized and PII-scrubbed before it is stored, and
   * anything that fails the allowlist is silently dropped. Returns how many were actually recorded.
   *
   * Best-effort by nature: telemetry must never be able to fail a user's real request, so callers
   * treat a rejection here as nothing more than lost analytics.
   */
  async record(events: RawTelemetryEvent[], ctx: TelemetryContext): Promise<number> {
    if (!Array.isArray(events) || events.length === 0) return 0;
    const rows = events
      .slice(0, MAX_TELEMETRY_BATCH)
      .map((e) => sanitizeTelemetryEvent(e))
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .map((e) =>
        this.repo.create({
          userId: ctx.userId,
          sessionId: ctx.sessionId ?? null,
          ipAddress: ctx.ipAddress ?? null,
          eventType: e.eventType,
          path: e.path,
          label: e.label,
          metadata: e.metadata,
        }),
      );
    if (rows.length === 0) return 0;
    // save() rather than insert(): these rows carry no id, so it is an insert either way, and save's
    // entity typing accepts the jsonb `metadata` shape that insert's QueryDeepPartial rejects.
    await this.repo.save(rows);
    return rows.length;
  }

  /** One user's recent UI activity — the admin timeline. Newest first. */
  async listForUser(userId: string, limit = 100): Promise<ActivityTelemetryEntity[]> {
    return this.repo.find({
      where: { userId },
      order: { occurredAt: 'DESC' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }
}
