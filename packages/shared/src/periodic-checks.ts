import { AssayerLifecycleStatus } from './enums';
import { BackgroundCheckVerdict, OnboardingDocument } from './assayer-roster-vocabulary';

/**
 * CHECKS DONE OVER TIME (owner, 2026-09-23).
 *
 * A background check at joining is not the end of it: a working assayer is re-checked — background
 * verification, police verification, a credit check, and their identity documents — on a schedule
 * set per check in Settings. Every check is its own dated record with its own report; nothing is
 * overwritten. Before a check falls due HR is reminded; once it is overdue past a grace period the
 * person is held from NEW work until it is done. An adverse re-check on somebody already working
 * holds them from new work until a senior decides to keep them working or suspend them.
 *
 * The rules are here, pure, so the server's gate, the reminders and every screen answer "is this
 * person due?" the same way.
 */
export enum CheckType {
  BGV = 'BGV',
  POLICE = 'POLICE',
  CREDIT = 'CREDIT',
  IDENTITY = 'IDENTITY',
}

export const CHECK_TYPES: readonly CheckType[] = [CheckType.BGV, CheckType.POLICE, CheckType.CREDIT, CheckType.IDENTITY];

export const CHECK_TYPE_LABELS: Record<CheckType, string> = {
  [CheckType.BGV]: 'Background verification',
  [CheckType.POLICE]: 'Police verification',
  [CheckType.CREDIT]: 'Credit (CIBIL) check',
  [CheckType.IDENTITY]: 'Identity documents re-check',
};

/**
 * The report a check is read from, filed as a document and claimed by the check. Identity has none
 * of its own: the identity documents themselves are what is re-verified.
 */
export const CHECK_REPORT_DOCUMENT: Record<CheckType, OnboardingDocument | null> = {
  [CheckType.BGV]: OnboardingDocument.BGV_REPORT,
  [CheckType.POLICE]: OnboardingDocument.POLICE_CERTIFICATE,
  [CheckType.CREDIT]: OnboardingDocument.CREDIT_REPORT,
  [CheckType.IDENTITY]: null,
};

/** Who issues the report — asked for, and required, where there is a report. */
export const CHECK_ISSUER_LABEL: Record<CheckType, string | null> = {
  [CheckType.BGV]: 'Background check agency',
  [CheckType.POLICE]: 'Issuing police station',
  [CheckType.CREDIT]: 'Credit bureau',
  [CheckType.IDENTITY]: null,
};

/** The check type a report document belongs to, or null. */
export function checkTypeForReport(requirement: string): CheckType | null {
  return (Object.entries(CHECK_REPORT_DOCUMENT).find(([, doc]) => doc === requirement)?.[0] as CheckType | undefined) ?? null;
}

/** Settings keys — see settings.registry.ts for the operator's wording. */
export const RECHECK_INTERVAL_SETTING: Record<CheckType, string> = {
  [CheckType.BGV]: 'recheck.bgv.intervalMonths',
  [CheckType.POLICE]: 'recheck.police.intervalMonths',
  [CheckType.CREDIT]: 'recheck.credit.intervalMonths',
  [CheckType.IDENTITY]: 'recheck.identity.intervalMonths',
};
export const RECHECK_INTERVAL_DEFAULT_MONTHS: Record<CheckType, number> = {
  [CheckType.BGV]: 24,
  [CheckType.POLICE]: 12,
  [CheckType.CREDIT]: 12,
  [CheckType.IDENTITY]: 24,
};
export const RECHECK_GRACE_DAYS_SETTING = 'recheck.graceDays';
export const RECHECK_GRACE_DAYS_DEFAULT = 30;
export const RECHECK_REMIND_DAYS_SETTING = 'recheck.remindDaysBefore';
export const RECHECK_REMIND_DAYS_DEFAULT = 30;
/**
 * When a working person who has NEVER had a check of a type falls due for their first one. Not
 * "immediately": the roster predates these checks, and making all of it due on the day this ships
 * would hold the whole field from work after one grace period. A date the operator sets instead.
 */
export const RECHECK_FIRST_ROUND_SETTING = 'recheck.firstRoundDueOn';
export const RECHECK_FIRST_ROUND_DEFAULT = '2026-12-31';

/** Who is re-checked: people working, or on a break from working. Joiners are onboarding's. */
export const RECHECK_LIFECYCLES: readonly string[] = [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.ON_LEAVE];
export const isRecheckedLifecycle = (lifecycle?: string | null): boolean =>
  !!lifecycle && RECHECK_LIFECYCLES.includes(lifecycle);

export type RecheckStatus = 'OK' | 'DUE_SOON' | 'DUE' | 'BLOCKED';

export const RECHECK_STATUS_LABELS: Record<RecheckStatus, string> = {
  OK: 'Up to date',
  DUE_SOON: 'Due soon',
  DUE: 'Due now',
  BLOCKED: 'Overdue — held from new work',
};

export interface RecheckStanding {
  type: CheckType;
  /** The latest completed check of this type, as a YYYY-MM-DD business date, or null. */
  lastCheckedOn: string | null;
  lastVerdict: BackgroundCheckVerdict | null;
  dueOn: string;
  /** The day new work stops if it has still not been done. */
  blockFrom: string;
  status: RecheckStatus;
  /** Why it is due, when that is not simply "the interval ran out". */
  because: string | null;
}

