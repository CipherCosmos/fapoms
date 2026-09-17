/**
 * The Appraiser Recruitment application — the record a self-registering candidate builds before
 * anyone touches the live roster.
 *
 * Deliberately separate from `AssayerLifecycleStatus` (see `assayer-lifecycle.ts`): that enum is
 * guarded (`derived-status.spec.ts`, the transition-map waypoint rules) precisely because it
 * governs a real, working assayer, and none of that machinery has any meaning for somebody who
 * does not have a roster record yet. An application is promoted into a real `AssayerEntity` only
 * on approval — see `AssayerApplicationEntity.promotedAssayerId`.
 *
 * The HR-desk registration wizard (`RegistrationWizard.tsx`) never touches this — it still writes
 * a live assayer directly, ungated, exactly as it always has. This status only governs the NEW
 * self-registration entry points (web link, mobile app).
 */
export enum ApplicationStatus {
  /** Being filled in, autosaved, not yet submitted. Only the candidate (via their token) can see it. */
  DRAFT = 'DRAFT',
  /** Submitted, awaiting HR review. */
  PENDING_VALIDATION = 'PENDING_VALIDATION',
  /** HR asked for a correction or an additional document; the candidate can resume via the same link. */
  AWAITING_INFO = 'AWAITING_INFO',
  /** Terminal. HR declined the application; a reason is required. */
  REJECTED = 'REJECTED',
  /** Terminal (successful). Promoted to a real assayer — see `promotedAssayerId`. */
  APPROVED = 'APPROVED',
  /**
   * Terminal. The candidate withdrew their consent, so the application stops where it is and what
   * they had given us is erased. Distinct from REJECTED on purpose: nobody judged this person, and
   * a register of people we turned down should not quietly fill up with people who simply left.
   */
  WITHDRAWN = 'WITHDRAWN',
}

/** States that accept no further action from either the candidate or HR. */
export const APPLICATION_TERMINAL_STATUSES: ApplicationStatus[] = [
  ApplicationStatus.REJECTED,
  ApplicationStatus.APPROVED,
];

/** Whether the candidate may still edit and (re)submit through their invite link. */
export function applicationIsEditableByCandidate(status: ApplicationStatus): boolean {
  return status === ApplicationStatus.DRAFT || status === ApplicationStatus.AWAITING_INFO;
}

/**
 * Who authored the substance of an application — the rule maker–checker keys on.
 *
 * SELF_SERVICE: the candidate filled it in through their invite link (web or mobile). The HR
 * user who sent the invite is not the maker and may review it.
 * HR_DESK: a staff account typed the candidate in through the portal wizard. That account is
 * the maker, and approval must come from somebody else — the same segregation this product
 * already enforces for money.
 */
export enum ApplicationSource {
  SELF_SERVICE = 'SELF_SERVICE',
  HR_DESK = 'HR_DESK',
}

export enum InterviewOutcome {
  PASS = 'PASS',
  FAIL = 'FAIL',
}
