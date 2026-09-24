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

/**
 * Where approving sends somebody (owner, 2026-09-24: "after approving the approver can also send them
 * to training or make them active"). Training was the only way on; it stays the default, so a caller
 * that does not say keeps the old behaviour.
 */
export type ApprovalDestination = 'TRAINING' | 'ACTIVE';
export const APPROVAL_DESTINATIONS: readonly ApprovalDestination[] = ['TRAINING', 'ACTIVE'];
export const APPROVAL_DESTINATION_WORDS: Record<ApprovalDestination, string> = {
  TRAINING: 'on to training',
  ACTIVE: 'now Active — ready for work',
};

/** One line of a round's conversation. */
export interface OnboardingApprovalEvent {
  kind: OnboardingApprovalEventKind;
  byId: string;
  byName: string | null;
  at: string;
  /** The note, the question, the answer or the reason. */
  text: string | null;
  /** On an approval: where it sent them. Absent on approvals from before the choice existed (training). */
  to?: ApprovalDestination;
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
 *
 * An answer counts only when it comes from somebody OTHER than whoever asked the question it
 * answers. On 24 Sep 2026 an approver asked HR for more and then, offered HR's answer box, answered
 * his own question. Counted as preparing, that took away his right to decide; the only other
 * approver had sent the person up, so nobody could decide at all. An approver answering themselves
 * has prepared nothing — the file is exactly what HR sent up — so it is not a reason to stand aside.
 * (It can no longer happen: `answer` refuses the person who asked. This keeps a round where it
 * already did from staying stuck.)
 */
export function approvalPreparers(events: Pick<OnboardingApprovalEvent, 'kind' | 'byId'>[]): string[] {
  const preparers = new Set<string>();
  let asker: string | null = null;
  for (const e of events) {
    if (e.kind === OnboardingApprovalEventKind.SUBMITTED) preparers.add(e.byId);
    else if (e.kind === OnboardingApprovalEventKind.INFO_REQUESTED) asker = e.byId;
    else if (e.kind === OnboardingApprovalEventKind.ANSWERED) {
      if (e.byId !== asker) preparers.add(e.byId);
      asker = null;
    }
  }
  return [...preparers];
}

/**
 * Who asked the question HR has not answered yet — or null when nothing is outstanding.
 *
 * The one person who may not answer it: HR answers what the approver asked, and an approver who
 * answered themselves would only be closing their own question with nothing new in the file.
 */
export function openQuestionAsker(events: Pick<OnboardingApprovalEvent, 'kind' | 'byId'>[]): string | null {
  let asker: string | null = null;
  for (const e of events) {
    if (e.kind === OnboardingApprovalEventKind.INFO_REQUESTED) asker = e.byId;
    else if (e.kind === OnboardingApprovalEventKind.ANSWERED) asker = null;
  }
  return asker;
}
