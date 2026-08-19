import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';

import { FeedbackThreadEntity } from './feedback-thread.entity';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { businessTodayDateKey } from '@fapoms/shared';

/**
 * Response-time SLAs for the feedback desk, and the escalation that enforces them.
 *
 * A real support operation commits to *when* it responds, not just that it will.
 * Two commitments are tracked:
 *
 *  - **First response** — how long a reporter waits before the team first replies.
 *    One threshold for everything (people mostly want to be heard quickly).
 *  - **Resolution** — how long an item may stay open, scaled by severity, because a
 *    critical bug and a nice-to-have do not deserve the same clock.
 *
 * All thresholds are env-tunable with sensible defaults, so operations can tighten
 * or relax them without a deploy. `attention()` powers the desk's "needs attention"
 * surface; `scan()` — run from the existing 15-minute SLA scanner — raises one
 * escalation notification per breached item per day (day-bucketed dedupe), exactly
 * as the assayer-assignment and data-entry desks already do.
 */

/**
 * The shipped commitments, used when nothing is configured.
 *
 * These used to BE the SLA: a frozen object built from `process.env` at import time, so the
 * response commitment could only be changed by editing an environment file and restarting —
 * by whoever has deploy access rather than by the product team who owns the promise. They are
 * now the last fallback in the usual saved -> env -> default chain, read per scan.
 */
export const FEEDBACK_SLA_DEFAULTS = {
  firstResponse: 24,
  resolution: { CRITICAL: 8, HIGH: 24, MEDIUM: 72, LOW: 168 },
};

export interface FeedbackAttentionItem {
  id: string;
  title: string;
  severity: string;
  category: string;
  ageHours: number;
  reporterName: string;
  assignedToUserId: string | null;
}

export interface FeedbackAttention {
  firstResponseOverdue: FeedbackAttentionItem[];
  resolutionOverdue: FeedbackAttentionItem[];
}

@Injectable()
export class FeedbackEscalationService {
  private readonly logger = new Logger(FeedbackEscalationService.name);

  constructor(
    @InjectRepository(FeedbackThreadEntity)
    private readonly threadRepository: Repository<FeedbackThreadEntity>,
    private readonly notificationDispatch: NotificationDispatchService,
    private readonly settings: PlatformSettingsService,
  ) {}

  /** Resolved per scan, so a change on the settings page takes effect on the next sweep. */
  private async sla() {
    const [firstResponse, CRITICAL, HIGH, MEDIUM, LOW] = await Promise.all([
      this.settings.getNumber('feedback.firstResponseHours', FEEDBACK_SLA_DEFAULTS.firstResponse),
      this.settings.getNumber('feedback.resolveCriticalHours', FEEDBACK_SLA_DEFAULTS.resolution.CRITICAL),
      this.settings.getNumber('feedback.resolveHighHours', FEEDBACK_SLA_DEFAULTS.resolution.HIGH),
      this.settings.getNumber('feedback.resolveMediumHours', FEEDBACK_SLA_DEFAULTS.resolution.MEDIUM),
      this.settings.getNumber('feedback.resolveLowHours', FEEDBACK_SLA_DEFAULTS.resolution.LOW),
    ]);
    return { firstResponse, resolution: { CRITICAL, HIGH, MEDIUM, LOW } };
  }

  private map(rows: any[]): FeedbackAttentionItem[] {
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      severity: r.severity,
      category: r.category,
      ageHours: Math.round(Number(r.age_hours)),
      reporterName: r.reporter_name,
      assignedToUserId: r.assigned_to_user_id ?? null,
    }));
  }

  async attention(): Promise<FeedbackAttention> {
    const sla = await this.sla();
    const [firstResponseOverdue, resolutionOverdue] = await Promise.all([
      this.threadRepository.manager.query(
        `
        SELECT id, title, severity, category, reporter_name, assigned_to_user_id,
               EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 AS age_hours
        FROM feedback_threads
        WHERE is_active = true
          AND first_responded_at IS NULL
          AND status NOT IN ('RESOLVED', 'CLOSED')
          AND created_at < NOW() - make_interval(hours => $1::int)
        ORDER BY created_at ASC
        `,
        [sla.firstResponse],
      ),
      this.threadRepository.manager.query(
        `
        SELECT id, title, severity, category, reporter_name, assigned_to_user_id,
               EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 AS age_hours
        FROM feedback_threads
        WHERE is_active = true
          AND status IN ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS')
          AND created_at < NOW() - make_interval(hours =>
            (CASE severity
              WHEN 'CRITICAL' THEN $1
              WHEN 'HIGH' THEN $2
              WHEN 'MEDIUM' THEN $3
              ELSE $4 END)::int)
        ORDER BY
          CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
          created_at ASC
        `,
        [sla.resolution.CRITICAL, sla.resolution.HIGH, sla.resolution.MEDIUM, sla.resolution.LOW],
      ),
    ]);
    return { firstResponseOverdue: this.map(firstResponseOverdue), resolutionOverdue: this.map(resolutionOverdue) };
  }

  /** Called from the 15-minute SLA scanner. One reminder per breached item per day. */
  async scan(): Promise<void> {
    const { firstResponseOverdue, resolutionOverdue } = await this.attention();
    // The working day this reminder belongs to, in India — not the server's UTC date, which
    // would put the boundary of "one reminder per day" at half past five in the morning.
    const day = businessTodayDateKey();

    for (const item of firstResponseOverdue) {
      this.notificationDispatch.emitSafe({
        type: 'FEEDBACK_SLA_FIRST_RESPONSE_BREACH',
        entityType: 'FEEDBACK',
        entityId: item.id,
        dedupeKey: `FEEDBACK_SLA_FIRST_RESPONSE_BREACH:${item.id}:${day}`,
        payload: { threadId: item.id, title: item.title, hours: item.ageHours },
      });
    }
    for (const item of resolutionOverdue) {
      this.notificationDispatch.emitSafe({
        type: 'FEEDBACK_SLA_RESOLUTION_BREACH',
        entityType: 'FEEDBACK',
        entityId: item.id,
        // The owner in particular, if one is assigned — plus the whole team.
        ownerUserId: item.assignedToUserId ?? undefined,
        dedupeKey: `FEEDBACK_SLA_RESOLUTION_BREACH:${item.id}:${day}`,
        payload: { threadId: item.id, title: item.title, hours: item.ageHours, severity: item.severity },
      });
    }

    const total = firstResponseOverdue.length + resolutionOverdue.length;
    if (total > 0) {
      this.logger.log(`Feedback SLA scan: ${firstResponseOverdue.length} awaiting first response, ${resolutionOverdue.length} past resolution SLA.`);
    }
  }
}