export interface RecheckPolicy {
  intervalMonths: Record<CheckType, number>;
  graceDays: number;
  remindDaysBefore: number;
  firstRoundDueOn: string;
}

export const DEFAULT_RECHECK_POLICY: RecheckPolicy = {
  intervalMonths: { ...RECHECK_INTERVAL_DEFAULT_MONTHS },
  graceDays: RECHECK_GRACE_DAYS_DEFAULT,
  remindDaysBefore: RECHECK_REMIND_DAYS_DEFAULT,
  firstRoundDueOn: RECHECK_FIRST_ROUND_DEFAULT,
};

/** Date arithmetic on YYYY-MM-DD keys, in UTC so a key never slides across a day boundary. */
const toUtc = (key: string) => new Date(`${key}T00:00:00Z`);
const pad = (n: number) => String(n).padStart(2, '0');
// Reads the UTC fields of a date built from a key above — arithmetic on a calendar date, not "today".
const fromUtc = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export function addDaysToDateKey(key: string, days: number): string {
  const d = toUtc(key);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}
export function addMonthsToDateKey(key: string, months: number): string {
  const d = toUtc(key);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  // 31 January + 1 month is the last day of February, not 3 March.
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return fromUtc(d);
}

/**
 * Where one person stands on one check type, today.
 *
 * Due = the latest completed check + the interval; never checked = the first-round date. For the
 * identity re-check, an identity document that has EXPIRED brings it due on its expiry day, if that
 * is sooner — an expired card is not a document anybody can be verified against.
 */
export function recheckStanding(input: {
  type: CheckType;
  lastCheckedOn: string | null;
  lastVerdict?: BackgroundCheckVerdict | null;
  policy: RecheckPolicy;
  today: string;
  /** Identity only: the earliest expiry date among the person's identity documents, if any. */
  earliestIdentityExpiry?: string | null;
}): RecheckStanding {
  const { type, lastCheckedOn, policy, today } = input;
  let dueOn = lastCheckedOn
    ? addMonthsToDateKey(lastCheckedOn, Math.max(1, policy.intervalMonths[type]))
    : policy.firstRoundDueOn;
  let because: string | null = lastCheckedOn ? null : 'Never checked since this began';
  const expiry = type === CheckType.IDENTITY ? input.earliestIdentityExpiry ?? null : null;
  if (expiry && (!lastCheckedOn || expiry > lastCheckedOn) && expiry < dueOn) {
    dueOn = expiry;
    because = 'An identity document expires';
  }
  const blockFrom = addDaysToDateKey(dueOn, Math.max(0, policy.graceDays));
  const status: RecheckStatus = today >= blockFrom ? 'BLOCKED'
    : today >= dueOn ? 'DUE'
      : today >= addDaysToDateKey(dueOn, -Math.max(0, policy.remindDaysBefore)) ? 'DUE_SOON'
        : 'OK';
  return { type, lastCheckedOn, lastVerdict: input.lastVerdict ?? null, dueOn, blockFrom, status, because };
}

/** A check's result in words — one wording for the server's messages and every screen. */
export const BACKGROUND_CHECK_VERDICT_LABELS: Record<BackgroundCheckVerdict, string> = {
  [BackgroundCheckVerdict.CLEAR]: 'Clear',
  [BackgroundCheckVerdict.CRIMINAL_CASE]: 'Criminal case',
  [BackgroundCheckVerdict.CIVIL_CASE]: 'Civil case',
  [BackgroundCheckVerdict.ADVERSE_FINDING]: 'Adverse finding',
  [BackgroundCheckVerdict.NOT_CHECKED]: 'Not checked',
};

/** An adverse result: anything recorded that is not clear. */
export function isAdverseVerdict(verdict?: string | null): boolean {
  return !!verdict && verdict !== BackgroundCheckVerdict.CLEAR && verdict !== BackgroundCheckVerdict.NOT_CHECKED;
}

/**
 * A working person held from new work by an adverse re-check, until a senior decides. Kept on the
 * person (`assayers.compliance_hold`), cleared only by that decision.
 */
export interface ComplianceHold {
  checkId: string;
  checkType: CheckType;
  verdict: BackgroundCheckVerdict;
  since: string;
  recordedBy: string;
}

/** The senior's decision on an adverse re-check. */
export enum CheckReviewDecision {
  KEEP = 'KEEP',
  SUSPEND = 'SUSPEND',
}

/**
 * Why this person may not be given NEW work on compliance grounds, in the words the planner and
 * the record both print — empty when nothing holds them. Work already assigned is untouched.
 */
export function complianceWorkBlockers(
  standings: Pick<RecheckStanding, 'type' | 'status' | 'dueOn'>[],
  hold: Pick<ComplianceHold, 'checkType'> | null | undefined,
): string[] {
  const out: string[] = [];
  if (hold) {
    out.push(`${CHECK_TYPE_LABELS[hold.checkType]} came back adverse — held from new work until a senior decides`);
  }
  for (const s of standings) {
    if (s.status === 'BLOCKED') out.push(`${CHECK_TYPE_LABELS[s.type]} overdue since ${s.dueOn}`);
  }
  return out;
}
