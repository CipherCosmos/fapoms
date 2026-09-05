/**
 * FAPOMS — Destructive-Action Approval ("the two-person rule")
 *
 * A DEVELOPER requests a wipe, an ADMIN approves it (never their own request), and then the
 * REQUESTING developer executes it. Neither role can destroy alone — that is the entire point,
 * and every check in this file exists to keep one person from holding both halves:
 *
 *  - `request()` refuses a second open request from the same developer, and freezes exactly what
 *    was asked for (sorted domain keys + previewed counts) so the approval covers THAT wipe.
 *  - `decide()` requires the approver to hold the ADMIN role DIRECTLY — a fresh query against
 *    `user_roles`, never the cached principal and never `expandRoles`, because the implication
 *    map deliberately makes DEVELOPER pass every ADMIN name-gate and this is the one door that
 *    must not widen with it. Self-approval is refused by id, so an admin who also filed the
 *    request cannot be both people.
 *  - `assertExecutableAndConsume()` is a single atomic UPDATE that flips APPROVED → EXECUTED,
 *    run INSIDE the wipe's own transaction (DataResetService.execute passes its manager through
 *    the `consumeApproval` hook), so a wipe that fails rolls the consumption back with it and
 *    the approval is not burned by an attempt that deleted nothing.
 *
 * Persistence is raw SQL on the root DataSource, the same style as DataResetService — this
 * module deliberately has no `forFeature` repositories.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  DestructiveActionRequest,
  DestructiveActionRequestStatus,
  DestructiveActionType,
  DESTRUCTIVE_APPROVAL_TTL_HOURS,
  EventCategory,
  SystemRole,
} from '@fapoms/shared';

import { AuditService } from '../../core/audit/audit.service';
import { NotificationDispatchService } from '../../modules/notifications/notification-dispatch.service';
import { DataResetService } from './data-reset.service';
import { WIPE_DOMAINS } from './wipe-domains.registry';

/** Who is asking for the list — decides whether they see everyone's requests or their own. */
export interface ListActor {
  id: string;
  /** Holds the ADMIN role as a direct row in `user_roles` — computed by `isDirectAdmin()`, never by implication. */
  isAdminDirect: boolean;
  isDeveloper: boolean;
}

/** The raw row as `pg` returns it (snake_case columns, Dates for timestamptz). */
interface RequestRow {
  id: string;
  action_type: string;
  status: string;
  payload: { domainKeys: string[]; previewCounts: Record<string, number> };
  requested_by: string;
  decided_by: string | null;
  decision_reason: string | null;
  requested_at: Date;
  decided_at: Date | null;
  executed_at: Date | null;
  expires_at: Date | null;
  requested_by_name?: string | null;
  decided_by_name?: string | null;
}

const REQUEST_COLUMNS = `
  r.id, r.action_type, r.status, r.payload, r.requested_by, r.decided_by, r.decision_reason,
  r.requested_at, r.decided_at, r.executed_at, r.expires_at,
  requester.display_name AS requested_by_name, decider.display_name AS decided_by_name`;

/** LEFT joins on purpose: the accounts may have been wiped, and this trail must still read. */
const REQUEST_FROM = `
  FROM destructive_action_requests r
  LEFT JOIN users requester ON requester.id = r.requested_by
  LEFT JOIN users decider   ON decider.id   = r.decided_by`;

