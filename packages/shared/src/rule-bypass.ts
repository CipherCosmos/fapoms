/**
 * FAPOMS — the operational rules an administrator may deliberately suspend.
 *
 * ## What this is for
 *
 * Testing a workflow end to end normally means satisfying every rule that guards it: an
 * assayer cannot check in unless they are physically within 2 km of the branch on the exact
 * scheduled day, cannot be recommended without the certifications a project requires, cannot be
 * assigned onto a public holiday, and so on. Each of those is correct in production and each of
 * them, in a test, means someone has to travel to a branch or hand-fabricate reference data
 * before the next screen can be reached at all.
 *
 * So this is a first-class, permanent capability rather than a temporary hack: an administrator
 * suspends named rules, for a stated reason, for a bounded time.
 *
 * ## What it is NOT
 *
 * It is not a way to get work done faster. Every rule listed here exists because the audit
 * product is only worth what its controls are worth — the geofence is the attendance evidence,
 * the certification check is what lets a client accept the auditor, and the distance floor is a
 * conflict-of-interest control. Suspending one does not make the resulting record valid; it
 * makes it a test record, and the platform marks it as one permanently.
 *
 * That is the whole design: bypass is allowed, but never quiet. It is administrator-only, it
 * expires on its own, it names a reason, it announces itself on every screen while it is on,
 * and every single rule it skips is written to the audit trail against the record it affected.
 */

/**
 * The rules that can be suspended, grouped by the workflow they block.
 *
 * Deliberately fine-grained. "Turn off all the rules" is the request people make and the thing
 * they should almost never do — testing check-in from a desk needs the geofence suspended, not
 * the certification checks, and a blanket switch would quietly disable controls nobody meant to
 * touch.
 */
export enum BypassableRule {
  /** 2 km geofence around the branch on assayer check-in. */
  CHECK_IN_GEOFENCE = 'CHECK_IN_GEOFENCE',
  /** Check-in must happen on the calendar day the audit is scheduled for. */
  CHECK_IN_SCHEDULED_DAY = 'CHECK_IN_SCHEDULED_DAY',
  /** The assayer must hold the skills and unexpired certifications the project requires. */
  SKILLS_AND_CERTIFICATIONS = 'SKILLS_AND_CERTIFICATIONS',
  /** The client's minimum-distance conflict-of-interest floor, and its maximum service radius. */
  DISTANCE_POLICY = 'DISTANCE_POLICY',
  /** Audits may not be scheduled on a registered public holiday or non-working day. */
  HOLIDAY_CALENDAR = 'HOLIDAY_CALENDAR',
  /** One assayer, one audit per day. */
  DOUBLE_BOOKING = 'DOUBLE_BOOKING',
  /** An assayer on recorded leave is not available. */
  ASSAYER_LEAVE = 'ASSAYER_LEAVE',
  /** The audit date must fall inside the project's start and end dates. */
  PROJECT_TIMELINE = 'PROJECT_TIMELINE',
  /** The same assayer may not audit the same branch twice running. */
  REPEAT_AUDITOR_ROTATION = 'REPEAT_AUDITOR_ROTATION',
  /** Client-specific allow/deny lists for who may work their engagements. */
  CLIENT_ELIGIBILITY = 'CLIENT_ELIGIBILITY',
  /** Configurable business rules with a BLOCK action, from the rules engine. */
  BUSINESS_RULE_ENGINE = 'BUSINESS_RULE_ENGINE',
  /** An assayer must have finished onboarding before they can be assigned work. */
  ASSAYER_ONBOARDING = 'ASSAYER_ONBOARDING',
}

export interface BypassableRuleInfo {
  rule: BypassableRule;
  label: string;
  /** What stops working in the product while this rule is on — i.e. why you'd suspend it. */
  blocks: string;
  /** What the rule is actually protecting. Shown next to the switch, deliberately. */
  protects: string;
  /**
   * Rules whose suspension changes what a *completed audit record means*, rather than merely
   * what the planner will let you schedule. These get a stronger confirmation and are called
   * out separately in the banner.
   */
  evidential: boolean;
}

