import { ConflictException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { AssignmentStatus, EventCategory, businessDateKey } from '@fapoms/shared';
import { ScheduleEntity } from '../scheduling/schedule.entity';
import { AuditService } from '../../core/audit/audit.service';

/**
 * Cancelling the open work under a branch that is being closed or a project that is being
 * stopped — the one implementation `BranchService.remove` and `ProjectService.cancelProject` share.
 *
 * Both used to (a) read the assignments with no lock, (b) refuse if any was on site, then (c) run
 * an unconditional `UPDATE … SET status = 'CANCELLED' WHERE id = $1` per row, outside any
 * transaction (the project path's comment said "transactionally" over a `dataSource.query` that
 * was not in the command's transaction at all). An assayer checking in between (b) and (c) had
 * their CHECKED_IN visit silently cancelled — the exact outcome the 409 in (b) exists to prevent —
 * and the cancelled jobs kept their CONFIRMED calendar entries and left location sharing on.
 *
 * Here, on the caller's transaction:
 *  1. every open assignment in scope is read `FOR UPDATE`, so no check-in can land until commit;
 *  2. the on-site refusal is decided on those locked rows;
 *  3. the cancel is conditional on the status still being PENDING/ACCEPTED, and a row that did not
 *     take it (it cannot, under the lock — this is the belt to that brace) refuses the closure;
 *  4. their schedules are retired the way a single cancel retires one (`retireSchedule`);
 *  5. the audit rows are written on the same transaction.
 *
 * Notifications, refresh pushes, realtime events and switching location sharing off are NOT done
 * here: they are side effects of a committed closure, so the callers run them after commit, from
 * the rows this returns.
 */

export interface ClosureCancelledAssignment {
  id: string;
  assignmentNumber: string;
  previousStatus: AssignmentStatus;
  assayerId: string | null;
  branchName: string | null;
  /** The version the cancellation committed — the notification's occurrence discriminator. */
  entityVersion: number;
  /** The job's day, so the assayer's travel for that day can be re-decided after commit. */
  scheduledDate: string | Date | null;
  /** Who raised the job — the desk notice's owner. */
  createdBy?: string | null;
}

const CANCELLABLE: AssignmentStatus[] = [AssignmentStatus.PENDING, AssignmentStatus.ACCEPTED];
const ON_SITE: AssignmentStatus[] = [AssignmentStatus.CHECKED_IN, AssignmentStatus.IN_PROGRESS];

export async function cancelOpenAssignmentsForClosure(
  manager: EntityManager,
  opts: {
    scope: { branchId: string } | { projectId: string };
    userId: string;
    cancelReason: string;
    auditRemarks: string;
    /**
     * The refusal when somebody is on site — the caller's existing 409 wording. The second
     * argument is EVERY on-site job (owner decision 2026-09-24: the refusal lists them all, so
     * the office knows what to complete or cancel first).
     */
    onSiteRefusal: (
      row: { assignmentNumber: string; status: string },
      all: Array<{ assignmentNumber: string; status: string }>,
    ) => Error;
    /** Written on `manager` — the closure's own transaction. */
    auditService: Pick<AuditService, 'recordEvent'>;
  },
): Promise<ClosureCancelledAssignment[]> {
  const byBranch = 'branchId' in opts.scope;
  const scopeId = byBranch ? (opts.scope as { branchId: string }).branchId : (opts.scope as { projectId: string }).projectId;

  // Ordered by id so two closures over overlapping rows take their locks in the same order.
  const rows: Array<{
    id: string;
    assignment_number: string;
    status: string;
    assayer_id: string | null;
    branch_name: string | null;
    scheduled_date?: string | Date | null;
    created_by?: string | null;
  }> = await manager.query(
    `SELECT a.id, a.assignment_number, a.status, a.assayer_id, a.scheduled_date, a.created_by, b.name AS branch_name
       FROM assignments a
       INNER JOIN project_branches pb ON a.project_branch_id = pb.id
       LEFT JOIN branches b ON b.id = pb.branch_id
      WHERE ${byBranch ? 'pb.branch_id' : 'pb.project_id'} = $1 AND a.is_active = true
      ORDER BY a.id
      FOR UPDATE OF a`,
    [scopeId],
  );

  const onSite = rows
    .filter((r) => ON_SITE.includes(r.status as AssignmentStatus))
    .map((r) => ({ assignmentNumber: r.assignment_number, status: r.status }));
  if (onSite.length > 0) throw opts.onSiteRefusal(onSite[0], onSite);

  const cancellable = rows.filter((r) => CANCELLABLE.includes(r.status as AssignmentStatus));
  if (cancellable.length === 0) return [];

  const ids = cancellable.map((r) => r.id);
  const updated: Array<{ id: string; entity_version: number }> = await manager.query(
    `UPDATE assignments
        SET status = 'CANCELLED',
            cancel_reason = $2,
            updated_by = $1,
            entity_version = COALESCE(entity_version, 1) + 1,
            updated_at = NOW()
      WHERE id = ANY($3::uuid[])
        AND status IN ('PENDING', 'ACCEPTED')
      RETURNING id, entity_version`,
    [opts.userId, opts.cancelReason, ids],
  ).then((r: any) => (Array.isArray(r?.[0]) ? r[0] : r) ?? []);

  const versionById = new Map(updated.map((u) => [u.id, Number(u.entity_version)]));
  const missed = cancellable.find((r) => !versionById.has(r.id));
  if (missed) {
    // Under the row lock this cannot happen; if it ever does, refusing (and rolling back every
    // cancel above with it) is the answer — never a closure that half-happened.
    throw new ConflictException(
      `Assignment ${missed.assignment_number} changed while the closure was running — nothing was cancelled. Try again.`,
    );
  }

  // Same retirement a single cancel performs (`AssignmentService.retireSchedule`): the visit is
  // not happening, so it leaves the calendar.
  await manager.getRepository(ScheduleEntity).update(
    { assignmentId: In(ids), isActive: true },
    { isActive: false, updatedBy: opts.userId },
  );

  for (const r of cancellable) {
    await opts.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSIGNMENT_CANCELLED',
      entityType: 'ASSIGNMENT',
      entityId: r.id,
      previousState: r.status,
      newState: AssignmentStatus.CANCELLED,
      userId: opts.userId,
      remarks: opts.auditRemarks,
      metadata: { entityVersion: versionById.get(r.id) },
    }, { manager });
  }

  return cancellable.map((r) => ({
    id: r.id,
    assignmentNumber: r.assignment_number,
    previousStatus: r.status as AssignmentStatus,
    assayerId: r.assayer_id,
    branchName: r.branch_name,
    entityVersion: versionById.get(r.id)!,
    scheduledDate: r.scheduled_date ?? null,
    createdBy: r.created_by ?? null,
  }));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// CANCEL FOR A REASON — the pieces every bulk cancel shares (branch closure, project stop, an
