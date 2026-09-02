import { BillingEngineService } from './billing-engine.service';

/**
 * The money chain's watchdog.
 *
 * Booking a payable is the one automatic hop between "audit done" and "assayer paid"; approving
 * it, exporting the bank file and marking it paid are all people clicking. Nothing anywhere
 * noticed when a person did not click. A payable could rest in PENDING for weeks while the
 * assayer's own screen called it owed, and an audit that was attended but never closed booked
 * nothing at all — both ending with a real person unpaid and no alarm raised.
 */
describe('BillingEngineService — money-chain watchdog', () => {
  const makeService = (rows: any[]) => {
    const query = jest.fn().mockResolvedValue(rows);
    const service = Object.create(BillingEngineService.prototype) as BillingEngineService;
    (service as any).assignmentRepository = { manager: { query } };
    return { service, query };
  };

  describe('payoutsAwaitingApproval', () => {
    it('reports the backlog, its value and how long the oldest has waited', async () => {
      const { service } = makeService([{ count: '4', total: '18250.50', oldest_days: '11.6' }]);
      await expect(service.payoutsAwaitingApproval(3)).resolves.toEqual({
        count: 4, totalAmount: 18250.5, oldestDays: 11,
      });
    });

    it('is silent when nothing is waiting', async () => {
      const { service } = makeService([{ count: '0', total: '0', oldest_days: '0' }]);
      await expect(service.payoutsAwaitingApproval(3)).resolves.toEqual({
        count: 0, totalAmount: 0, oldestDays: 0,
      });
    });

    it('ignores held payouts and counts only PENDING beyond the grace period', async () => {
      const { service, query } = makeService([{ count: '1', total: '10', oldest_days: '5' }]);
      await service.payoutsAwaitingApproval(3);
      const sql = query.mock.calls[0][0] as string;
      // A held payout is a deliberate decision, not a forgotten one — chasing it would train
      // people to ignore the alert.
      expect(sql).toContain('on_hold = false');
      expect(sql).toContain("status = 'PENDING'");
      expect(query.mock.calls[0][1]).toEqual(['3']);
    });
  });

  describe('attendedButNotClosed', () => {
    it('reports attended audits that were never completed', async () => {
      const { service } = makeService([{ count: '2', oldest: '2026-08-20' }]);
      await expect(service.attendedButNotClosed(2)).resolves.toEqual({
        count: 2, oldestDate: '2026-08-20',
      });
    });

    it('keys on check-IN, so a visit with no check-out still counts', async () => {
      const { service, query } = makeService([{ count: '0', oldest: null }]);
      await service.attendedButNotClosed(2);
      const sql = query.mock.calls[0][0] as string;
      // Waiting for a check-out the assayer may never tap would hide exactly the worst cases.
      expect(sql).toContain('checked_in_at IS NOT NULL');
      expect(sql).not.toContain('checked_out_at IS NOT NULL');
    });

    it('excludes work that was closed on purpose', async () => {
      const { service, query } = makeService([{ count: '0', oldest: null }]);
      await service.attendedButNotClosed(2);
      const sql = query.mock.calls[0][0] as string;
      expect(sql).toContain("status IN ('CHECKED_IN', 'IN_PROGRESS', 'ACCEPTED')");
      expect(sql).not.toContain('CANCELLED');
      expect(sql).not.toContain('COMPLETED');
    });

    it('handles an empty table without inventing a date', async () => {
      const { service } = makeService([]);
      await expect(service.attendedButNotClosed(2)).resolves.toEqual({ count: 0, oldestDate: null });
    });
  });
});
