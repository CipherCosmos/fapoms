import { approvalTextProblem, approvalPreparers, OnboardingApprovalEventKind as K } from './onboarding-approval';

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
