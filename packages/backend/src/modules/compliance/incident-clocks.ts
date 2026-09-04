/**
 * The two statutory clocks on a security incident, computed from when it was detected.
 *
 * Pure and side-effect-free so it can be trusted and tested directly: given an incident's detection
 * time and which milestones have been reached, it says how long is left before each legal deadline
 * and whether one has already been missed. Kept separate from the entity and service precisely so
 * the deadline arithmetic — the part that matters at 3am during a real incident — is verifiable on
 * its own.
 */

/** CERT-In Directions 2022: report a cyber incident within 6 hours of noticing it. */
export const CERT_IN_DEADLINE_HOURS = 6;
/** DPDP Rules 2025: notify affected Data Principals of a personal-data breach within 72 hours. */
export const DPDP_PRINCIPAL_DEADLINE_HOURS = 72;

const HOUR_MS = 3_600_000;

export interface IncidentClock {
  /** Whether this obligation applies to the incident at all. */
  applicable: boolean;
  /** The deadline, ISO — detection time plus the statutory window. Null when not applicable. */
  dueAt: string | null;
  /** Hours left before the deadline; negative once past it. Null when satisfied or not applicable. */
  hoursRemaining: number | null;
  /** The milestone has been reached (reported / notified). */
  satisfied: boolean;
  /** Applicable, not yet satisfied, and past the deadline — the state that needs action now. */
  overdue: boolean;
}

export interface IncidentClocks {
  certIn: IncidentClock;
  dpdpPrincipals: IncidentClock;
}

export interface IncidentClockInput {
  detectedAt: Date | string;
  personalDataInvolved: boolean;
  certInReportedAt: Date | string | null;
  principalsNotifiedAt: Date | string | null;
}

function clock(
  applicable: boolean,
  detectedAt: Date,
  deadlineHours: number,
  satisfiedAt: Date | null,
  now: Date,
): IncidentClock {
  if (!applicable) {
    return { applicable: false, dueAt: null, hoursRemaining: null, satisfied: false, overdue: false };
  }
  const dueAtMs = detectedAt.getTime() + deadlineHours * HOUR_MS;
  const satisfied = satisfiedAt !== null;
  return {
    applicable: true,
    dueAt: new Date(dueAtMs).toISOString(),
    hoursRemaining: satisfied ? null : Math.round(((dueAtMs - now.getTime()) / HOUR_MS) * 10) / 10,
    satisfied,
    overdue: !satisfied && now.getTime() > dueAtMs,
  };
}

export function computeIncidentClocks(inc: IncidentClockInput, now: Date = new Date()): IncidentClocks {
  const detectedAt = new Date(inc.detectedAt);
  const toDate = (v: Date | string | null): Date | null => (v == null ? null : new Date(v));
  return {
    // CERT-In applies to any reportable cyber incident.
    certIn: clock(true, detectedAt, CERT_IN_DEADLINE_HOURS, toDate(inc.certInReportedAt), now),
    // DPDP's principal-notification clock applies only to a personal-data breach.
    dpdpPrincipals: clock(
      inc.personalDataInvolved,
      detectedAt,
      DPDP_PRINCIPAL_DEADLINE_HOURS,
      toDate(inc.principalsNotifiedAt),
      now,
    ),
  };
}
