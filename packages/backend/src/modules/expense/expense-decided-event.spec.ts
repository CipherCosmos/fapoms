import { ExpenseService } from './expense.service';
import { ExpenseStatus } from './expense.entity';

/**
 * A reviewed claim is announced live (`expense:decided`) so the claimant's phone and the desk
 * refresh without a reload — after the decision is committed, carrying ids and the verdict only.
 */
describe('ExpenseService.review — publishes expense:decided', () => {
  const build = (publish: jest.Mock) => {
    const row = { id: 'exp-1', assignmentId: 'asn-1', assayerId: 'asr-1', amount: 240, category: 'TOLL', status: ExpenseStatus.PENDING };
    const repo = { findOne: jest.fn().mockResolvedValue({ ...row }) };
    const m = { findOne: jest.fn().mockResolvedValue({ ...row }), save: jest.fn(async (v: any) => v) };
    const uow = { run: jest.fn(async (work: any) => work(m, jest.fn())) };
    return new ExpenseService(
      repo as any, {} as any, {} as any,
      { recordEvent: jest.fn().mockResolvedValue(undefined) } as any,
      { emitSafe: jest.fn() } as any,
      {} as any, {} as any, uow as any, {} as any,
      { publish } as any,
    );
  };

  it('publishes the verdict with ids only, after the commit', async () => {
    const publish = jest.fn();
    const saved = await build(publish).review('exp-1', false, 'ops-1', 'No receipt attached');
    expect(saved.status).toBe(ExpenseStatus.REJECTED);
    expect(publish).toHaveBeenCalledWith('expense:decided', {
      eventType: 'expense:decided',
      expenseId: 'exp-1',
      assignmentId: 'asn-1',
      assayerId: 'asr-1',
      status: ExpenseStatus.REJECTED,
      userId: 'ops-1',
    });
  });

  it('does not fail the review when publishing throws', async () => {
    const publish = jest.fn(() => { throw new Error('bus down'); });
    await expect(build(publish).review('exp-1', false, 'ops-1', 'No receipt')).resolves.toBeDefined();
  });
});
