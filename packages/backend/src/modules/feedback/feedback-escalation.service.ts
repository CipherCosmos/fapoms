import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FeedbackThreadEntity } from './feedback-thread.entity';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';

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

const hours = (key: string, fallback: number): number => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const FEEDBACK_SLA = {
  firstResponse: hours('FEEDBACK_FIRST_RESPONSE_SLA_HOURS', 24),
  resolution: {
    CRITICAL: hours('FEEDBACK_RESOLUTION_CRITICAL_SLA_HOURS', 8),
    HIGH: hours('FEEDBACK_RESOLUTION_HIGH_SLA_HOURS', 24),
    MEDIUM: hours('FEEDBACK_RESOLUTION_MEDIUM_SLA_HOURS', 72),
    LOW: hours('FEEDBACK_RESOLUTION_LOW_SLA_HOURS', 168),
  },
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
  ) {}

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
        [FEEDBACK_SLA.firstResponse],
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
        [FEEDBACK_SLA.resolution.CRITICAL, FEEDBACK_SLA.resolution.HIGH, FEEDBACK_SLA.resolution.MEDIUM, FEEDBACK_SLA.resolution.LOW],
      ),
    ]);
    return { firstResponseOverdue: this.map(firstResponseOverdue), resolutionOverdue: this.map(resolutionOverdue) };
  }

  /** Called from the 15-minute SLA scanner. One reminder per breached item per day. */
  async scan(): Promise<void> {
    const { firstResponseOverdue, resolutionOverdue } = await this.attention();
    const day = new Date().toISOString().slice(0, 10);

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
