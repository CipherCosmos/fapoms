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