export const BYPASSABLE_RULES: BypassableRuleInfo[] = [
  {
    rule: BypassableRule.CHECK_IN_GEOFENCE,
    label: 'Branch geofence on check-in',
    blocks: 'Checking in from anywhere other than within 2 km of the branch.',
    protects: 'The check-in IS the attendance evidence. Suspended, a record can claim a visit that did not happen.',
    evidential: true,
  },
  {
    rule: BypassableRule.CHECK_IN_SCHEDULED_DAY,
    label: 'Check-in only on the scheduled day',
    blocks: 'Checking in before or after the day the audit is booked for.',
    protects: 'That the audit happened when the client was told it would.',
    evidential: true,
  },
  {
    rule: BypassableRule.SKILLS_AND_CERTIFICATIONS,
    label: 'Required skills and certifications',
    blocks: 'Assigning or recommending an assayer who lacks a required or unexpired certification.',
    protects: 'That the auditor was qualified to perform the audit the client accepted.',
    evidential: true,
  },
  {
    rule: BypassableRule.DISTANCE_POLICY,
    label: "Client distance policy",
    blocks: 'Assigning an assayer who lives too close to (or too far from) the branch.',
    protects: 'Independence — the minimum distance is a conflict-of-interest control.',
    evidential: true,
  },
  {
    rule: BypassableRule.REPEAT_AUDITOR_ROTATION,
    label: 'No repeat auditor',
    blocks: 'Sending the same assayer back to a branch they audited most recently.',
    protects: 'Independence through rotation.',
    evidential: true,
  },
  {
    rule: BypassableRule.HOLIDAY_CALENDAR,
    label: 'Holiday and working-day calendar',
    blocks: 'Scheduling onto a public holiday or a non-working day.',
    protects: 'That someone is actually at the branch to receive the auditor.',
    evidential: false,
  },
  {
    rule: BypassableRule.DOUBLE_BOOKING,
    label: 'Double-booking guard',
    blocks: 'Giving one assayer two audits on the same day.',
    protects: 'A plan that can physically be delivered.',
    evidential: false,
  },
  {
    rule: BypassableRule.ASSAYER_LEAVE,
    label: 'Recorded leave',
    blocks: 'Assigning an assayer on a date they are on leave.',
    protects: 'A plan that can physically be delivered.',
    evidential: false,
  },
  {
    rule: BypassableRule.PROJECT_TIMELINE,
    label: 'Project start and end dates',
    blocks: 'Scheduling an audit outside the engagement window.',
    protects: 'The contracted delivery window.',
    evidential: false,
  },
  {
    rule: BypassableRule.CLIENT_ELIGIBILITY,
    label: 'Client allow/deny lists',
    blocks: 'Assigning an assayer the client has not approved, or has barred.',
    protects: 'Contractual commitments about who works the account.',
    evidential: true,
  },
  {
    rule: BypassableRule.BUSINESS_RULE_ENGINE,
    label: 'Configured business rules',
    blocks: 'Anything the configurable rules engine blocks, including capacity ceilings.',
    protects: 'Whatever each configured rule was written to protect.',
    evidential: false,
  },
  {
    rule: BypassableRule.ASSAYER_ONBOARDING,
    label: 'Onboarding completion',
    blocks: 'Assigning someone who has not cleared document checks, background verification and training.',
    protects: 'That the person sent to a client site has been vetted.',
    evidential: true,
  },
];

export const BYPASSABLE_RULE_INFO: Record<BypassableRule, BypassableRuleInfo> = BYPASSABLE_RULES.reduce(
  (acc, info) => {
    acc[info.rule] = info;
    return acc;
  },
  {} as Record<BypassableRule, BypassableRuleInfo>,
);

/**
 * The longest a bypass may run before it turns itself off, in hours.
 *
 * A bounded window is the single most important safety property here. The realistic failure is
 * not somebody enabling this maliciously — it is somebody enabling it on a Friday to test one
 * screen and nobody noticing it is still on three weeks later, by which time a month of audit
 * records have been produced with the controls off and no one can say which.
 */
export const MAX_BYPASS_HOURS = 24;
export const DEFAULT_BYPASS_HOURS = 2;

export interface RuleBypassState {
  active: boolean;
  rules: BypassableRule[];
  reason: string | null;
  enabledBy: string | null;
  enabledByName: string | null;
  enabledAt: string | null;
  expiresAt: string | null;
  /**
   * How many times each suspended rule has actually been skipped in this window.
   *
   * "Suspended" and "already used to wave something through" are different facts, and the second
   * is the one an administrator needs. A window that has been open an hour and skipped nothing is
   * a forgotten switch; one that has accepted a check-in 900 km from the branch is a record that
   * needs looking at. This was tracked from the first version but never returned by the state
   * endpoint, so the screen offering to turn the bypass off could not show what it had already
   * done — the only way to find out was to read the audit log or the database.
   *
   * Keyed by rule; absent keys mean that rule has not been reached yet.
   */
  usageCounts: Partial<Record<BypassableRule, number>>;
}

export const INACTIVE_BYPASS: RuleBypassState = {
  active: false,
  rules: [],
  reason: null,
  enabledBy: null,
  enabledByName: null,
  enabledAt: null,
  expiresAt: null,
  usageCounts: {},
};

/** True when `rule` is currently suspended by `state`. Expiry is enforced by the caller. */
export function isRuleBypassed(state: RuleBypassState | null | undefined, rule: BypassableRule): boolean {
  return Boolean(state?.active && state.rules.includes(rule));
}