// assayer's departure or deletion) and the notices a single cancel sends too.
//
// Before 2026-09-24 the departure and deletion cascades cancelled CHECKED_IN / IN_PROGRESS work in
// raw SQL and then told nobody: no status-changed event, no desk notice, no refresh push, location
// sharing left on, and the day's travel never re-decided. The branch and project closures each
// carried their own copy of the after-commit announcements. Now:
//
//  - `lockOnSiteAssignments` + `onSiteRefusalMessage` — the on-site rule (owner decision): a
//    departure or closure is REFUSED while anybody is checked in or in progress; the office first
//    completes or cancels those jobs (a single cancel by the office, with a reason, stays allowed).
//  - `announceCancelledAssignments` — everything that happens once a bulk cancel has COMMITTED.
//  - `cancellationNotices` — the assayer's and the desk's notice for one cancelled job; the single
//    cancel (`AssignmentService.executeAssignmentTransition`) sends exactly these too.
// ───────────────────────────────────────────────────────────────────────────────────────────────

export const ON_SITE_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = ON_SITE;
export const CANCELLABLE_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = CANCELLABLE;

export interface OnSiteAssignment {
  id: string;
  assignmentNumber: string;
  status: string;
  branchName: string | null;
}

/**
 * The on-site jobs of one assayer, read `FOR UPDATE` on the caller's transaction so no check-in
 * (or check-out) can land between this answer and the cascade that relies on it.
 */
