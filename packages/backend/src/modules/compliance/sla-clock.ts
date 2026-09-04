/**
 * A generic service-level deadline, computed from a start time and a window in days.
 *
 * Used for the DPDP rights-request SLA (respond within N days). Pure so the deadline arithmetic can
 * be trusted and tested on its own, mirroring the incident clocks — the difference is only that this
 * one is a configurable business SLA in days rather than a fixed statutory window in hours.
 */
const DAY_MS = 86_400_000;

export interface SlaClock {
  dueAt: string;
  daysRemaining: number | null;
  satisfied: boolean;
  overdue: boolean;
}

export function computeSlaClock(
  startedAt: Date | string,
  slaDays: number,
  satisfiedAt: Date | string | null,
  now: Date = new Date(),
): SlaClock {
  const dueMs = new Date(startedAt).getTime() + slaDays * DAY_MS;
  const satisfied = satisfiedAt != null;
  return {
    dueAt: new Date(dueMs).toISOString(),
    daysRemaining: satisfied ? null : Math.round(((dueMs - now.getTime()) / DAY_MS) * 10) / 10,
    satisfied,
    overdue: !satisfied && now.getTime() > dueMs,
  };
}
