/**
 * WHAT AN ASSAYER MAY DO TO ONE OF THEIR ASSIGNMENTS — one evaluator per action, and nothing else.
 *
 * Each function here is the decision a route makes before it acts, lifted out so the same function
 * can also be asked in advance by `GET /assignments/assayer/:id`, which sends the answers to the
 * field app as `capabilities` (contract: `record-capabilities.ts` in `@fapoms/shared`). The routes
 * call these very functions and refuse when one says no, so what the phone offers and what the
 * server enforces cannot drift apart:
 *
 *   ACCEPT        evaluateAcceptOffer        AssignmentService.executeAssignmentTransition (ACCEPTED)
 *   DECLINE       evaluateDeclineOffer       AssignmentService.executeAssignmentTransition (REJECTED)
 *   CHECK_IN      evaluateCheckInNotClosed,  AssignmentService.recordCheckIn
 *                 evaluateCheckInState,
 *                 evaluateFieldWorkStanding,
 *                 evaluateCheckInDay,
 *                 evaluateCheckInPosition (route only — needs the fix sent with the request)
 *   CHECK_OUT     evaluateCheckOutNotClosed, AssignmentService.recordCheckOut
 *                 evaluateCheckOut
 *   SUBMIT_RETURN evaluateSubmitReturn       DocumentController.replayOrRefuseOnFinishedJob
 *   CLAIM_EXPENSE evaluateExpenseClaim       ExpenseService.create
 *   REPORT_ISSUE  evaluateReportIssue        AssignmentService.reportIssue
 *   (every one)   evaluateOwnership          the assayer-side ownership checks on those routes
 *
 * Pure: no database, no clock except what is passed in. The caller loads the facts — batched, for a
 * list — and these only decide.
 *
 * Messages: every refusal a route already sent keeps its exact wording (`audience: 'desk'`, the
 * default, is what the routes pass). The capability list is read by the assayer on their phone, so
 * where the route's sentence was written for the desk ("Record it on their Background tab") the
 * evaluator also has an assayer-voiced sentence (`audience: 'assayer'`). The CODE is the same in
 * both — the code is the contract, the sentence is the fallback.
 */
import {
  ActionGate,
  AssayerPayableStatus,
  AssayerStatus,
  AssignmentAction,
  AssignmentCapabilities,
  AssignmentStatus,
  ASSIGNMENT_ERROR_CODES,
  ATTENDANCE_ERROR_CODES,
  OTHER_CONFLICT_ERROR_CODES,
  businessDateKey,
  canTransitionAssignment,
  checkInAllowanceMeters,
  isAssignmentTerminal,
  isLivePayable,
  metersFromBranch,
  usableBranchPoint,
  type CheckInZone,
} from '@fapoms/shared';

export type Gate = ActionGate<AssignmentAction>;
export type Audience = 'desk' | 'assayer';

/** The facts about one assignment every evaluator reads. A subset of `AssignmentEntity`. */
export interface CapabilityAssignment {
  id: string;
  assignmentNumber?: string | null;
  status: AssignmentStatus;
  assayerId?: string | null;
  checkedInAt?: Date | string | null;
  checkedOutAt?: Date | string | null;
  /** The assignment's own date, falling back to its project branch's — as check-in reads it. */
  scheduledDate?: Date | string | null;
  branch?: { latitude?: unknown; longitude?: unknown; geoAccuracyMeters?: unknown } | null;
}

/** The facts about the assayer who holds it. */
export interface CapabilityAssayer {
  id: string;
  assayerCode?: string | null;
  displayName?: string | null;
  status?: AssayerStatus | string | null;
  isActive?: boolean | null;
  lifecycleStatus?: string | null;
}

/** The job's live fee payable, as the expense rule reads it. */
export interface CapabilityFeePayable {
  status: AssayerPayableStatus | string;
  assayerInvoiceId?: string | null;
}

const allow = (action: AssignmentAction): Gate => ({ action, allowed: true });
const refuse = (action: AssignmentAction, code: string, reason: string, opensAt?: string): Gate =>
  (opensAt ? { action, allowed: false, code, reason, opensAt } : { action, allowed: false, code, reason });

const lower = (status: string) => String(status).replace(/_/g, ' ').toLowerCase();

// ── Ownership ─────────────────────────────────────────────────────────────────────────────────

