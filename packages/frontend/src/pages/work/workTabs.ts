import { AssignmentStatus, ProjectBranchStatus } from '@fapoms/shared';

/**
 * ONE JOB, ONE DESTINATION — the WHY, so nobody re-splits these four screens.
 *
 * Getting a branch audited used to be spread across four sidebar entries: "My Work Today"
 * (/inbox), "Audit Planning" (/planning), "Visit Scheduling" (/scheduling) and "Field Work"
 * (/assignments). That split mirrored the database lifecycle, not a coordinator's job, and the
 * app itself kept proving it: the inbox sent people to /planning and /scheduling, the assignment
 * panel had "Quick Links" back to both, and TWO of the screens rendered their own little
 * "Stage 1 → Stage 2 → Stage 3" stepper because neither could be reached from the other any
 * other way.
 *
 * The cost landed on the person, not the code. Asked "why hasn't Ranchi been done yet?", a
 * coordinator had to already know which lifecycle stage Ranchi was sitting in before they could
 * pick a menu item — and if they guessed wrong, the branch simply was not on the screen, which
 * reads as "the system lost it" rather than "wrong tab".
 *
 * So the four are now ONE destination — Audit Work — with these four tabs inside it. The tabs
 * ARE the stepper; the per-screen steppers have been deleted.
 *
 * Why the tabs are still the four original URLs rather than something tidy like `/work/planning`:
 * access to each stage is declared per-path in `src/config/route-permissions.ts`, and several
 * roles may legitimately see only some of them (a document executive may see the calendar but not
 * planning; finance may see field work but not the calendar). Keeping each tab on its own real
 * URL means ProtectedRoute, `canAccessRoute()` and every bookmark, notification payload and
 * backend-generated link in existence keep working unchanged, with no permission table to
 * duplicate and get out of step. Every legacy URL therefore still resolves — it simply now lands
 * on the merged screen with its tab already selected.
 *
 * If you are tempted to give one of these its own sidebar entry again, read the paragraph about
 * Ranchi first.
 */

export type WorkTabPath = '/inbox' | '/planning' | '/scheduling' | '/assignments';

export interface WorkTab {
  path: WorkTabPath;
  /** What a coordinator would call this — no enum names, no "stage N". */
  label: string;
  /** One line of hover help, in the same voice. */
  hint: string;
}

/**
 * Tab order is the order the work actually happens in, and the first tab is the one the
 * destination opens on: today's actions, not a lifecycle stage.
 */
export const WORK_TABS: readonly WorkTab[] = [
  {
    path: '/inbox',
    label: "Today's actions",
    hint: 'Everything waiting on you right now — calls, fee replies, replacements and overdue visits.',
  },
  {
    path: '/planning',
    label: 'Planning',
    hint: 'Choose an assayer for a branch and agree the fee.',
  },
  {
    path: '/scheduling',
    label: 'Scheduling',
    hint: 'Put an agreed visit on the calendar, or move one that has to change.',
  },
  {
    path: '/assignments',
    label: 'Field work',
    hint: 'Visits that are booked, under way or finished.',
  },
] as const;

/**
 * How tall the tab strip renders, in pixels.
 *
 * Lives here rather than in AuditWork.tsx because the planning workspace is the one screen that
 * sizes itself against the viewport (`height: calc(100vh - …)`, so its map and three panels can
 * scroll independently) and therefore has to subtract the strip above it. A constant with a name
 * is cheaper than the alternative — a magic number in a page nobody would think to revisit when
 * the tab padding changes.
 */
export const WORK_TAB_STRIP_HEIGHT = 43;

const WORK_TAB_PATH_SET = new Set<string>(WORK_TABS.map((t) => t.path));

/** Whether a pathname is one of the Audit Work tabs. */
export function isWorkTabPath(pathname: string): pathname is WorkTabPath {
  return WORK_TAB_PATH_SET.has(pathname);
}

/**
 * Where a branch's current status means the work actually lives.
 *
 * This is the question a coordinator cannot answer from memory, and the whole reason the merge
 * was worth doing: given a branch, put the person on the tab that can move it forward.
 *
 * Returns null when the status is unknown to us — the caller then leaves the person on today's
 * actions rather than guessing, because a wrong jump is worse than no jump.
 */
export function tabForBranchStatus(status?: string | null): WorkTabPath | null {
  switch (status) {
    // Nobody is assigned yet, or the person who was has fallen through — the next real action is
    // finding somebody and agreeing a fee.
    case ProjectBranchStatus.IMPORTED:
    case ProjectBranchStatus.PLANNING:
    case ProjectBranchStatus.CANDIDATE_SEARCH:
    case ProjectBranchStatus.CONTACT_INITIATED:
    case ProjectBranchStatus.NEGOTIATION:
    case ProjectBranchStatus.UNABLE_TO_COVER:
    case ProjectBranchStatus.ON_HOLD:
      return '/planning';

    // Somebody has accepted, but no date is on the calendar yet.
    case ProjectBranchStatus.ASSIGNMENT_CONFIRMED:
      return '/scheduling';

    // Booked or beyond: the visit itself is the live object now.
    case ProjectBranchStatus.SCHEDULED:
    case ProjectBranchStatus.AUDIT_COMPLETED:
    case ProjectBranchStatus.VALIDATION_COMPLETED:
    case ProjectBranchStatus.CLOSED:
    case ProjectBranchStatus.CANCELLED:
      return '/assignments';

    default:
      return null;
  }
}

/** The shape this module needs off an assignment — deliberately minimal, so it stays satisfiable
 *  by both the list row and the detail response without either having to change. */
export interface WorkItemAssignment {
  status?: string | null;
  scheduledDate?: string | null;
  projectBranch?: { status?: string | null } | null;
}

/**
 * Where an assignment's current state means the work actually lives.
 *
 * The branch status is consulted first when it is present, because it is the record of the whole
 * job; the assignment's own status only describes one attempt at it. A rejected or cancelled
 * assignment on a branch that still needs covering must send the person back to choosing an
 * assayer, not to a field-work list where nothing is happening.
 */
export function tabForAssignment(assignment: WorkItemAssignment | null | undefined): WorkTabPath | null {
  if (!assignment) return null;

  const fromBranch = tabForBranchStatus(assignment.projectBranch?.status);
  if (fromBranch) return fromBranch;

  switch (assignment.status) {
    // The offer is out or being haggled over — still a planning-desk conversation.
    case AssignmentStatus.PENDING:
    case AssignmentStatus.REJECTED:
    case AssignmentStatus.CANCELLED:
      return '/planning';

    // Accepted: the only thing missing is a date, unless one is already set.
    case AssignmentStatus.ACCEPTED:
      return assignment.scheduledDate ? '/assignments' : '/scheduling';

    case AssignmentStatus.CHECKED_IN:
    case AssignmentStatus.IN_PROGRESS:
    case AssignmentStatus.COMPLETED:
      return '/assignments';

    default:
      return null;
  }
}
