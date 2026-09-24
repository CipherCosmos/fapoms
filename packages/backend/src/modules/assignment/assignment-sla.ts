import { businessDateKey } from '@fapoms/shared';

/**
 * The two clocks an assignment's `slaDueDate` can hold, written once.
 *
 * `slaDueDate` is one column read by two sweeps (`checkSlaBreaches`, `autoDeclineExpiredOffers`),
 * and what it means depends on where the assignment stands:
 *
 *  - While it is a PENDING offer it is the **response** deadline — answer by then or the offer is
 *    withdrawn. Set when an offer is made to somebody: at creation, and again whenever the work is
 *    moved to a new person (reassignment), because the new person has not had any time to answer.
 *  - Once it is ACCEPTED it is the **attendance** deadline — the end of the scheduled day in IST.
 *    Set on acceptance and again whenever the date moves (`scheduleAudit`).
 *
 * These used to be computed inline in each place, and acceptance did not re-arm the clock at all:
 * an accepted job kept its 24-hour response deadline and was flagged BREACHED a day later however
 * far out its visit was, while a reassigned offer inherited its predecessor's already-expired
 * deadline and was auto-declined at the next sweep, before the new assayer could open it.
 */

/** Shipped default when a client's configuration names no response window. */
export const DEFAULT_MAX_RESPONSE_TIME_HOURS = 24;

/**
 * The response deadline for an offer made at `from`: the client's `maxResponseTimeHours`
 * (default 24) later. Same arithmetic `create()` has always used.
 */
export function offerResponseDeadline(
  clientConfiguration: { maxResponseTimeHours?: unknown } | null | undefined,
  from: Date = new Date(),
): Date {
  let hours = DEFAULT_MAX_RESPONSE_TIME_HOURS;
  if (clientConfiguration?.maxResponseTimeHours) {
    hours = Number(clientConfiguration.maxResponseTimeHours);
  }
  const due = new Date(from.getTime());
  due.setHours(due.getHours() + hours);
  return due;
}

/**
 * The attendance deadline for an accepted job: 23:59:59 IST on its scheduled business day.
 * `null` when there is no scheduled date — the caller keeps whatever clock it already had.
 */
export function attendanceDeadline(scheduledDate: Date | string | null | undefined): Date | null {
  if (!scheduledDate) return null;
  const day = businessDateKey(scheduledDate);
  if (!day) return null;
  return new Date(`${day}T23:59:59+05:30`);
}