export async function lockOnSiteAssignments(
  manager: Pick<EntityManager, 'query'>,
  scope: { assayerId: string },
): Promise<OnSiteAssignment[]> {
  const raw = await manager.query(
    `SELECT a.id, a.assignment_number, a.status, b.name AS branch_name
       FROM assignments a
       LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
       LEFT JOIN branches b ON b.id = pb.branch_id
      WHERE a.assayer_id = $1 AND a.is_active = true AND a.status = ANY($2)
      ORDER BY a.id
      FOR UPDATE OF a`,
    [scope.assayerId, [...ON_SITE]],
  );
  const rows: any[] = Array.isArray(raw) ? (Array.isArray(raw[0]) ? raw[0] : raw) : [];
  return rows
    .filter((r) => r && r.id)
    .map((r) => ({
      id: r.id,
      assignmentNumber: r.assignment_number,
      status: r.status,
      branchName: r.branch_name ?? null,
    }));
}

/** The sentence a refused departure/closure shows: what is on site, and what to do about it. */
export function onSiteRefusalMessage(
  what: string,
  onSite: Array<{ assignmentNumber: string; status: string; branchName?: string | null }>,
): string {
  const list = onSite
    .map((j) => `${j.assignmentNumber}${j.branchName ? ` (${j.branchName})` : ''} is currently ${j.status}`)
    .join('; ');
  return `${what} while ${onSite.length === 1 ? 'a job is' : `${onSite.length} jobs are`} on site: ${list}. `
    + 'Complete or cancel (with a reason) each of these first, then try again.';
}

/** One committed cancellation, as the announcer needs it. */
export interface CancelledForAnnouncement {
  id: string;
  assignmentNumber: string;
  previousStatus: AssignmentStatus | string;
  assayerId: string | null;
  branchName: string | null;
  entityVersion: number;
  scheduledDate: string | Date | null;
  /** Who raised the job — the desk notice's owner. */
  createdBy?: string | null;
  assayerName?: string | null;
}

export interface CancellationNoticeContext {
  userId: string;
  /** The desk's reason line ("Priya Nair resigned", "branch closed by operations"). */
  reason: string;
  /**
   * The assayer's notice. `closure` → ASSIGNMENT_CANCELLED_BY_CLOSURE ("…because ${because}");
   * `direct` → ASSIGNMENT_CANCELLED (a single cancel); `none` → the assayer is not told (they are
   * the one who left, or their record was deleted) — the desk still is.
   */
  assayerNotice: 'closure' | 'direct' | 'none';
  because?: string;
  /** Per-occurrence dedupe key; defaults to `${type}:${id}:${entityVersion}`. */
  dedupeKey?: (type: string, row: CancelledForAnnouncement) => string;
}

function dayLabel(d: string | Date | null | undefined): string {
  if (!d) return 'the scheduled date';
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? 'the scheduled date' : businessDateKey(d);
  return String(d).slice(0, 10);
}

