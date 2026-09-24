/**
 * Which job buttons the current app offers, decided once and tested in node (no React Native).
 *
 * The server sends its own verdict per action with each job (`capabilities`, built by the same
 * evaluators its routes enforce with — see `record-capabilities.ts` in `@fapoms/shared`). When it
 * is there, it wins. When it is not (a server older than capabilities), the app falls back to the
 * rules the server is known to apply — never to "show everything and let the tap fail".
 */
import { AssignmentAction, businessDateKey, gateFor, type ActionGate } from '@fapoms/shared';
import type { AssayerAssignment } from '../types/mobile-app';

type Job = Pick<AssayerAssignment, 'status' | 'scheduledDate' | 'capabilities' | 'checkedInAt' | 'checkedOutAt'>;

/** Today's IST calendar key (`YYYY-MM-DD`) — the day check-in is judged on. */
export function istToday(now: Date): string {
  return businessDateKey(now) ?? '';
}

function dayOf(job: Pick<Job, 'scheduledDate'>): string | null {
  return job.scheduledDate ? businessDateKey(job.scheduledDate) || null : null;
}

function gateOf(job: Job, action: AssignmentAction): ActionGate | null {
  const gates = job.capabilities?.actions;
  if (!gates || gates.length === 0) return null;
  return gateFor(gates as ActionGate[], action);
}

export type CheckInView =
  /** Offer Check-in. */
  | { kind: 'allowed' }
  /** The job is on another day: say which instead of offering a button that will be refused. */
  | { kind: 'other-day'; date: string }
  /** Refused for another reason — show it (disabled, with the reason). */
  | { kind: 'blocked'; code?: string; reason?: string };

/**
 * Check-in for an accepted job not yet arrived at. Server verdict first; without one, only on the
 * job's own IST day (the server refuses any other day with NOT_SCHEDULED_TODAY).
 */
export function checkInView(job: Job, now: Date): CheckInView {
  const gate = gateOf(job, AssignmentAction.CHECK_IN);
  if (gate) {
    if (gate.allowed) return { kind: 'allowed' };
    if (gate.code === 'NOT_SCHEDULED_TODAY' && job.scheduledDate) return { kind: 'other-day', date: job.scheduledDate };
    return { kind: 'blocked', code: gate.code, reason: gate.reason };
  }
  const day = dayOf(job);
  if (!day || day === istToday(now)) return { kind: 'allowed' };
  return { kind: 'other-day', date: job.scheduledDate };
}

export interface GateView {
  allowed: boolean;
  code?: string;
  reason?: string;
}

/** Accept on an offer: the server's ACCEPT gate when sent (on leave, not active, on hold…). */
export function acceptView(job: Job): GateView {
  const gate = gateOf(job, AssignmentAction.ACCEPT);
  if (!gate) return { allowed: true };
  return { allowed: gate.allowed, code: gate.code, reason: gate.reason };
}

/** Claims only against a visit under way or done — the server's `EXPENSE_CLAIMABLE_STATUSES`. */
export const EXPENSE_CLAIMABLE_STATUSES: readonly string[] = ['CHECKED_IN', 'IN_PROGRESS', 'COMPLETED'];

/** May an expense be filed against this job? Status first, then the server's CLAIM_EXPENSE gate. */
export function canClaimExpense(job: Job): boolean {
  if (!EXPENSE_CLAIMABLE_STATUSES.includes(job.status)) return false;
  const gate = gateOf(job, AssignmentAction.CLAIM_EXPENSE);
  return gate ? gate.allowed : true;
}

/** The jobs an expense may be filed against, newest first. */
export function expenseJobChoices<A extends Job & { id: string }>(jobs: readonly A[]): A[] {
  return jobs
    .filter(canClaimExpense)
    .sort((a, b) => String(b.scheduledDate ?? '').localeCompare(String(a.scheduledDate ?? '')));
}

/**
 * The job to preselect in the expense form: the one it was opened from if claimable, else the
 * only claimable one, else none (the assayer picks).
 */
export function preselectExpenseJob<A extends Job & { id: string }>(choices: readonly A[], openedFrom?: { id: string } | null): string | null {
  if (openedFrom && choices.some((c) => c.id === openedFrom.id)) return openedFrom.id;
  return choices.length === 1 ? choices[0].id : null;
}

const OPEN = new Set(['ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS']);

/**
 * Every open job on today (IST), in-flight first then by time — several branches a day is normal
 * (owner decision, E1), so Home lists all of them, not just the first.
 */
export function todaysOpenJobs<A extends Job & { id: string }>(jobs: readonly A[], now: Date): A[] {
  const today = istToday(now);
  const inFlight = (a: A) => (a.status === 'CHECKED_IN' || a.status === 'IN_PROGRESS' ? 0 : 1);
  return jobs
    .filter((a) => OPEN.has(a.status) && dayOf(a) === today)
    .sort((a, b) => inFlight(a) - inFlight(b) || String(a.scheduledDate).localeCompare(String(b.scheduledDate)));
}

/** Arrived and not yet left: sending the return now would close the job before check-out. */
export function shouldOfferCheckOutBeforeReturn(job: Pick<Job, 'checkedInAt' | 'checkedOutAt' | 'status'>): boolean {
  return !!job.checkedInAt && !job.checkedOutAt && (job.status === 'CHECKED_IN' || job.status === 'IN_PROGRESS');
}

/**
 * Whether to offer sending the audited return.
 *
 *  - Arrived (checked in / working): yes, as always.
 *  - ACCEPTED with no check-in whose day has passed — what a reopened job closed without an arrival
 *    comes back as (reopen redoes the papers, not the visit — owner decision E6). Nothing else can
 *    happen on it, so the return is offered, unless the server's SUBMIT_RETURN gate says no.
 *  - Anything else: no.
 */
export function canSendReturn(job: Job, now: Date): boolean {
  if (job.status === 'CHECKED_IN' || job.status === 'IN_PROGRESS') return true;
  if (job.status !== 'ACCEPTED' || job.checkedInAt) return false;
  const day = dayOf(job);
  if (!day || day >= istToday(now)) return false;
  const gate = gateOf(job, AssignmentAction.SUBMIT_RETURN);
  return gate ? gate.allowed : true;
}
