/**
 * How long each class of compliance record is kept — with statutory FLOORS that a misconfiguration
 * cannot drop below.
 *
 * Different laws set different minimums, and a bank vendor is bound by the strictest that applies:
 *   - CERT-In Directions 2022: ICT-system logs for a rolling 180 days, stored in India.
 *   - DPDP Rules 2025: access/processing logs for at least 1 year.
 *   - Banking audit evidence (RBI / contract): typically multiple years.
 *
 * So retention here is per-CLASS and configurable, but the configured value is clamped UP to the
 * class's floor: an administrator can keep records LONGER than the law requires, never shorter. The
 * two escape hatches match the rest of the settings surface: an unset value falls back to the
 * class default (which for evidence-grade classes is "keep indefinitely"), and an explicit 0 means
 * "keep indefinitely" on purpose — the same convention `locationTrail.retentionDays` already uses,
 * so an organisation whose policy really is "never delete" can say so.
 */
export type RetentionClass = 'SESSION_HISTORY' | 'AUDIT_TRAIL' | 'ACCESS_LOG' | 'UI_TELEMETRY';

export interface RetentionPolicy {
  /** Statutory minimum in days; a positive configured value below this is raised to it. Null = no floor. */
  floorDays: number | null;
  /** Applied when nothing is configured. Null = keep indefinitely. */
  defaultDays: number | null;
  rationale: string;
}

export const RETENTION_POLICIES: Record<RetentionClass, RetentionPolicy> = {
  // Login/session history — an ICT-system access record. CERT-In's 180-day floor applies; kept by
  // default (a bank vendor is asked "show me this person's sessions over the last year"), purged
  // only once an administrator sets a window, and never below 180 days.
  SESSION_HISTORY: {
    floorDays: 180,
    defaultDays: null,
    rationale: 'CERT-In 2022: ICT access logs, 180-day floor; session history kept by default.',
  },
  // The business audit trail. DPDP's 1-year floor applies; kept indefinitely by default because it
  // is the bank audit evidence the whole product exists to produce, and because purging a
  // hash-chained event needs archival first (see the retention worker).
  AUDIT_TRAIL: {
    floorDays: 365,
    defaultDays: null,
    rationale: 'DPDP 2025: access/processing logs, 1-year floor; audit evidence kept by default.',
  },
  // Personal-data access logs (who viewed what). Same 1-year DPDP floor; kept by default.
  ACCESS_LOG: {
    floorDays: 365,
    defaultDays: null,
    rationale: 'DPDP 2025: personal-data access logs, 1-year floor.',
  },
  // Fine-grained UI interaction telemetry (Phase 4). High volume and low evidentiary value, so it
  // gets a short default in the spirit of DPDP data-minimisation, with a modest floor.
  UI_TELEMETRY: {
    floorDays: 90,
    defaultDays: 180,
    rationale: 'DPDP data-minimisation: UI telemetry kept briefly, 90-day floor.',
  },
};

export interface RetentionResolution {
  /** Effective retention in days, or null for "keep indefinitely". */
  days: number | null;
  /** True when the configured value was below the floor and was raised to it. */
  clampedToFloor: boolean;
}

/**
 * Resolve the effective retention for a class from a configured value.
 *
 * - `null`/`undefined`/blank → the class default.
 * - `0` → keep indefinitely (explicit, per the location-trail convention).
 * - a positive number below the floor → the floor (and `clampedToFloor` is set so the caller can warn).
 * - anything else → as configured.
 * - a negative or non-finite value is treated as "unset" rather than trusted.
 */
export function resolveRetention(
  cls: RetentionClass,
  configured: number | null | undefined,
): RetentionResolution {
  const policy = RETENTION_POLICIES[cls];
  if (configured === null || configured === undefined) return { days: policy.defaultDays, clampedToFloor: false };
  const n = Number(configured);
  if (!Number.isFinite(n) || n < 0) return { days: policy.defaultDays, clampedToFloor: false };
  if (n === 0) return { days: 0, clampedToFloor: false }; // explicit "keep indefinitely"
  if (policy.floorDays !== null && n < policy.floorDays) {
    return { days: policy.floorDays, clampedToFloor: true };
  }
  return { days: n, clampedToFloor: false };
}