/**
 * Is this assignment the caller's own? Every assayer-side route asks it first; the routes keep
 * their own sentence ("You can only accept an assignment that is assigned to you.") and throw 403.
 */
export function evaluateOwnership(
  action: AssignmentAction,
  assignment: Pick<CapabilityAssignment, 'assayerId'> | null | undefined,
  callerAssayerId: string | null | undefined,
): Gate {
  if (!assignment || !callerAssayerId || assignment.assayerId !== callerAssayerId) {
    return refuse(action, ATTENDANCE_ERROR_CODES.NOT_YOUR_ASSIGNMENT, 'This assignment is not assigned to you.');
  }
  return allow(action);
}

// ── Accept / decline ──────────────────────────────────────────────────────────────────────────

/**
 * Accepting an offer. Order is the route's: the assayer's standing, then the compliance hold, then
 * the transition table — so the route's first refusal is unchanged.
 *
 * The standing rule reads exactly as the route always has: only an assayer that was found AND has a
 * status is judged (a missing row is not refused here — the route never did).
 */
export function evaluateAcceptOffer(
  assignment: Pick<CapabilityAssignment, 'status'>,
  assayer: CapabilityAssayer | null | undefined,
  complianceBlockers: string[],
  audience: Audience = 'desk',
): Gate {
  const A = AssignmentAction.ACCEPT;
  if (assayer && assayer.status != null && (assayer.status !== AssayerStatus.ACTIVE || assayer.isActive === false)) {
    return refuse(A, ATTENDANCE_ERROR_CODES.ASSAYER_NOT_ACTIVE, audience === 'assayer'
      ? `Your account is ${lower(String(assayer.status))}, so you cannot accept new work. Contact HR.`
      : `Assayer ${assayer.assayerCode || assayer.id} is '${assayer.status}' and cannot accept assignments.`);
  }
  if (complianceBlockers.length > 0) {
    return refuse(A, ASSIGNMENT_ERROR_CODES.ASSAYER_COMPLIANCE_BLOCKED, audience === 'assayer'
      ? `You cannot take on new work until this is sorted out: ${complianceBlockers.join('; ')}. Contact HR.`
      : `${assayer?.displayName ?? 'This assayer'} cannot be given new work: ${complianceBlockers.join('; ')}. Record it on their Background tab.`);
  }
  if (!canTransitionAssignment(assignment.status, AssignmentStatus.ACCEPTED)) {
    return refuse(A, ASSIGNMENT_ERROR_CODES.INVALID_ASSIGNMENT_TRANSITION, audience === 'assayer'
      ? `This offer can no longer be accepted — it is ${lower(assignment.status)}.`
      : `Invalid transition path from '${assignment.status}' to '${AssignmentStatus.ACCEPTED}'`);
  }
  return allow(A);
}

/** Declining an offer: the transition table alone. The reason the route demands is input, not a gate. */
export function evaluateDeclineOffer(
  assignment: Pick<CapabilityAssignment, 'status'>,
  audience: Audience = 'desk',
): Gate {
  const D = AssignmentAction.DECLINE;
  if (!canTransitionAssignment(assignment.status, AssignmentStatus.REJECTED)) {
    return refuse(D, ASSIGNMENT_ERROR_CODES.INVALID_ASSIGNMENT_TRANSITION, audience === 'assayer'
      ? `This offer can no longer be declined — it is ${lower(assignment.status)}.`
      : `Invalid transition path from '${assignment.status}' to '${AssignmentStatus.REJECTED}'`);
  }
  return allow(D);
}

// ── Check-in ──────────────────────────────────────────────────────────────────────────────────

/** Check-in on a job that is over. Asked first, on the locked row, before anything else answers. */
export function evaluateCheckInNotClosed(status: AssignmentStatus | string): Gate {
  const C = AssignmentAction.CHECK_IN;
  if (status === AssignmentStatus.CANCELLED) {
    return refuse(C, OTHER_CONFLICT_ERROR_CODES.ASSIGNMENT_CANCELLED, 'Cannot check in: assignment has been cancelled.');
  }
  if (status === AssignmentStatus.COMPLETED) {
    return refuse(C, ATTENDANCE_ERROR_CODES.ASSIGNMENT_COMPLETED, 'Cannot check in: assignment is already completed.');
  }
  return allow(C);
}

