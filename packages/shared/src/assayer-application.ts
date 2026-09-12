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

export enum InterviewOutcome {
  PASS = 'PASS',
  FAIL = 'FAIL',
}
