import { AssignmentStatus } from '@fapoms/shared';

/**
 * What counts as an assayer's workload — stated once, for everything that asks.
 *
 * Five call sites used to answer this question with four different status sets, so one assayer
 * had four different workloads depending on who asked: the coverage planner's anti-corruption
 * layer said 9, the HR dashboard and Command Centre said 2, the capacity rule said 1, and the
 * workload scorer said 0. The ACL's figure was outright wrong — it counted every row with
 * `isActive = true` and no status filter at all, and since terminal states deliberately keep
 * `isActive` set (see the note in assignment.state-machine.ts), finished, rejected and
 * cancelled work all counted as current load. Assayers were being excluded from plans for work
 * they had already delivered.
 *
 * Two sets, because there are genuinely two questions:
 */

/**
 * Work the assayer has actually taken on and owes. This is the set to use for capacity — for
 * deciding whether someone has room for another branch.
 *
 * PENDING is excluded deliberately: an offer that has not been accepted is not yet a
 * commitment, and treating it as one lets an unanswered offer block the assayer from being
 * offered anything else.
 */
export const COMMITTED_ASSIGNMENT_STATUSES: AssignmentStatus[] = [
  AssignmentStatus.ACCEPTED,
  AssignmentStatus.CHECKED_IN,
  AssignmentStatus.IN_PROGRESS,
];

/**
 * Everything in flight, including offers awaiting an answer. This is the set to use for
 * reporting — for showing a manager what is currently on an assayer's plate — because an
 * outstanding offer is real work in the pipeline even though it is not yet owed.
 *
 * Never use this for capacity decisions; use COMMITTED_ASSIGNMENT_STATUSES.
 */
export const IN_FLIGHT_ASSIGNMENT_STATUSES: AssignmentStatus[] = [
  AssignmentStatus.PENDING,
  ...COMMITTED_ASSIGNMENT_STATUSES,
];

/**
 * The statuses that make an assayer's day exclusive — the application half of a rule whose
 * other half is a database constraint.
 *
 * `idx_assignments_single_active_assayer_day` is a partial unique index on
 * `(assayer_id, scheduled_date)` covering PENDING, ACCEPTED, CHECKED_IN and IN_PROGRESS. The
 * application was checking the same rule against `COMMITTED_ASSIGNMENT_STATUSES`, which omits
 * PENDING — so the two layers disagreed about exactly one status, and on exactly that status
 * the disagreement was visible to users: the service happily allowed a second PENDING offer for
 * the same assayer on the same day, the index refused the insert, and the request came back as a
 * raw unique-violation instead of the policy's own message. The rule was real, it was simply
 * being stated by the wrong layer.
 *
 * Widened rather than narrowing the index: an unanswered offer does occupy the day, because
 * accepting it is a one-click action and nothing re-checks the day in between. The index is the
 * authority; this constant exists so the application can refuse first, with a message that says
 * which assignment is in the way. Change one and you must change the other — the integration
 * test in `assignment-double-booking.spec.ts` fails if they drift.
 *
 * Distinct from `COMMITTED_ASSIGNMENT_STATUSES` on purpose: capacity across a week and
 * exclusivity within a day are different questions, and PENDING answers them differently.
 */
export const DAY_EXCLUSIVE_ASSIGNMENT_STATUSES: AssignmentStatus[] = [
  AssignmentStatus.PENDING,
  AssignmentStatus.ACCEPTED,
  AssignmentStatus.CHECKED_IN,
  AssignmentStatus.IN_PROGRESS,
];

/**
 * Reached the end of its life. Expressed by status alone — `isActive` means "not deleted",
 * never "finished".
 */
export const TERMINAL_ASSIGNMENT_STATUSES: AssignmentStatus[] = [
  AssignmentStatus.COMPLETED,
  AssignmentStatus.REJECTED,
  AssignmentStatus.CANCELLED,
];

export function isTerminalAssignmentStatus(status: AssignmentStatus): boolean {
  return TERMINAL_ASSIGNMENT_STATUSES.includes(status);
}

/**
 * The same sets as a SQL literal, for the raw-query readers. Keeping these derived from the
 * arrays above means a status can never be added to one form and forgotten in the other.
 *
 * Example: `AND asg.status IN (${sqlStatusList(COMMITTED_ASSIGNMENT_STATUSES)})`
 */
export function sqlStatusList(statuses: AssignmentStatus[]): string {
  return statuses.map((s) => `'${s}'`).join(',');
}

/**
 * Weekly capacity assumed for an assayer whose own `maxWeeklyWorkload` is unset.
 *
 * This literal was written out in six places — five as 15 and one as 50 — so the same assayer's
 * spare capacity differed depending on which engine asked. Stated once, so a change to the
 * platform default cannot land in five files and miss the sixth.
 */
export const DEFAULT_WEEKLY_CAPACITY = 15;
