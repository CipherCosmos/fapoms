import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { AssignmentService } from './assignment.service';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentStatus } from '@fapoms/shared';

/**
 * The owner-decision undo: voiding a payable for a completion that should not have booked money,
 * and reopening the assignment it was booked from.
 *
 * `voidPayable` runs on the SAME manager/transaction as the assignment's own lock-and-save — not
 * a second, independent transaction — so the two either both commit or both roll back. Two
 * separate transactions here would risk a deadlock (each taking `FOR UPDATE` on rows the other
 * touches) and, worse, a partial outcome: the money voided but the assignment still reading
 * COMPLETED, or the reverse.
 */
describe('AssignmentService.reopen', () => {
  const makeService = (opts: {
    lockedStatus?: string | null;
    assignment?: any;
    payable?: any | null;
  } = {}) => {
    const savedAssignments: any[] = [];
    const voidPayableCalls: any[] = [];

    const manager: any = {
      query: jest.fn(async (sql: string) => {
        if (/FOR UPDATE/.test(sql)) {
          return opts.lockedStatus === null ? [] : [{ status: opts.lockedStatus ?? AssignmentStatus.COMPLETED }];
        }
        return [];
      }),
      findOne: jest.fn(async (target: any) => {
        if (target === AssignmentEntity) return opts.assignment ?? null;
        if (target?.name === 'AssayerPayableEntity') return opts.payable ?? null;
        return null;
      }),
      save: jest.fn(async (a: any) => { savedAssignments.push(a); return a; }),
    };

    const uow = { run: jest.fn(async (work: any) => work(manager, jest.fn())) };
    const billingEngine = {
      voidPayable: jest.fn(async (payableId: string, reason: string, userId: string, ctx: any) => {
        voidPayableCalls.push({ payableId, reason, userId, ctx });
        return { id: payableId, status: 'VOIDED' };
      }),
    };
    const auditService = { recordEventSafe: jest.fn() };

    const service = Object.create(AssignmentService.prototype) as AssignmentService;
    (service as any).uow = uow;
    (service as any).billingEngine = billingEngine;
    (service as any).auditService = auditService;

    return { service, manager, uow, billingEngine, auditService, savedAssignments, voidPayableCalls };
  };

  const completedAssignment = () => ({
    id: 'asn-1', status: AssignmentStatus.COMPLETED,
    completionDate: '2026-08-10', completedWithoutCheckInReason: null, remarks: null,
  });

  it('requires a reason', async () => {
    const { service } = makeService();
    await expect(service.reopen('asn-1', 'admin-1', '   ')).rejects.toThrow(BadRequestException);
  });

  it('404s an assignment that does not exist', async () => {
    const { service } = makeService({ lockedStatus: null });
    await expect(service.reopen('asn-1', 'admin-1', 'reason')).rejects.toThrow(NotFoundException);
  });

  it('refuses to reopen anything but a COMPLETED assignment', async () => {
    const { service } = makeService({ lockedStatus: AssignmentStatus.ACCEPTED });
    await expect(service.reopen('asn-1', 'admin-1', 'reason')).rejects.toThrow(ConflictException);
  });

  it('voids the matching payable on the SAME manager/emit before reopening the assignment', async () => {
    const { service, manager, billingEngine, voidPayableCalls, savedAssignments } = makeService({
      lockedStatus: AssignmentStatus.COMPLETED,
      assignment: completedAssignment(),
      payable: { id: 'payable-1' },
    });

    const result = await service.reopen('asn-1', 'admin-1', 'Audit reopened — completion was wrong');

    expect(billingEngine.voidPayable).toHaveBeenCalledWith(
      'payable-1', 'Audit reopened — completion was wrong', 'admin-1',
      expect.objectContaining({ manager }),
    );
    // The mutation this proves: calling `voidPayable(id, reason, userId)` with no fourth
    // argument makes billing-engine open its OWN transaction (`this.inTx`) instead of running on
    // this one — the two could then commit independently, which is exactly what this test guards.
    expect(voidPayableCalls[0].ctx.manager).toBe(manager);

    expect(result.status).toBe(AssignmentStatus.ACCEPTED);
    expect(savedAssignments[0].completionDate).toBeNull();
  });

  it('reopens even when there is no payable to void — an expense-only or never-booked completion', async () => {
    const { service, billingEngine } = makeService({
      lockedStatus: AssignmentStatus.COMPLETED,
      assignment: completedAssignment(),
      payable: null,
    });

    const result = await service.reopen('asn-1', 'admin-1', 'reason');
    expect(billingEngine.voidPayable).not.toHaveBeenCalled();
    expect(result.status).toBe(AssignmentStatus.ACCEPTED);
  });
});
