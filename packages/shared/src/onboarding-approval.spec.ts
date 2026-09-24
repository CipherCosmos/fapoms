import { approvalTextProblem, approvalPreparers, openQuestionAsker, OnboardingApprovalEventKind as K } from './onboarding-approval';

/** The approval before training — the rules every door shares. */
describe('the approval before training', () => {
  it('lets an approval go without a word, but not a rejection or a question', () => {
    expect(approvalTextProblem(K.APPROVED, '')).toBeNull();
    expect(approvalTextProblem(K.REJECTED, 'no')).toMatch(/Say why/);
    expect(approvalTextProblem(K.INFO_REQUESTED, '')).toMatch(/what you need/);
    expect(approvalTextProblem(K.ANSWERED, 'ok')).toMatch(/Answer what was asked/);
    expect(approvalTextProblem(K.REJECTED, 'Two criminal cases pending in Pune.')).toBeNull();
  });

  it('counts whoever sent it up and whoever answered on it as its preparers', () => {
    expect(approvalPreparers([
      { kind: K.SUBMITTED, byId: 'hr-1' },
      { kind: K.INFO_REQUESTED, byId: 'boss' },
      { kind: K.ANSWERED, byId: 'hr-2' },
      { kind: K.ANSWERED, byId: 'hr-1' },
    ])).toEqual(['hr-1', 'hr-2']);
  });
});

/**
 * THE DEADLOCK OF 24 SEP 2026, AND WHY IT CANNOT RECUR.
 *
 * `admin` sent a candidate up; `shivam.kumar`, the only other approver, asked HR for more and then
 * answered his own question from the box the panel wrongly offered him. Counting that answer as
 * preparing the file left both approvers standing aside and nobody able to decide.
 */
describe('who prepared the round, when an approver answered their own question', () => {
  const sent = { kind: K.SUBMITTED, byId: 'admin' };
  const asked = (byId: string) => ({ kind: K.INFO_REQUESTED, byId });
  const answered = (byId: string) => ({ kind: K.ANSWERED, byId });

  it('does not count the approver who answered their own question — the round that was stuck', () => {
    expect(approvalPreparers([sent, asked('shivam'), answered('shivam')])).toEqual(['admin']);
  });

  it('still counts HR, or anybody else, who answered what the approver asked', () => {
    expect(approvalPreparers([sent, asked('shivam'), answered('hr-1')])).toEqual(['admin', 'hr-1']);
  });

  it('judges each answer against the question it answers, not an earlier one', () => {
    // Rao asks, HR answers; then Shivam asks and answers himself. HR prepared; Shivam did not.
    expect(approvalPreparers([sent, asked('rao'), answered('hr-1'), asked('shivam'), answered('shivam')]).sort())
      .toEqual(['admin', 'hr-1']);
    // Shivam asks, HR answers; Rao asks, and Shivam answers Rao — Shivam DID prepare that answer.
    expect(approvalPreparers([sent, asked('shivam'), answered('hr-1'), asked('rao'), answered('shivam')]).sort())
      .toEqual(['admin', 'hr-1', 'shivam']);
  });
});

describe('the question still waiting for HR', () => {
  it('names who asked it, until it is answered', () => {
    expect(openQuestionAsker([{ kind: K.SUBMITTED, byId: 'admin' }])).toBeNull();
    expect(openQuestionAsker([{ kind: K.SUBMITTED, byId: 'admin' }, { kind: K.INFO_REQUESTED, byId: 'shivam' }])).toBe('shivam');
    expect(openQuestionAsker([
      { kind: K.SUBMITTED, byId: 'admin' }, { kind: K.INFO_REQUESTED, byId: 'shivam' }, { kind: K.ANSWERED, byId: 'hr-1' },
    ])).toBeNull();
  });
});

