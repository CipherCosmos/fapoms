/**
 * THE APPROVAL BEFORE TRAINING (owner, 2026-09-23).
 *
 * After HR's checks — documents, background verification — a senior who holds
 * `ASSAYER:APPROVE:ORGANIZATION` decides whether this person goes on to training. They approve,
 * reject with a reason, or ask HR for more. Whoever sent the file up (or answered the senior's
 * questions on it) may not decide it: the point of a second pair of eyes is that it is second.
 *
 * One ROUND per time somebody is put up for approval. A round carries its whole conversation —
 * submission, questions, answers, decision — so the record reads as what happened, in order.
 */
export enum OnboardingApprovalStatus {
  /** With the approver. */
  PENDING = 'PENDING',
  /** The approver asked for more; with HR until they answer. */
  INFO_REQUESTED = 'INFO_REQUESTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export const ONBOARDING_APPROVAL_STATUS_LABELS: Record<OnboardingApprovalStatus, string> = {
  [OnboardingApprovalStatus.PENDING]: 'Waiting for approval',
  [OnboardingApprovalStatus.INFO_REQUESTED]: 'More asked of HR',
  [OnboardingApprovalStatus.APPROVED]: 'Approved',
  [OnboardingApprovalStatus.REJECTED]: 'Rejected',
};

export enum OnboardingApprovalEventKind {
  SUBMITTED = 'SUBMITTED',
  INFO_REQUESTED = 'INFO_REQUESTED',
  ANSWERED = 'ANSWERED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

/** One line of a round's conversation. */
export interface OnboardingApprovalEvent {
  kind: OnboardingApprovalEventKind;
  byId: string;
  byName: string | null;
  at: string;
  /** The note, the question, the answer or the reason. */
  text: string | null;
}

/** Shortest and longest a reason or a question may be — long enough to be read later. */
export const APPROVAL_TEXT_MIN = 10;
export const APPROVAL_TEXT_MAX = 2000;

/** Why a decision's text will not do, or null. Approving needs no text; the others do. */
export function approvalTextProblem(kind: OnboardingApprovalEventKind, text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  if (t.length > APPROVAL_TEXT_MAX) return `Keep it under ${APPROVAL_TEXT_MAX} characters.`;
  if (kind === OnboardingApprovalEventKind.REJECTED && t.length < APPROVAL_TEXT_MIN) {
    return 'Say why they are not approved — it is kept on their record and read by whoever looks at it next.';
  }
  if (kind === OnboardingApprovalEventKind.INFO_REQUESTED && t.length < APPROVAL_TEXT_MIN) {
    return 'Say what you need from HR, so they know what to bring back.';
  }
  if (kind === OnboardingApprovalEventKind.ANSWERED && t.length < APPROVAL_TEXT_MIN) {
    return 'Answer what was asked, in a sentence the approver can act on.';
  }
  return null;
}

/**
 * Who prepared this round — the person who sent it up and anyone who answered the approver's
 * questions on it. None of them may decide it.
 */
export function approvalPreparers(events: Pick<OnboardingApprovalEvent, 'kind' | 'byId'>[]): string[] {
  return [...new Set(events
    .filter((e) => e.kind === OnboardingApprovalEventKind.SUBMITTED || e.kind === OnboardingApprovalEventKind.ANSWERED)
    .map((e) => e.byId))];
}