/** The job's own state: not over, and a status the transition table lets move to CHECKED_IN. */
export function evaluateCheckInState(status: AssignmentStatus): Gate {
  const closed = evaluateCheckInNotClosed(status);
  if (!closed.allowed) return closed;
  if (!canTransitionAssignment(status, AssignmentStatus.CHECKED_IN)) {
    return refuse(AssignmentAction.CHECK_IN, ATTENDANCE_ERROR_CODES.INVALID_STATE_FOR_CHECK_IN,
      `You need to accept this assignment before checking in. It is currently ${lower(status)}.`);
  }
  return allow(AssignmentAction.CHECK_IN);
}

/**
 * Suspended or inactive assayers cannot start field work. Unlike accepting, a MISSING assayer row
 * refuses here — check-in has always read it that way (it locks the row it judges).
 */
export function evaluateFieldWorkStanding(assayer: CapabilityAssayer | null | undefined): Gate {
  if (!assayer || assayer.status !== AssayerStatus.ACTIVE || assayer.isActive === false) {
    const statusLabel = assayer ? (assayer.lifecycleStatus || assayer.status) : 'UNKNOWN';
    return refuse(AssignmentAction.CHECK_IN, ATTENDANCE_ERROR_CODES.ASSAYER_NOT_ACTIVE,
      `Check-in refused: Assayer is currently ${statusLabel}. Suspended or inactive assayers cannot start new field work.`);
  }
  return allow(AssignmentAction.CHECK_IN);
}