/** The notification emits for one cancelled job: the assayer's (unless `none`) and the desk's. */
export function cancellationNotices(
  row: CancelledForAnnouncement,
  ctx: CancellationNoticeContext,
): Array<{
  type: string;
  entityType: 'ASSIGNMENT';
  entityId: string;
  actorUserId: string;
  assayerId?: string | null;
  ownerUserId?: string | null;
  dedupeKey: string;
  payload: Record<string, unknown>;
}> {
  const key = ctx.dedupeKey ?? ((type: string, r: CancelledForAnnouncement) => `${type}:${r.id}:${r.entityVersion}`);
  const branchName = row.branchName ?? row.assignmentNumber;
  const out: ReturnType<typeof cancellationNotices> = [];
  if (row.assayerId && ctx.assayerNotice !== 'none') {
    const type = ctx.assayerNotice === 'closure' ? 'ASSIGNMENT_CANCELLED_BY_CLOSURE' : 'ASSIGNMENT_CANCELLED';
    out.push({
      type,
      entityType: 'ASSIGNMENT',
      entityId: row.id,
      actorUserId: ctx.userId,
      assayerId: row.assayerId,
      ownerUserId: row.createdBy ?? null,
      dedupeKey: key(type, row),
      payload: ctx.assayerNotice === 'closure'
        ? { assignmentId: row.id, assignmentNumber: row.assignmentNumber, branchName, because: ctx.because ?? ctx.reason }
        : {
          assignmentId: row.id,
          assignmentNumber: row.assignmentNumber,
          branchName,
          assayerName: row.assayerName || 'The assayer',
          reason: ctx.reason,
          scheduledDate: dayLabel(row.scheduledDate),
        },
    });
  }
  out.push({
    type: 'ASSIGNMENT_CANCELLED_DESK',
    entityType: 'ASSIGNMENT',
    entityId: row.id,
    actorUserId: ctx.userId,
    assayerId: row.assayerId,
    ownerUserId: row.createdBy ?? null,
    dedupeKey: key('ASSIGNMENT_CANCELLED_DESK', row),
    payload: {
      assignmentId: row.id,
      assignmentNumber: row.assignmentNumber,
      branchName,
      assayerName: row.assayerName || 'The assayer',
      reason: ctx.reason,
      scheduledDate: dayLabel(row.scheduledDate),
    },
  });
  return out;
}

export interface CancellationAnnouncerDeps {
  notificationDispatch?: { emitSafe: (opts: any) => void } | null;
  eventPublisher?: { publish: (eventType: string, payload: any) => void } | null;
  refreshPush?: { assignmentChanged: (assayerId: string | null | undefined, assignmentId?: string | null) => void } | null;
  /** Location sharing stops with an assayer's last committed job. */
  disableLiveTrackingWhenWorkEnds?: ((assayerId: string, userId: string) => Promise<void>) | null;
  /** Travel once per assayer per day: a cancelled job may have carried its day's journey. */
  dayTravel?: {
    rebalanceMany: (pairs: Array<{ assayerId: string | null | undefined; day: Date | string | null | undefined }>, userId: string, reason: string) => Promise<unknown>;
  } | null;
}

/**
 * Everything a committed bulk cancel owes the world: the notices, the realtime status change (with
 * `assayerId`, so the assayer's own screens route it), the phone refresh, location sharing off, and
 * the day's travel re-decided. Call it AFTER commit — never about a cancel that rolled back. Never
 * throws: each effect is best-effort, the cancellation itself has already happened.
 */
export async function announceCancelledAssignments(
  rows: CancelledForAnnouncement[],
  deps: CancellationAnnouncerDeps,
  ctx: CancellationNoticeContext & { travelReason: string },
): Promise<void> {
  for (const row of rows) {
    for (const notice of cancellationNotices(row, ctx)) {
      try { deps.notificationDispatch?.emitSafe(notice); } catch { /* best-effort */ }
    }
    if (row.assayerId) {
      try { deps.refreshPush?.assignmentChanged(row.assayerId, row.id); } catch { /* best-effort */ }
    }
    try {
      deps.eventPublisher?.publish('assignment:status-changed', {
        eventType: 'assignment:status-changed',
        assignmentId: row.id,
        assignmentNumber: row.assignmentNumber,
        previousState: row.previousStatus,
        newState: AssignmentStatus.CANCELLED,
        assayerId: row.assayerId,
        userId: ctx.userId,
      });
    } catch { /* best-effort */ }
  }
  for (const assayerId of new Set(rows.map((r) => r.assayerId).filter((x): x is string => !!x))) {
    try { await deps.disableLiveTrackingWhenWorkEnds?.(assayerId, ctx.userId); } catch { /* best-effort */ }
  }
  if (rows.length > 0) {
    try {
      await deps.dayTravel?.rebalanceMany(
        rows.map((r) => ({ assayerId: r.assayerId, day: r.scheduledDate })),
        ctx.userId,
        ctx.travelReason,
      );
    } catch { /* best-effort */ }
  }
}
