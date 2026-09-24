/**
 * How the Today tab reads a job: which buttons it offers, which step it is on, and whether it is
 * "now" or "later".
 *
 * The one rule (from `record-capabilities.ts`): the app offers an action ONLY if the server listed
 * it. `allowed: false` is shown disabled with the server's reason; an action the server did not
 * list is not shown at all; a server too old to send `capabilities` offers nothing (never guess
 * from the status). Pure, for node tests.
 */
import { AssignmentAction, gateFor, type ActionGate } from '@fapoms/shared';
import type { AssayerAssignment } from '../../types/mobile-app';
import { calendarDaysFrom } from '../i18n/format';

/** The order buttons appear in. Primary decisions first, housekeeping last. */
export const ACTION_ORDER: readonly AssignmentAction[] = [
  AssignmentAction.ACCEPT,
  AssignmentAction.DECLINE,
  AssignmentAction.CHECK_IN,
  AssignmentAction.SUBMIT_RETURN,
  AssignmentAction.CHECK_OUT,
  AssignmentAction.CLAIM_EXPENSE,
  AssignmentAction.REPORT_ISSUE,
];

/**
 * The actions this build of the new app actually carries out. Anything else the server lists is
 * drawn disabled and marked "coming soon" — never an enabled button that only says "not ready".
 */
export const WIRED_ACTIONS: ReadonlySet<string> = new Set([
  AssignmentAction.ACCEPT,
  AssignmentAction.DECLINE,
  AssignmentAction.CHECK_IN,
  AssignmentAction.CHECK_OUT,
]);

/** Buttons drawn in the danger colour. */
const DANGER: ReadonlySet<string> = new Set([AssignmentAction.DECLINE]);
/** Buttons drawn as the quiet (secondary) style. */
const QUIET: ReadonlySet<string> = new Set([AssignmentAction.CLAIM_EXPENSE, AssignmentAction.REPORT_ISSUE, AssignmentAction.CHECK_OUT]);

export interface ActionView {
  action: string;
  allowed: boolean;
  /** Server's plain sentence for why not; undefined when allowed or when the server gave none. */
  reason?: string;
  /** Machine code for why not, to pick a translated sentence later. */
  code?: string;
  /** When it opens, if time is the only obstacle. */
  opensAt?: string;
  /** Visual weight. Exactly one `main` per job: the first allowed, wired, non-danger, non-quiet action. */
  weight: 'main' | 'quiet' | 'danger';
  /** Listed by the server but not built in this app yet: shown disabled as "coming soon". */
  comingSoon: boolean;
}

/**
 * The actions to render for one job, in a stable order. Actions the server listed that this build
 * does not know are kept (after the known ones) so a new server action is not silently hidden —
 * its label falls back to a humanised code.
 */
export function actionsFor(assignment: Pick<AssayerAssignment, 'capabilities'>): ActionView[] {
  const gates: ActionGate[] = (assignment.capabilities?.actions ?? []) as ActionGate[];
  if (gates.length === 0) return [];
  const listed = new Set(gates.map((g) => g.action));
  const known = ACTION_ORDER.filter((a) => listed.has(a));
  const unknown = gates.map((g) => g.action).filter((a) => !(ACTION_ORDER as readonly string[]).includes(a));
  const ordered = Array.from(new Set([...known, ...unknown]));

  let mainTaken = false;
  return ordered.map((action) => {
    const gate = gateFor(gates, action);
    const comingSoon = !WIRED_ACTIONS.has(action);
    let weight: ActionView['weight'] = DANGER.has(action) && !comingSoon ? 'danger' : 'quiet';
    if (!comingSoon && !DANGER.has(action) && !QUIET.has(action) && gate.allowed && !mainTaken) {
      weight = 'main';
      mainTaken = true;
    }
    return {
      action,
      allowed: gate.allowed === true,
      reason: gate.allowed ? undefined : gate.reason,
      code: gate.allowed ? undefined : gate.code,
      opensAt: gate.allowed ? undefined : gate.opensAt,
      weight,
      comingSoon,
    };
  });
}

/**
 * Where the job is on Reached → Papers → Done (index of the current step; 3 = all done).
 * Only for accepted-and-later jobs; a new offer has no step bar.
 */
export function jobStep(a: Pick<AssayerAssignment, 'status' | 'checkedInAt' | 'documentReadiness'>): number | null {
  switch (a.status) {
    case 'ACCEPTED':
      return a.checkedInAt ? 1 : 0;
    case 'CHECKED_IN':
    case 'IN_PROGRESS':
      return 1;
    case 'COMPLETED':
      return 3;
    default:
      return null;
  }
}

/** Jobs that are over for the assayer (never offered as work). */
const CLOSED = new Set(['COMPLETED', 'REJECTED', 'CANCELLED']);

export interface TodayPartition<A> {
  /** The one job to show big: in progress, else today's earliest open job. */
  now: A | null;
  /** New offers waiting for Yes/No. */
  offers: A[];
  /** Everything else still open, soonest first. */
  later: A[];
}

/**
 * Split the list for the Today tab. Soft-deleted rows (`isActive === false`) and closed jobs are
 * left out.
 */
export function partitionToday<A extends Pick<AssayerAssignment, 'id' | 'status' | 'scheduledDate' | 'isActive' | 'checkedInAt'>>(
  items: readonly A[],
  now: Date,
): TodayPartition<A> {
  const open = items.filter((a) => a.isActive !== false && !CLOSED.has(a.status));
  const dayOf = (a: A) => (a.scheduledDate ? calendarDaysFrom(a.scheduledDate, now) : null);
  const bySoonest = (x: A, y: A) => (dayOf(x) ?? 9999) - (dayOf(y) ?? 9999) || String(x.scheduledDate).localeCompare(String(y.scheduledDate));

  const offers = open.filter((a) => a.status === 'PENDING').sort(bySoonest);
  const working = open.filter((a) => a.status === 'CHECKED_IN' || a.status === 'IN_PROGRESS' || (a.status === 'ACCEPTED' && !!a.checkedInAt));
  const accepted = open.filter((a) => a.status === 'ACCEPTED' && !a.checkedInAt).sort(bySoonest);
  const todayAccepted = accepted.filter((a) => dayOf(a) === 0);

  const current = working[0] ?? todayAccepted[0] ?? null;
  // An accepted job whose day has passed stays listed (first, being soonest): it is still open on
  // the server, and hiding it would hide work the office may still be waiting for.
  const later = [...working, ...accepted].filter((a) => a !== current);
  return { now: current, offers, later };
}