@Injectable()
export class DestructiveApprovalService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly dataReset: DataResetService,
    private readonly audit: AuditService,
    private readonly notificationDispatch: NotificationDispatchService,
  ) {}

  // ── Request ──────────────────────────────────────────────────────────────

  async request(actorId: string, domainKeys: string[]): Promise<DestructiveActionRequest> {
    /**
     * `preview()` is both the validation and the snapshot: it throws on an unknown or empty
     * domain selection exactly as the preview endpoint would, and its live table counts become
     * the frozen `previewCounts` the approver is shown — the numbers the approval is FOR, not
     * whatever the tables happen to hold by execution time.
     */
    const preview = await this.dataReset.preview(domainKeys);
    const sortedDomains = [...new Set(domainKeys)].sort();

    // One open request per developer. A second would let a stale approval be pointed at a fresh
    // selection, and gives the approver two things called "the wipe" to confuse.
    const open: Array<{ id: string; status: string }> = await this.dataSource.query(
      `SELECT id, status FROM destructive_action_requests
        WHERE requested_by = $1
          AND (status = $2 OR (status = $3 AND expires_at > now()))
        LIMIT 1`,
      [actorId, DestructiveActionRequestStatus.REQUESTED, DestructiveActionRequestStatus.APPROVED],
    );
    if (open.length > 0) {
      throw new ConflictException(
        `You already have an open destructive-action request (${open[0].id}, ${open[0].status}). ` +
          'Cancel it or let it run its course before filing another.',
      );
    }

    // Counts keyed by DOMAIN, as the shared contract declares — each domain's own tables summed.
    const previewCounts: Record<string, number> = {};
    for (const key of sortedDomains) {
      const tables = WIPE_DOMAINS.find((d) => d.key === key)?.tables ?? [];
      previewCounts[key] = tables.reduce((sum, t) => sum + (preview.counts[t] ?? 0), 0);
    }

    const payload = { domainKeys: sortedDomains, previewCounts };
    const inserted: RequestRow[] = await this.dataSource.query(
      `INSERT INTO destructive_action_requests
         (action_type, status, payload, requested_by, requested_at)
       VALUES ($1, $2, $3::jsonb, $4, now())
       RETURNING *`,
      [DestructiveActionType.DATA_RESET, DestructiveActionRequestStatus.REQUESTED, JSON.stringify(payload), actorId],
    );
    const row = inserted[0];

    // Bookkeeping writes: safe variants, like every non-destructive service in this codebase —
    // filing a request must not fail because the audit insert or a notification hiccuped. The
    // one deliberately UNGUARDED audit write stays where it always was: on the wipe itself,
    // inside DataResetService.execute's transaction.
    await this.audit.recordEventSafe({
      category: EventCategory.SYSTEM,
      eventType: 'DESTRUCTIVE_ACTION_REQUESTED',
      entityType: 'DESTRUCTIVE_ACTION_REQUEST',
      entityId: row.id,
      userId: actorId,
      remarks: `Requested a data wipe of: ${sortedDomains.join(', ')}.`,
      metadata: { domainKeys: sortedDomains, previewCounts },
    });

    const requesterName = await this.displayName(actorId);
    this.notificationDispatch.emitSafe({
      type: 'DESTRUCTIVE_ACTION_REQUESTED',
      entityType: 'DESTRUCTIVE_ACTION_REQUEST',
      entityId: row.id,
      actorUserId: actorId,
      payload: {
        requesterName,
        domainCount: sortedDomains.length,
        requestId: row.id,
      },
    });

    return this.toView(row, { requested_by_name: requesterName });
  }

  // ── Decide ───────────────────────────────────────────────────────────────

  async decide(
    requestId: string,
    approverId: string,
    approve: boolean,
    reason?: string,
  ): Promise<DestructiveActionRequest> {
    if (!approve && !reason?.trim()) {
      throw new BadRequestException('Rejecting a destructive-action request requires a reason.');
    }

    const row = await this.loadRow(requestId);
    if (row.status !== DestructiveActionRequestStatus.REQUESTED) {
      throw new ConflictException(
        `This request is ${row.status}, not awaiting a decision — only a REQUESTED wipe can be approved or rejected.`,
      );
    }

    /**
     * The approver must hold ADMIN as a DIRECT role row — queried fresh from the database, not
     * read off the cached principal and never expanded through ROLE_IMPLICATIONS. A DEVELOPER
     * passes the route's `@Roles(ADMIN)` name-gate by implication (that is what the implication
     * map is for), and `PermissionsGuard` already refuses them on SYSTEM:APPROVE:PLATFORM; this
     * is the belt to that brace, so no cache staleness or future guard change can quietly hand
     * one role both halves of the two-person rule.
     */
    if (!(await this.isDirectAdmin(approverId))) {
      throw new ForbiddenException(
        'Approving a destructive action needs the Admin role held directly — an implied or inherited admin cannot decide a wipe.',
      );
    }

    if (approverId === row.requested_by) {
      throw new ForbiddenException(
        'You cannot decide your own destructive-action request — the two-person rule requires a different administrator to approve it.',
      );
    }

    const nextStatus = approve ? DestructiveActionRequestStatus.APPROVED : DestructiveActionRequestStatus.REJECTED;
    // Guarded by status so a racing second decision loses cleanly instead of overwriting the first.
    const updated: RequestRow[] = await this.dataSource.query(
      `UPDATE destructive_action_requests
          SET status = $2,
              decided_by = $3,
              decided_at = now(),
              decision_reason = $4,
              -- $6 (boolean) rather than comparing $2 again: reusing $2 here makes Postgres
              -- deduce two types for it (varchar from SET, text from the comparison) and refuse
              -- the whole statement — "inconsistent types deduced for parameter $2".
              expires_at = CASE WHEN $6::boolean THEN now() + ($5::int * interval '1 hour') ELSE NULL END,
              updated_at = now()
        WHERE id = $1 AND status = 'REQUESTED'
        RETURNING *`,
      [requestId, nextStatus, approverId, reason?.trim() ?? null, DESTRUCTIVE_APPROVAL_TTL_HOURS, approve],
    );
    const rows = this.updateReturning(updated);
    if (rows.length === 0) {
      throw new ConflictException('This request was decided by someone else a moment ago.');
    }
    const decided = rows[0];

    await this.audit.recordEventSafe({
      category: EventCategory.SYSTEM,
      eventType: approve ? 'DESTRUCTIVE_ACTION_APPROVED' : 'DESTRUCTIVE_ACTION_REJECTED',
      entityType: 'DESTRUCTIVE_ACTION_REQUEST',
      entityId: requestId,
      userId: approverId,
      remarks: approve
        ? `Approved the wipe of: ${decided.payload.domainKeys.join(', ')}. Executable until ${decided.expires_at?.toISOString()}.`
        : `Rejected the wipe of: ${decided.payload.domainKeys.join(', ')}. Reason: ${reason?.trim()}.`,
      metadata: { domainKeys: decided.payload.domainKeys, approve, reason: reason?.trim() ?? null },
    });

    this.notificationDispatch.emitSafe({
      type: 'DESTRUCTIVE_ACTION_DECIDED',
      entityType: 'DESTRUCTIVE_ACTION_REQUEST',
      entityId: requestId,
      actorUserId: approverId,
      ownerUserId: decided.requested_by,
      payload: {
        decision: approve ? 'approved' : 'rejected',
        domainCount: decided.payload.domainKeys.length,
        detail: approve
          ? `You can run it from the Danger Zone until ${decided.expires_at?.toISOString() ?? 'its expiry'}.`
          : `Reason: ${reason?.trim()}.`,
      },
    });

    return this.toView(decided);
  }

  // ── Cancel ───────────────────────────────────────────────────────────────

  async cancel(requestId: string, actorId: string): Promise<DestructiveActionRequest> {
    const row = await this.loadRow(requestId);
    if (row.requested_by !== actorId) {
      throw new ForbiddenException('Only the developer who filed this request can withdraw it.');
    }
    const updated: RequestRow[] = await this.dataSource.query(
      `UPDATE destructive_action_requests
          SET status = 'CANCELLED', updated_at = now()
        WHERE id = $1 AND status = 'REQUESTED'
        RETURNING *`,
      [requestId],
    );
    const rows = this.updateReturning(updated);
    if (rows.length === 0) {
      throw new ConflictException(
        `This request is ${row.status} — only a request still awaiting a decision can be cancelled.`,
      );
    }

    await this.audit.recordEventSafe({
      category: EventCategory.SYSTEM,
      eventType: 'DESTRUCTIVE_ACTION_CANCELLED',
      entityType: 'DESTRUCTIVE_ACTION_REQUEST',
      entityId: requestId,
      userId: actorId,
      remarks: `Withdrew the data-wipe request for: ${row.payload.domainKeys.join(', ')}.`,
    });

    return this.toView(rows[0]);
  }

  // ── Execute-time consumption ─────────────────────────────────────────────

  /**
   * The gate `execute` passes through, called INSIDE the wipe's transaction via
   * `ExecuteInput.consumeApproval` so the flip to EXECUTED commits and rolls back with the
   * deletes themselves — a wipe that fails does not burn the approval, and a consumed approval
   * cannot describe a wipe that never happened.
   *
   * The consumption itself is one atomic conditional UPDATE: two racing executes both reach it,
   * exactly one sees `status = 'APPROVED'`, the other gets zero rows and a precise refusal.
   */
  async assertExecutableAndConsume(
    requestId: string,
    actorId: string,
    domainKeys: string[],
    manager?: EntityManager,
  ): Promise<void> {
    const runner = manager ?? this.dataSource;

    const found: RequestRow[] = await runner.query(
      `SELECT * FROM destructive_action_requests WHERE id = $1`,
      [requestId],
    );
    if (found.length === 0) {
      throw new NotFoundException(`No destructive-action request ${requestId} exists.`);
    }
    const row = found[0];

    if (row.requested_by !== actorId) {
      throw new ForbiddenException(
        'The developer who requested this wipe must be the one to run it — an approval is not transferable.',
      );
    }

    // The approval covers EXACTLY the frozen selection. Any drift — an extra domain, a missing
    // one — is a different wipe than the one the admin looked at, and needs its own request.
    const requested = [...new Set(domainKeys)].sort();
    const approved = [...(row.payload?.domainKeys ?? [])].sort();
    if (requested.length !== approved.length || requested.some((k, i) => k !== approved[i])) {
      throw new ConflictException(
        `This selection (${requested.join(', ') || 'nothing'}) is not what was approved (${approved.join(', ')}). ` +
          'Execute exactly the approved domains, or file a fresh request.',
      );
    }

    const consumed = this.updateReturning(
      await runner.query(
        `UPDATE destructive_action_requests
            SET status = 'EXECUTED', executed_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'APPROVED' AND expires_at > now()
          RETURNING id`,
        [requestId],
      ),
    );
    if (consumed.length === 1) return;

    // Zero rows: find out why and say so precisely.
    switch (row.status) {
      case DestructiveActionRequestStatus.APPROVED: {
        /**
         * Approved but past its expiry — flip it so the ledger says EXPIRED rather than leaving
         * an APPROVED row that can never run. Deliberately on `this.dataSource`, NOT the wipe's
         * manager: this method is about to throw, which rolls the surrounding transaction back,
         * and the expiry flip must survive that rollback — it records a fact about the approval,
         * not about the wipe.
         */
        await this.dataSource.query(
          `UPDATE destructive_action_requests
              SET status = 'EXPIRED', updated_at = now()
            WHERE id = $1 AND status = 'APPROVED' AND expires_at <= now()`,
          [requestId],
        );
        throw new ConflictException(
          `This approval expired on ${row.expires_at?.toISOString()} — approvals last ${DESTRUCTIVE_APPROVAL_TTL_HOURS} hours. File a fresh request.`,
        );
      }
      case DestructiveActionRequestStatus.REQUESTED:
        throw new ConflictException('This request has not been approved yet — an admin must approve it first.');
      case DestructiveActionRequestStatus.EXECUTED:
        throw new ConflictException('This approval was already used — each approval runs exactly one wipe.');
      case DestructiveActionRequestStatus.REJECTED:
        throw new ConflictException(`This request was rejected${row.decision_reason ? `: ${row.decision_reason}` : '.'}`);
      case DestructiveActionRequestStatus.CANCELLED:
        throw new ConflictException('This request was withdrawn by its requester.');
      case DestructiveActionRequestStatus.EXPIRED:
      default:
        throw new ConflictException('This approval has expired — file a fresh request.');
    }
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  async list(actor: ListActor): Promise<DestructiveActionRequest[]> {
    // Lazy expiry: an APPROVED row past its window reads as what it is. Idempotent by its WHERE.
    await this.dataSource.query(
      `UPDATE destructive_action_requests
          SET status = 'EXPIRED', updated_at = now()
        WHERE status = 'APPROVED' AND expires_at <= now()`,
    );

    const rows: RequestRow[] = actor.isAdminDirect
      ? // The approver's view: everything awaiting a decision, plus the recent record of what
        // was decided — enough to see the trail without paging the whole history.
        await this.dataSource.query(
          `SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM}
            WHERE r.status = 'REQUESTED' OR r.requested_at > now() - interval '90 days'
            ORDER BY (r.status = 'REQUESTED') DESC, r.requested_at DESC
            LIMIT 100`,
        )
      : await this.dataSource.query(
          `SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM}
            WHERE r.requested_by = $1
            ORDER BY r.requested_at DESC
            LIMIT 100`,
          [actor.id],
        );

    return rows.map((r) => this.toView(r));
  }

  /**
   * A DIRECT `user_roles` row naming ADMIN — the deliberate opposite of `expandRoles`, which
   * exists to make DEVELOPER pass ADMIN gates everywhere EXCEPT here.
   */
  async isDirectAdmin(userId: string): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await this.dataSource.query(
      `SELECT true AS exists
         FROM user_roles ur
         JOIN roles rl ON rl.id = ur.role_id
        WHERE ur.user_id = $1 AND rl.name = $2
        LIMIT 1`,
      [userId, SystemRole.ADMIN],
    );
    return rows.length > 0;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async loadRow(requestId: string): Promise<RequestRow> {
    const rows: RequestRow[] = await this.dataSource.query(
      `SELECT * FROM destructive_action_requests WHERE id = $1`,
      [requestId],
    );
    if (rows.length === 0) {
      throw new NotFoundException(`No destructive-action request ${requestId} exists.`);
    }
    return rows[0];
  }

  /**
   * `pg` returns `UPDATE … RETURNING` as `[rows, rowCount]` through some TypeORM paths and as
   * plain `rows` through others — normalise to the rows.
   */
  private updateReturning(result: unknown): RequestRow[] {
    if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
      return result[0] as RequestRow[];
    }
    return (result as RequestRow[]) ?? [];
  }

  private async displayName(userId: string): Promise<string | null> {
    const rows: Array<{ display_name: string }> = await this.dataSource.query(
      `SELECT display_name FROM users WHERE id = $1`,
      [userId],
    );
    return rows[0]?.display_name ?? null;
  }

  private toView(row: RequestRow, names?: { requested_by_name?: string | null }): DestructiveActionRequest {
    const iso = (d: Date | string | null | undefined): string | null =>
      d ? new Date(d).toISOString() : null;
    return {
      id: row.id,
      actionType: row.action_type as DestructiveActionType,
      status: row.status as DestructiveActionRequestStatus,
      domainKeys: row.payload?.domainKeys ?? [],
      previewCounts: row.payload?.previewCounts ?? {},
      requestedById: row.requested_by,
      requestedByName: row.requested_by_name ?? names?.requested_by_name ?? null,
      requestedAt: iso(row.requested_at) as string,
      decidedById: row.decided_by ?? null,
      decidedByName: row.decided_by_name ?? null,
      decidedAt: iso(row.decided_at),
      decisionReason: row.decision_reason ?? null,
      executedAt: iso(row.executed_at),
      expiresAt: iso(row.expires_at),
    };
  }
}
