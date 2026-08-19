import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ValidationCaseEntity } from './validation-case.entity';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';

/**
 * The desk's SLA policy and escalation engine — the data-entry mirror of the
 * assignment flow's SLA scanner.
 *
 * Every received packet must be delegated, keyed, reviewed and SUBMITTED BACK TO THE
 * CLIENT; the head owns that pipeline end to end. Counts and queues show the state,
 * but nothing chased anyone when a stage stalled: a packet could sit unassigned for a
 * week, a member could hold work silently, an approved report could simply never be
 * sent. Each threshold below defines "stalled" for one stage; the 15-minute SLA scan
 * calls `scan()` which notifies the head (and, where one exists, the responsible
 * member) — one reminder per item per day while the breach persists. `attention()`
 * serves the same buckets to the head's Overview as the desk's exception inbox.
 *
 * Thresholds are env-tunable without a deploy: DESK_*_SLA_HOURS.
 */

const hours = (env: string, fallback: number): number => {
  const n = Number(process.env[env]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const DESK_SLA = {
  /** Received packet with nobody assigned. */
  assignHours: hours('DESK_ASSIGN_SLA_HOURS', 24),
  /** Delegated packet not handed back. */
  entryHours: hours('DESK_ENTRY_SLA_HOURS', 48),
  /** Case sitting in review with no decision. */
  reviewHours: hours('DESK_REVIEW_SLA_HOURS', 24),
  /** Rework bounced back and not resolved. */
  reworkHours: hours('DESK_REWORK_SLA_HOURS', 24),
  /** Packet pushed to the external OCR app and never heard from again. */
  ocrHours: hours('DESK_OCR_SLA_HOURS', 48),
  /** Approved report not submitted to the client — the step the client sees. */
  submitHours: hours('DESK_SUBMIT_SLA_HOURS', 48),
  /** Assayer clarification with no resolution (or past its own due date). */
  clarificationHours: hours('DESK_CLARIFICATION_SLA_HOURS', 24),
};

export interface AttentionItem {
  id: string;
  projectBranchId: string | null;
  branchName: string | null;
  /** How long this item has been in breach-relevant state, in whole hours. */
  ageHours: number;
  /** The responsible person, when one exists (assignee / reviewer). */
  who: string | null;
  whoId: string | null;
}

/**
 * One bucket of breached work: the rows being shown, and how many there actually are.
 *
 * `total` is the whole breach count, not `items.length`. Without it the banner read "50 items
 * past their due date" whether there were 50 or 400 — a silent cap presented as a fact, on the
 * one screen whose job is to say how bad the backlog is.
 */
export interface AttentionBucket {
  items: AttentionItem[];
  total: number;
}

export interface DeskAttention {
  slaHours: typeof DESK_SLA;
  unassignedOverdue: AttentionBucket;
  entryOverdue: AttentionBucket;
  reworkStale: AttentionBucket;
  reviewOverdue: AttentionBucket;
  submitOverdue: AttentionBucket;
  ocrStuck: AttentionBucket;
  clarificationsOverdue: AttentionBucket;
}

/** Rows returned per bucket for the screen. The count comes back regardless — see AttentionBucket. */
const PER_BUCKET_LIMIT = 50;

@Injectable()
export class DeskEscalationService {
  private readonly logger = new Logger(DeskEscalationService.name);

  constructor(
    @InjectRepository(ValidationCaseEntity)
    private readonly validationCaseRepository: Repository<ValidationCaseEntity>,
    private readonly notificationDispatch: NotificationDispatchService,
  ) {}

  private q(sql: string, params: any[] = []): Promise<any[]> {
    return this.validationCaseRepository.manager.query(sql, params);
  }

  /**
   * Split a bucket query's rows into the page and the true total.
   *
   * `COUNT(*) OVER()` is evaluated across the whole matching set before LIMIT applies, so the
   * count costs no extra round trip — the alternative was seven more queries or, as before,
   * reporting the cap as if it were the answer.
   */
  private bucket(rows: any[]): AttentionBucket {
    const total = rows.length > 0 ? Number(rows[0].totalMatching ?? rows.length) : 0;
    return {
      items: rows.map(({ totalMatching, ...item }) => item as AttentionItem),
      total,
    };
  }

  /** The head's exception buckets — everything currently in breach, oldest first. */
  async attention(perBucketLimit: number | null = PER_BUCKET_LIMIT): Promise<DeskAttention> {
    const nameExpr = `COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.username)`;
    // `null` means "every breach", which is what the notification scan needs — see scan().
    const limitSql = perBucketLimit === null ? '' : `LIMIT ${Math.max(1, Math.trunc(perBucketLimit))}`;

    const [unassignedOverdue, entryOverdue, reworkStale, reviewOverdue, submitOverdue, ocrStuck, clarificationsOverdue] =
      await Promise.all([
        // Received, nobody assigned, and the branch's case hasn't moved past the desk.
        this.q(`
          SELECT d.id, d.project_branch_id AS "projectBranchId", b.name AS "branchName",
                 EXTRACT(EPOCH FROM NOW() - d.received_at)::int / 3600 AS "ageHours",
                 NULL AS who, NULL AS "whoId", COUNT(*) OVER() AS "totalMatching"
          FROM documents d
          LEFT JOIN project_branches pb ON pb.id = d.project_branch_id
          LEFT JOIN branches b ON b.id = pb.branch_id
          WHERE d.is_active = true AND d.type = 'AUDITED_RETURN_PDF'
            AND d.assigned_to_user_id IS NULL AND d.data_entry_completed_at IS NULL
            AND d.received_at < NOW() - make_interval(hours => $1)
            AND d.status IN ('RECEIVED', 'SENT_TO_DATA_ENTRY')
            AND NOT EXISTS (SELECT 1 FROM validation_cases vc WHERE vc.project_branch_id = d.project_branch_id
                              AND vc.is_active = true AND vc.status IN ('HUMAN_REVIEW','APPROVED','SUBMITTED'))
          ORDER BY d.received_at ASC ${limitSql}`, [DESK_SLA.assignHours]),

        // Delegated and silent: no hand-back, and not the rework case (its own bucket).
        this.q(`
          SELECT d.id, d.project_branch_id AS "projectBranchId", b.name AS "branchName",
                 EXTRACT(EPOCH FROM NOW() - d.assigned_at)::int / 3600 AS "ageHours",
                 ${nameExpr} AS who, u.id AS "whoId", COUNT(*) OVER() AS "totalMatching"
          FROM documents d
          LEFT JOIN project_branches pb ON pb.id = d.project_branch_id
          LEFT JOIN branches b ON b.id = pb.branch_id
          LEFT JOIN users u ON u.id = d.assigned_to_user_id
          WHERE d.is_active = true AND d.type = 'AUDITED_RETURN_PDF'
            AND d.assigned_to_user_id IS NOT NULL AND d.data_entry_completed_at IS NULL
            AND d.assigned_at < NOW() - make_interval(hours => $1)
            AND NOT EXISTS (SELECT 1 FROM validation_cases vc WHERE vc.project_branch_id = d.project_branch_id
                              AND vc.is_active = true AND vc.status IN ('CORRECTION_REQUIRED','HUMAN_REVIEW','APPROVED','SUBMITTED'))
          ORDER BY d.assigned_at ASC ${limitSql}`, [DESK_SLA.entryHours]),

        // Bounced back for rework and not resolved. The responsible member is whoever
        // the branch's packet was last delegated to.
        this.q(`
          SELECT vc.id, vc.project_branch_id AS "projectBranchId", b.name AS "branchName",
                 EXTRACT(EPOCH FROM NOW() - vc.updated_at)::int / 3600 AS "ageHours",
                 ${nameExpr} AS who, u.id AS "whoId", COUNT(*) OVER() AS "totalMatching"
          FROM validation_cases vc
          LEFT JOIN project_branches pb ON pb.id = vc.project_branch_id
          LEFT JOIN branches b ON b.id = pb.branch_id
          LEFT JOIN LATERAL (
            SELECT assigned_to_user_id FROM documents
            WHERE project_branch_id = vc.project_branch_id AND assigned_to_user_id IS NOT NULL AND is_active = true
            ORDER BY assigned_at DESC NULLS LAST LIMIT 1
          ) owner ON true
          LEFT JOIN users u ON u.id = owner.assigned_to_user_id
          WHERE vc.is_active = true AND vc.status = 'CORRECTION_REQUIRED'
            AND vc.updated_at < NOW() - make_interval(hours => $1)
          ORDER BY vc.updated_at ASC ${limitSql}`, [DESK_SLA.reworkHours]),

        // In review with no decision; carries the routed reviewer when there is one.
        this.q(`
          SELECT vc.id, vc.project_branch_id AS "projectBranchId", b.name AS "branchName",
                 EXTRACT(EPOCH FROM NOW() - vc.updated_at)::int / 3600 AS "ageHours",
                 ${nameExpr} AS who, u.id AS "whoId", COUNT(*) OVER() AS "totalMatching"
          FROM validation_cases vc
          LEFT JOIN project_branches pb ON pb.id = vc.project_branch_id
          LEFT JOIN branches b ON b.id = pb.branch_id
          LEFT JOIN users u ON u.id = vc.reviewer_id
          WHERE vc.is_active = true AND vc.status = 'HUMAN_REVIEW'
            AND vc.updated_at < NOW() - make_interval(hours => $1)
          ORDER BY vc.updated_at ASC ${limitSql}`, [DESK_SLA.reviewHours]),

        // Approved and still not sent to the client — the breach the client feels.
        this.q(`
          SELECT vc.id, vc.project_branch_id AS "projectBranchId", b.name AS "branchName",
                 EXTRACT(EPOCH FROM NOW() - COALESCE(vc.reviewed_at, vc.updated_at))::int / 3600 AS "ageHours",
                 NULL AS who, NULL AS "whoId", COUNT(*) OVER() AS "totalMatching"
          FROM validation_cases vc
          LEFT JOIN project_branches pb ON pb.id = vc.project_branch_id
          LEFT JOIN branches b ON b.id = pb.branch_id
          WHERE vc.is_active = true AND vc.status = 'APPROVED'
            AND COALESCE(vc.reviewed_at, vc.updated_at) < NOW() - make_interval(hours => $1)
          ORDER BY COALESCE(vc.reviewed_at, vc.updated_at) ASC ${limitSql}`, [DESK_SLA.submitHours]),

        // Handed to the external OCR app and never came back to the desk.
        this.q(`
          SELECT d.id, d.project_branch_id AS "projectBranchId", b.name AS "branchName",
                 EXTRACT(EPOCH FROM NOW() - d.sent_to_external_ocr_at)::int / 3600 AS "ageHours",
                 NULL AS who, NULL AS "whoId", COUNT(*) OVER() AS "totalMatching"
          FROM documents d
          LEFT JOIN project_branches pb ON pb.id = d.project_branch_id
          LEFT JOIN branches b ON b.id = pb.branch_id
          WHERE d.is_active = true AND d.status = 'SENT_TO_EXTERNAL_OCR'
            AND d.data_entry_completed_at IS NULL
            AND d.sent_to_external_ocr_at < NOW() - make_interval(hours => $1)
          ORDER BY d.sent_to_external_ocr_at ASC ${limitSql}`, [DESK_SLA.ocrHours]),

        // A clarification past its own due date, or simply old with no resolution.
        // The audit report cannot ship while one of these is open, so a stale one is
        // a stalled report in disguise.
        this.q(`
          SELECT vq.id, vc.project_branch_id AS "projectBranchId", b.name AS "branchName",
                 EXTRACT(EPOCH FROM NOW() - vq.created_at)::int / 3600 AS "ageHours",
                 NULL AS who, NULL AS "whoId", COUNT(*) OVER() AS "totalMatching"
          FROM validation_queries vq
          LEFT JOIN validation_cases vc ON vc.id = vq.validation_case_id
          LEFT JOIN project_branches pb ON pb.id = vc.project_branch_id
          LEFT JOIN branches b ON b.id = pb.branch_id
          WHERE vq.status IN ('OPEN', 'RESPONDED')
            AND (vq.sla_due_date < NOW() OR vq.created_at < NOW() - make_interval(hours => $1))
          ORDER BY vq.created_at ASC ${limitSql}`, [DESK_SLA.clarificationHours]),
      ]);

    return {
      slaHours: DESK_SLA,
      unassignedOverdue: this.bucket(unassignedOverdue),
      entryOverdue: this.bucket(entryOverdue),
      reworkStale: this.bucket(reworkStale),
      reviewOverdue: this.bucket(reviewOverdue),
      submitOverdue: this.bucket(submitOverdue),
      ocrStuck: this.bucket(ocrStuck),
      clarificationsOverdue: this.bucket(clarificationsOverdue),
    };
  }

  /**
   * Emit escalation notifications for every current breach. Runs from the 15-minute
   * SLA scan; the day-bucketed dedupe key turns that into one reminder per item per
   * day for as long as the breach persists, and a fresh alert if it recurs later.
   */
  async scan(): Promise<number> {
    /**
     * Every breach, not the screen's first fifty.
     *
     * The scan used to walk the same capped, oldest-first list the banner shows, so on a
     * backed-up desk the oldest fifty were re-notified every fifteen minutes while the
     * fifty-first was never escalated to anyone — the escalation engine stopped escalating
     * exactly when escalation mattered. Volume is bounded by the day-bucketed dedupe key
     * below, not by truncating the work.
     */
    const a = await this.attention(null);
    const day = new Date().toISOString().slice(0, 10);
    let emitted = 0;

    const emit = (
      type: string,
      entityType: 'DOCUMENT' | 'VALIDATION' | 'VALIDATION_QUERY',
      item: AttentionItem,
      ownerUserId?: string | null,
    ) => {
      this.notificationDispatch.emitSafe({
        type,
        entityType,
        entityId: item.id,
        ownerUserId: ownerUserId ?? null,
        dedupeKey: `${type}:${item.id}:${day}`,
        payload: {
          branchName: item.branchName ?? 'a branch',
          hours: item.ageHours,
          who: item.who ?? undefined,
          projectBranchId: item.projectBranchId ?? undefined,
        },
      });
      emitted++;
    };

    for (const i of a.unassignedOverdue.items) emit('DESK_PACKET_UNASSIGNED_SLA', 'DOCUMENT', i);
    for (const i of a.entryOverdue.items) emit('DESK_ENTRY_OVERDUE', 'DOCUMENT', i, i.whoId);
    for (const i of a.reworkStale.items) emit('DESK_REWORK_STALE', 'VALIDATION', i, i.whoId);
    for (const i of a.reviewOverdue.items) emit('DESK_REVIEW_OVERDUE', 'VALIDATION', i, i.whoId);
    for (const i of a.submitOverdue.items) emit('DESK_SUBMIT_OVERDUE', 'VALIDATION', i);
    for (const i of a.ocrStuck.items) emit('DESK_OCR_STUCK', 'DOCUMENT', i);
    for (const i of a.clarificationsOverdue.items) emit('DESK_CLARIFICATION_OVERDUE', 'VALIDATION_QUERY', i);

    if (emitted > 0) this.logger.log(`Desk escalation scan: ${emitted} breach notification(s) emitted.`);
    return emitted;
  }
}