/** Midnight at the start of an IST calendar day (`YYYY-MM-DD`), as an ISO instant. */
export function istDayStartIso(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00+05:30`).toISOString();
}

/**
 * Check-in happens on the scheduled day (IST). `dayRuleSuspended` is an administrator's rule-bypass
 * window for `CHECK_IN_SCHEDULED_DAY`; the route asks for it only when the days differ, as before.
 *
 * `opensAt` is set when the only thing in the way is that the day has not come yet.
 * `mismatch` tells the route a bypass was used, so it can record that it was.
 */
export function evaluateCheckInDay(
  scheduled: Date | string | null | undefined,
  now: Date,
  dayRuleSuspended: boolean,
): Gate & { mismatch?: { today: string; scheduled: string } } {
  const C = AssignmentAction.CHECK_IN;
  if (!scheduled) return allow(C);
  const today = businessDateKey(now);
  const scheduledKey = businessDateKey(scheduled);
  if (today === scheduledKey) return allow(C);
  if (dayRuleSuspended) return { ...allow(C), mismatch: { today, scheduled: scheduledKey } };

  const early = today < scheduledKey;
  const spoken = new Date(scheduled).toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata',
  });
  return refuse(
    C,
    ATTENDANCE_ERROR_CODES.NOT_SCHEDULED_TODAY,
    early
      ? `This audit is scheduled for ${spoken}. Check-in opens on the day itself — if the visit has genuinely moved, ask operations to reschedule it first.`
      : `This audit was scheduled for ${spoken} and that day has passed. Ask operations to reschedule it before checking in.`,
    early && scheduledKey ? istDayStartIso(scheduledKey) : undefined,
  );
}

/**
 * The zone around the branch, for the phone. `null` when the branch has no usable pin — the
 * server does not enforce a geofence it cannot measure, so the phone should not either.
 */
export function checkInZoneFor(
  branch: CapabilityAssignment['branch'],
  geofenceMeters: number,
  arrivalRadiusMeters?: number | null,
): CheckInZone | null {
  const point = usableBranchPoint(branch?.latitude, branch?.longitude);
  if (!point) return null;
  const zone: CheckInZone = { latitude: point.latitude, longitude: point.longitude, radiusMeters: geofenceMeters };
  // The smaller "arrived" circle never reaches past the zone that actually gates check-in.
  if (arrivalRadiusMeters != null && Number.isFinite(arrivalRadiusMeters) && arrivalRadiusMeters > 0) {
    zone.arrivalRadiusMeters = Math.min(arrivalRadiusMeters, geofenceMeters);
  }
  return zone;
}

/**
 * The geofence, asked of the fix the check-in request carries. Route-only: the capability list is
 * computed without a fix. `distanceMeters` is null when the branch has no usable pin, and then the
 * check passes — as it always has.
 */
export function evaluateCheckInPosition(input: {
  fix: { latitude: number; longitude: number };
  deviceAccuracyMeters?: number | null;
  branch: CapabilityAssignment['branch'];
  geofenceMeters: number;
}): Gate & { distanceMeters: number | null } {
  const C = AssignmentAction.CHECK_IN;
  const point = usableBranchPoint(input.branch?.latitude, input.branch?.longitude);
  if (!point) return { ...allow(C), distanceMeters: null };
  const distanceMeters = metersFromBranch(input.fix, point);
  const branchAccuracyMeters = Math.max(0, Number(input.branch?.geoAccuracyMeters ?? 0) || 0);
  const allowance = checkInAllowanceMeters({
    geofenceMeters: input.geofenceMeters,
    deviceAccuracyMeters: input.deviceAccuracyMeters,
    branchAccuracyMeters,
  });
  if (distanceMeters <= allowance) return { ...allow(C), distanceMeters };
  const km = (distanceMeters / 1000).toFixed(1);
  const branchGeoIsVague = branchAccuracyMeters >= 1000;
  return {
    ...refuse(C, ATTENDANCE_ERROR_CODES.TOO_FAR_FROM_BRANCH, branchGeoIsVague
      ? `You appear to be ${km} km from this branch, but this branch's recorded location is only accurate to about ${Math.round(branchAccuracyMeters / 1000)} km — it was never pinned precisely. Ask operations to correct the branch's location; this is not something you can fix from here.`
      : `You appear to be ${km} km from this branch. Check-in works only at the branch itself — if you are standing there, get clear sky for a GPS fix and try again.`),
    distanceMeters,
  };
}

// ── Check-out ─────────────────────────────────────────────────────────────────────────────────

/** Check-out on a job that is over. Asked first, on the locked row. */
export function evaluateCheckOutNotClosed(status: AssignmentStatus | string): Gate {
  const O = AssignmentAction.CHECK_OUT;
  if (status === AssignmentStatus.CANCELLED) {
    return refuse(O, OTHER_CONFLICT_ERROR_CODES.ASSIGNMENT_CANCELLED, 'Cannot check out of a cancelled assignment.');
  }
  if (status === AssignmentStatus.COMPLETED) {
    return refuse(O, ATTENDANCE_ERROR_CODES.ASSIGNMENT_COMPLETED, 'Assignment is already completed.');
  }
  return allow(O);
}

/**
 * Check-out: the job is not over, and there is an arrival to leave from. (The route answers an
 * already-recorded departure as the success it was, between these two halves — see there.)
 */
export function evaluateCheckOut(assignment: Pick<CapabilityAssignment, 'status' | 'checkedInAt'>): Gate {
  const O = AssignmentAction.CHECK_OUT;
  const closed = evaluateCheckOutNotClosed(assignment.status);
  if (!closed.allowed) return closed;
  if (!assignment.checkedInAt) {
    return refuse(O, ATTENDANCE_ERROR_CODES.NOT_CHECKED_IN,
      'You have not checked in to this branch yet, so there is nothing to check out of.');
  }
  return allow(O);
}

// ── Audited return ────────────────────────────────────────────────────────────────────────────

/**
 * A finished job (`isAssignmentTerminal`) takes no more field paperwork. The route answers a
 * byte-identical retry as the success it was before asking this — see `replayOrRefuseOnFinishedJob`.
 */
export function evaluateSubmitReturn(
  assignment: Pick<CapabilityAssignment, 'id' | 'assignmentNumber' | 'status'>,
): Gate {
  const S = AssignmentAction.SUBMIT_RETURN;
  if (isAssignmentTerminal(assignment.status)) {
    return refuse(S, OTHER_CONFLICT_ERROR_CODES.ASSIGNMENT_CLOSED,
      `Assignment ${assignment.assignmentNumber ?? assignment.id} is already ${String(assignment.status).toLowerCase()}, `
      + 'so no more paperwork can be added to it. If its return needs replacing, ask operations to reopen it.');
  }
  return allow(S);
}

// ── Expense claims ────────────────────────────────────────────────────────────────────────────

/**
 * Claiming against work that was never carried out has no basis. Offered and rejected assignments
 * have involved no travel yet; cancelled ones no longer will.
 */
export const EXPENSE_CLAIMABLE_STATUSES: readonly AssignmentStatus[] = [
  AssignmentStatus.CHECKED_IN,
  AssignmentStatus.IN_PROGRESS,
  AssignmentStatus.COMPLETED,
];

/**
 * Fee-payable states after which the job's pay is settled and takes no new claims even when no
 * bill carries it (direct approval) — the "Ready to pay" (APPROVED) and "Paid" (PAID) stages.
 */
export const PAY_SETTLED_STATUSES: readonly AssayerPayableStatus[] = [
  AssayerPayableStatus.APPROVED,
  AssayerPayableStatus.PAID,
];

/**
 * A new expense claim: the visit is under way, and the job's LIVE fee payable is neither on a bill
 * (any bill state) nor already approved or paid. Owner decision 2026-09-24: claims are made before
 * billing. See `ExpenseService.create` for the reasoning behind each half.
 */
export function evaluateExpenseClaim(
  assignment: Pick<CapabilityAssignment, 'status'>,
  feePayable: CapabilityFeePayable | null | undefined,
): Gate {
  const E = AssignmentAction.CLAIM_EXPENSE;
  if (!EXPENSE_CLAIMABLE_STATUSES.includes(assignment.status)) {
    return refuse(E, OTHER_CONFLICT_ERROR_CODES.EXPENSE_VISIT_NOT_STARTED,
      `Expenses can only be claimed once the visit is under way — this assignment is ${assignment.status}.`);
  }
  if (feePayable && isLivePayable(feePayable.status)) {
    if (feePayable.assayerInvoiceId) {
      return refuse(E, OTHER_CONFLICT_ERROR_CODES.EXPENSE_JOB_ALREADY_BILLED,
        'This job is already on a bill. Claims must be made before billing.');
    }
    if (PAY_SETTLED_STATUSES.includes(feePayable.status as AssayerPayableStatus)) {
      return refuse(E, OTHER_CONFLICT_ERROR_CODES.EXPENSE_PAYOUT_ALREADY_APPROVED,
        `The pay for this job has already been ${feePayable.status === AssayerPayableStatus.PAID ? 'paid' : 'approved'}. `
        + 'Claims must be made before billing.');
    }
  }
  return allow(E);
}

// ── Reporting a problem ───────────────────────────────────────────────────────────────────────

/** Flagging a problem to the desk: any of their assignments except a completed one. */
export function evaluateReportIssue(assignment: Pick<CapabilityAssignment, 'status'>): Gate {
  if (assignment.status === AssignmentStatus.COMPLETED) {
    return refuse(AssignmentAction.REPORT_ISSUE, ATTENDANCE_ERROR_CODES.ASSIGNMENT_COMPLETED,
      'This assignment is already completed.');
  }
  return allow(AssignmentAction.REPORT_ISSUE);
}

// ── The list the field app receives ───────────────────────────────────────────────────────────

/**
 * Which actions belong on a job at this stage — WHETHER to show a button, not whether it works
 * (that is the evaluator's answer, shown as enabled or disabled-with-reason). A done step is not
 * offered again (no Check in after arriving, no Check out after leaving), an action whose answer on
 * that stage can only ever be "no" is not listed, and nothing is offered on work the assayer
 * declined or that was taken back:
 *
 *   PENDING                       ACCEPT, DECLINE, REPORT_ISSUE
 *   ACCEPTED/CHECKED_IN/IN_PROGR. CHECK_IN (until arrived), CHECK_OUT (once arrived, until left),
 *                                 SUBMIT_RETURN, CLAIM_EXPENSE, REPORT_ISSUE
 *   COMPLETED                     CLAIM_EXPENSE (open only while the job's pay is not yet on a
 *                                 bill, approved or paid — the evaluator says which)
 *   REJECTED / CANCELLED          nothing
 *
 * The routes are more permissive than this list in places (an issue may be reported on a declined
 * offer; a return uploaded to an accepted job that was never checked into) and stay so: this is
 * which buttons the app draws, not a new rule.
 */
export function relevantActions(assignment: Pick<CapabilityAssignment, 'status' | 'checkedInAt' | 'checkedOutAt'>): AssignmentAction[] {
  const s = assignment.status;
  if (s === AssignmentStatus.PENDING) {
    return [AssignmentAction.ACCEPT, AssignmentAction.DECLINE, AssignmentAction.REPORT_ISSUE];
  }
  if (s === AssignmentStatus.ACCEPTED || s === AssignmentStatus.CHECKED_IN || s === AssignmentStatus.IN_PROGRESS) {
    const out: AssignmentAction[] = [];
    if (!assignment.checkedInAt) out.push(AssignmentAction.CHECK_IN);
    else if (!assignment.checkedOutAt) out.push(AssignmentAction.CHECK_OUT);
    out.push(AssignmentAction.SUBMIT_RETURN, AssignmentAction.CLAIM_EXPENSE, AssignmentAction.REPORT_ISSUE);
    return out;
  }
  if (s === AssignmentStatus.COMPLETED) {
    return [AssignmentAction.CLAIM_EXPENSE];
  }
  return [];
}

/** Everything `buildAssignmentCapabilities` needs besides the assignment, loaded once per list. */
export interface CapabilityContext {
  callerAssayerId: string;
  assayer: CapabilityAssayer | null;
  /** Compliance blockers for the assayer. Only read for a PENDING offer. */
  complianceBlockers: string[];
  now: Date;
  /** Is the scheduled-day rule currently suspended by an administrator's rule-bypass window? */
  dayRuleSuspended: boolean;
  geofenceMeters: number;
  /** The smaller "arrived" circle (`field.arrivalRadiusMeters`), sent beside the zone. */
  arrivalRadiusMeters?: number | null;
  /** The job's live fee payable, from one batched read. */
  feePayable?: CapabilityFeePayable | null;
}

/**
 * The `capabilities` block for one assignment, from the caller's (the assayer's) side.
 *
 * CHECK_IN is judged here without a GPS fix: state, standing, and the day. Where the only obstacle
 * is that the day has not come, `opensAt` says when it will. The zone rides alongside so the phone
 * can measure itself; the route still measures the fix the check-in sends.
 */
export function buildAssignmentCapabilities(
  assignment: CapabilityAssignment,
  ctx: CapabilityContext,
): AssignmentCapabilities {
  const actions = relevantActions(assignment);
  const gates: Gate[] = actions.map((action) => {
    const owned = evaluateOwnership(action, assignment, ctx.callerAssayerId);
    if (!owned.allowed) return owned;
    switch (action) {
      case AssignmentAction.ACCEPT:
        return evaluateAcceptOffer(assignment, ctx.assayer, ctx.complianceBlockers, 'assayer');
      case AssignmentAction.DECLINE:
        return evaluateDeclineOffer(assignment, 'assayer');
      case AssignmentAction.CHECK_IN: {
        for (const gate of [
          evaluateCheckInState(assignment.status),
          evaluateFieldWorkStanding(ctx.assayer),
          evaluateCheckInDay(assignment.scheduledDate, ctx.now, ctx.dayRuleSuspended),
        ]) {
          if (!gate.allowed) return stripInternal(gate);
        }
        return allow(action);
      }
      case AssignmentAction.CHECK_OUT:
        return evaluateCheckOut(assignment);
      case AssignmentAction.SUBMIT_RETURN:
        return evaluateSubmitReturn(assignment);
      case AssignmentAction.CLAIM_EXPENSE:
        return evaluateExpenseClaim(assignment, ctx.feePayable);
      case AssignmentAction.REPORT_ISSUE:
        return evaluateReportIssue(assignment);
      default:
        return refuse(action, 'BAD_REQUEST', 'Not available.');
    }
  });
  const offersCheckIn = actions.includes(AssignmentAction.CHECK_IN);
  return {
    actions: gates,
    checkInZone: offersCheckIn ? checkInZoneFor(assignment.branch, ctx.geofenceMeters, ctx.arrivalRadiusMeters) : null,
  };
}

/** Drop evaluator-internal fields (`mismatch`) so only the contract's keys reach the wire. */
function stripInternal(gate: Gate & { mismatch?: unknown }): Gate {
  const { action, allowed, code, reason, opensAt } = gate;
  const out: Gate = { action, allowed };
  if (code) out.code = code;
  if (reason) out.reason = reason;
  if (opensAt) out.opensAt = opensAt;
  return out;
}
