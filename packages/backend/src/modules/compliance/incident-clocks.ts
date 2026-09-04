/**
 * The statutory clocks on a security incident, computed from when it was detected.
 *
 * Pure and side-effect-free so it can be trusted and tested directly: given an incident's detection
 * time and which milestones have been reached, it says how long is left before each legal deadline
 * and whether one has already been missed. Kept separate from the entity and service precisely so
 * the deadline arithmetic — the part that matters at 3am during a real incident — is verifiable on
 * its own.
 *
 * DPDP Rule 7 is a two-target obligation and the two targets are easy to swap by accident (an earlier
 * version of this file did exactly that — see git history on this line): on a personal-data breach,
 * the Data Fiduciary must (a) intimate the Data Protection Board WITHOUT DELAY of the breach itself,
 * then give the Board a full incident report within a fixed 72-HOUR window, and (b) intimate each
 * affected Data Principal WITHOUT DELAY — the Act sets no fixed hour count for that second target at
 * all. The only codified 72-hour figure in the rule belongs to the Board's report, not to Data
 * Principal notification. `dpdpBoard` below is that real 72-hour clock; `dpdpPrincipals` deliberately
 * does not fabricate a deadline the law does not set.
 */

/** CERT-In Directions 2022: report a cyber incident within 6 hours of noticing it. */
export const CERT_IN_DEADLINE_HOURS = 6;
/**
 * DPDP Rules 2025, Rule 7: after an immediate "without delay" intimation, give the Data Protection
 * Board a full breach report within 72 hours of becoming aware of the breach. This is the one fixed
 * hour-count Rule 7 actually contains.
 */
export const DPDP_BOARD_REPORT_DEADLINE_HOURS = 72;

const HOUR_MS = 3_600_000;

export interface IncidentClock {
  /** Whether this obligation applies to the incident at all. */
  applicable: boolean;
  /** The deadline, ISO — detection time plus the statutory window. Null when not applicable, or when
   *  the obligation (like Data-Principal notification) carries no fixed hour count to begin with. */
  dueAt: string | null;
  /** Hours left before the deadline; negative once past it. Null when there is no fixed deadline, or
   *  once satisfied / not applicable. */
  hoursRemaining: number | null;
  /** The milestone has been reached (reported / notified). */
  satisfied: boolean;
  /** Applicable, not yet satisfied, and — for a fixed-hour clock — past the deadline. For a
   *  no-fixed-deadline obligation (`dpdpPrincipals`) this is always false: the law gives no instant to
   *  be "past", so this field cannot honestly represent lateness for it. `satisfied` is the signal to
   *  read there instead — see the field's own doc-comment on that clock's construction below. */
  overdue: boolean;
}

export interface IncidentClocks {
  /** CERT-In Directions 2022 — report within 6 hours of detection. Always applicable. */
  certIn: IncidentClock;
  /** DPDP Rule 7 — the Board's full breach report, within 72 hours of detection. Personal-data breaches only. */
  dpdpBoard: IncidentClock;
  /** DPDP Rule 7 — Data-Principal notification, "without delay". No fixed hour count — see the clock's own shape. */
  dpdpPrincipals: IncidentClock;
}

export interface IncidentClockInput {
  detectedAt: Date | string;
  personalDataInvolved: boolean;
  certInReportedAt: Date | string | null;
  boardNotifiedAt: Date | string | null;
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

/**
 * A "without delay" obligation — DPDP's Data-Principal notification — has no fixed hour count in the
 * rule, so there is no instant to count down to and none to call "overdue" against. Rather than invent
 * a number and present it as statutory (the bug this replaces), this reports only what the law and the
 * record actually support: whether the duty applies, and whether it has been met. `overdue` stays
 * false unconditionally — not because a pending notification is fine to sit on, but because "overdue"
 * would itself be a fabricated claim about a deadline that does not exist in this shape. Read
 * `satisfied: false` on an `applicable` incident as "notify now, without delay", not as "plenty of
 * time" — this deliberately does not read as calm.
 */
function noDelayClock(applicable: boolean, satisfiedAt: Date | null): IncidentClock {
  if (!applicable) {
    return { applicable: false, dueAt: null, hoursRemaining: null, satisfied: false, overdue: false };
  }
  return { applicable: true, dueAt: null, hoursRemaining: null, satisfied: satisfiedAt !== null, overdue: false };
}

export function computeIncidentClocks(inc: IncidentClockInput, now: Date = new Date()): IncidentClocks {
  const detectedAt = new Date(inc.detectedAt);
  const toDate = (v: Date | string | null): Date | null => (v == null ? null : new Date(v));
  return {
    // CERT-In applies to any reportable cyber incident.
    certIn: clock(true, detectedAt, CERT_IN_DEADLINE_HOURS, toDate(inc.certInReportedAt), now),
    // DPDP's Board-report clock — the actual 72-hour figure — applies only to a personal-data breach.
    dpdpBoard: clock(
      inc.personalDataInvolved,
      detectedAt,
      DPDP_BOARD_REPORT_DEADLINE_HOURS,
      toDate(inc.boardNotifiedAt),
      now,
    ),
    // DPDP's Data-Principal clock — "without delay", no fixed hour count. Also personal-data breaches only.
    dpdpPrincipals: noDelayClock(inc.personalDataInvolved, toDate(inc.principalsNotifiedAt)),
  };
}
