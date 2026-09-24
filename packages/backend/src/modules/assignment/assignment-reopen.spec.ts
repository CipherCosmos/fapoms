import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { AssignmentService } from './assignment.service';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentStatus, ValidationStatus, VALIDATION_TRANSITIONS } from '@fapoms/shared';
import { ValidationStateMachine } from '../validation/validation.state-machine';

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
    /** Rows the papers-only redo reads through `manager.getRepository(...)`, by entity name. */
    related?: { ProjectBranchEntity?: any; ScheduleEntity?: any; ValidationCaseEntity?: any };
  } = {}) => {
    const relatedSaves: Record<string, any[]> = {};
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
      getRepository: jest.fn((target: any) => ({
        findOne: jest.fn(async () => (opts.related as any)?.[target?.name] ?? null),
        save: jest.fn(async (row: any) => { (relatedSaves[target?.name] ??= []).push({ ...row }); return row; }),
      })),
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
    (service as any).notificationDispatch = { emitSafe: jest.fn() };
    (service as any).refreshPush = { assignmentChanged: jest.fn() };

    return { service, manager, uow, billingEngine, auditService, savedAssignments, voidPayableCalls, relatedSaves };
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

  /**
   * Audit F11 (2026-09-24): an APPROVED payout with money already sent against it is paid money.
   * It used to pass the PAID check and be voided — a voided payable with a real disbursement behind it.
   */
  it('refuses a reopen when the live payout is part paid, and voids nothing', async () => {
    const { service, billingEngine, savedAssignments } = makeService({
      lockedStatus: AssignmentStatus.COMPLETED,
      assignment: completedAssignment(),
      payable: { id: 'payable-1', payableNumber: 'PY-1', status: 'APPROVED', paidAmount: '500.00' },
    });
    await expect(service.reopen('asn-1', 'admin-1', 'Audit reopened — completion was wrong'))
      .rejects.toThrow(/₹500 has already been paid against assayer payout PY-1/);
    expect(billingEngine.voidPayable).not.toHaveBeenCalled();
    expect(savedAssignments).toHaveLength(0);
  });

  it('still reopens an approved payout with nothing paid against it', async () => {
    const { service, billingEngine } = makeService({
      lockedStatus: AssignmentStatus.COMPLETED,
      assignment: completedAssignment(),
      payable: { id: 'payable-1', payableNumber: 'PY-1', status: 'APPROVED', paidAmount: '0.00' },
    });
    await service.reopen('asn-1', 'admin-1', 'Audit reopened — completion was wrong');
    expect(billingEngine.voidPayable).toHaveBeenCalled();
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

  /** Owner decision 2026-09-24: a reopened job is back on the assayer's list — they are told. */
  it('tells the assayer the job is open again, with the reason, and refreshes their phone', async () => {
    const { service } = makeService({
      lockedStatus: AssignmentStatus.COMPLETED,
      assignment: { ...completedAssignment(), assayerId: 'assayer-1', assignmentNumber: 'ASN-1', projectBranch: { branch: { name: 'Thrissur Main' } } },
      payable: null,
    });
    const emitSafe = jest.fn();
    const assignmentChanged = jest.fn();
    (service as any).notificationDispatch = { emitSafe };
    (service as any).refreshPush = { assignmentChanged };

    await service.reopen('asn-1', 'admin-1', 'Two packets were missed');

    expect(emitSafe).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ASSIGNMENT_REOPENED',
      assayerId: 'assayer-1',
      payload: expect.objectContaining({ branchName: 'Thrissur Main', reason: 'Two packets were missed' }),
    }));
    expect(assignmentChanged).toHaveBeenCalledWith('assayer-1', 'asn-1');
  });

  /**
   * E6 (owner decision 2026-09-24): reopen is a redo of the PAPERS. The visit's check-in and
   * check-out still count; only what completion moved on is put back.
   */
  describe('papers-only redo', () => {
    const visited = () => ({
      ...completedAssignment(),
      assayerId: 'assayer-1', assignmentNumber: 'ASN-7', projectBranchId: 'pb-1',
      scheduledDate: '2026-08-10',
      checkedInAt: new Date('2026-08-10T04:00:00Z'), checkedOutAt: new Date('2026-08-10T07:00:00Z'),
      checkInLatitude: 10.5, checkInLongitude: 76.2,
      slaStatus: 'COMPLIANT', slaDueDate: new Date('2026-08-10T18:29:59Z'),
    });

    it('keeps the check-in and check-out, and goes back on site rather than to "accepted"', async () => {
      const { service, savedAssignments } = makeService({ assignment: visited(), payable: null });
      const result = await service.reopen('asn-1', 'admin-1', 'Two packets were missed');
      expect(result.status).toBe(AssignmentStatus.CHECKED_IN);
      expect(savedAssignments[0].checkedInAt).toEqual(new Date('2026-08-10T04:00:00Z'));
      expect(savedAssignments[0].checkedOutAt).toEqual(new Date('2026-08-10T07:00:00Z'));
      expect(savedAssignments[0].checkInLatitude).toBe(10.5);
    });

    it('puts the branch back from AUDIT_COMPLETED to SCHEDULED (arrived) or ASSIGNMENT_CONFIRMED (never arrived)', async () => {
      const arrived = makeService({ assignment: visited(), payable: null, related: { ProjectBranchEntity: { id: 'pb-1', status: 'AUDIT_COMPLETED' } } });
      await arrived.service.reopen('asn-1', 'admin-1', 'redo');
      expect(arrived.relatedSaves.ProjectBranchEntity?.[0]?.status).toBe('SCHEDULED');

      const never = makeService({ assignment: { ...visited(), checkedInAt: null, checkedOutAt: null }, payable: null, related: { ProjectBranchEntity: { id: 'pb-1', status: 'AUDIT_COMPLETED' } } });
      const out = await never.service.reopen('asn-1', 'admin-1', 'redo');
      expect(out.status).toBe(AssignmentStatus.ACCEPTED);
      expect(never.relatedSaves.ProjectBranchEntity?.[0]?.status).toBe('ASSIGNMENT_CONFIRMED');
    });

    it('brings a VALIDATION_COMPLETED branch back too — approval is internal, not "sent to the client"', async () => {
      const { service, relatedSaves, auditService } = makeService({ assignment: visited(), payable: null, related: { ProjectBranchEntity: { id: 'pb-1', status: 'VALIDATION_COMPLETED' } } });
      await service.reopen('asn-1', 'admin-1', 'redo');
      expect(relatedSaves.ProjectBranchEntity?.[0]?.status).toBe('SCHEDULED');
      const reopened = auditService.recordEventSafe.mock.calls.map((c: any[]) => c[0]).find((e: any) => e.eventType === 'ASSIGNMENT_REOPENED');
      expect(reopened.metadata.papersOnlyRedo.branch).toEqual({ from: 'VALIDATION_COMPLETED', to: 'SCHEDULED' });
    });

    it('leaves a branch in some other state (e.g. already SCHEDULED) where it is, and says so', async () => {
      const { service, relatedSaves, auditService } = makeService({ assignment: visited(), payable: null, related: { ProjectBranchEntity: { id: 'pb-1', status: 'SCHEDULED' } } });
      await service.reopen('asn-1', 'admin-1', 'redo');
      expect(relatedSaves.ProjectBranchEntity).toBeUndefined();
      const reopened = auditService.recordEventSafe.mock.calls.map((c: any[]) => c[0]).find((e: any) => e.eventType === 'ASSIGNMENT_REOPENED');
      expect(reopened.metadata.papersOnlyRedo.branch).toEqual({ left: 'SCHEDULED' });
    });

    it('puts the calendar row back to CONFIRMED and active', async () => {
      const { service, relatedSaves } = makeService({ assignment: visited(), payable: null, related: { ScheduleEntity: { id: 's-1', status: 'COMPLETED', isActive: true, completedAt: new Date() } } });
      await service.reopen('asn-1', 'admin-1', 'redo');
      expect(relatedSaves.ScheduleEntity?.[0]).toMatchObject({ status: 'CONFIRMED', isActive: true, completedAt: null });
    });

    it('pauses a review in progress (HUMAN_REVIEW -> CORRECTION_REQUIRED) and creates no case', async () => {
      const { service, relatedSaves } = makeService({ assignment: visited(), payable: null, related: { ValidationCaseEntity: { id: 'v-1', status: 'HUMAN_REVIEW' } } });
      await service.reopen('asn-1', 'admin-1', 'redo');
      expect(relatedSaves.ValidationCaseEntity).toHaveLength(1);
      expect(relatedSaves.ValidationCaseEntity[0]).toMatchObject({ id: 'v-1', status: 'CORRECTION_REQUIRED' });
    });

    it('pulls an APPROVED (not yet submitted) case back to CORRECTION_REQUIRED', async () => {
      const { service, relatedSaves } = makeService({ assignment: visited(), payable: null, related: { ValidationCaseEntity: { id: 'v-1', status: 'APPROVED' } } });
      await service.reopen('asn-1', 'admin-1', 'redo');
      expect(relatedSaves.ValidationCaseEntity).toHaveLength(1);
      expect(relatedSaves.ValidationCaseEntity[0]).toMatchObject({ id: 'v-1', status: 'CORRECTION_REQUIRED' });
    });

    it.each(['PENDING', 'ASSIGNED', 'CORRECTION_REQUIRED'])(
      'leaves a %s validation case alone', async (status) => {
        const { service, relatedSaves } = makeService({ assignment: visited(), payable: null, related: { ValidationCaseEntity: { id: 'v-1', status } } });
        await service.reopen('asn-1', 'admin-1', 'redo');
        expect(relatedSaves.ValidationCaseEntity).toBeUndefined();
      });

    /**
     * Papers that have gone to the client cannot be redone from here (2026-09-24). "Gone to the
     * client" is what the validation module calls submission: the case SUBMITTED, or the branch
     * CLOSED (which submission writes). Refused with a stable code, before any money is voided.
     */
    describe('refuses once the papers have gone to the client', () => {
      const refused = async (related: any) => {
        const made = makeService({ assignment: visited(), payable: { id: 'payable-1' }, related });
        const err = await made.service.reopen('asn-1', 'admin-1', 'redo').catch((e) => e);
        return { err, ...made };
      };

      it('a SUBMITTED validation case', async () => {
        const { err, billingEngine, savedAssignments, relatedSaves } = await refused({ ValidationCaseEntity: { id: 'v-1', status: 'SUBMITTED' } });
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getResponse().code).toBe('REOPEN_PAPERS_WITH_CLIENT');
        expect(err.message).toMatch(/already been sent to the client/);
        // Nothing moved: no money voided, the job and the case untouched.
        expect(billingEngine.voidPayable).not.toHaveBeenCalled();
        expect(savedAssignments).toHaveLength(0);
        expect(relatedSaves.ValidationCaseEntity).toBeUndefined();
      });

      it('a CLOSED branch', async () => {
        const { err, billingEngine } = await refused({ ProjectBranchEntity: { id: 'pb-1', status: 'CLOSED' } });
        expect(err.getResponse().code).toBe('REOPEN_PAPERS_WITH_CLIENT');
        expect(billingEngine.voidPayable).not.toHaveBeenCalled();
      });

      it.each(['HUMAN_REVIEW', 'APPROVED', 'CORRECTION_REQUIRED', 'PENDING'])('not a %s case (still internal)', async (status) => {
        const { err } = await refused({ ValidationCaseEntity: { id: 'v-1', status } });
        expect(err).not.toBeInstanceOf(Error);
      });

      it('the validation table allows APPROVED -> CORRECTION_REQUIRED, and nothing out of SUBMITTED', () => {
        expect(ValidationStateMachine.canTransition(ValidationStatus.APPROVED, ValidationStatus.CORRECTION_REQUIRED)).toBe(true);
        expect(VALIDATION_TRANSITIONS[ValidationStatus.SUBMITTED] ?? []).toEqual([]);
      });
    });

    it('gives the redo a fresh SLA clock, and keeps a breach that already happened', async () => {
      const fresh = makeService({ assignment: { ...visited(), checkedInAt: null }, payable: null });
      await fresh.service.reopen('asn-1', 'admin-1', 'redo');
      expect(fresh.savedAssignments[0].slaStatus).toBe('COMPLIANT');
      expect(new Date(fresh.savedAssignments[0].slaDueDate).getTime()).toBeGreaterThan(Date.now());

      const breached = makeService({ assignment: { ...visited(), slaStatus: 'BREACHED' }, payable: null });
      await breached.service.reopen('asn-1', 'admin-1', 'redo');
      expect(breached.savedAssignments[0].slaStatus).toBe('BREACHED');
    });

    it('voids only the fee payable — the lookup excludes expense reimbursements', async () => {
      const { service, manager } = makeService({ assignment: visited(), payable: null });
      await service.reopen('asn-1', 'admin-1', 'redo');
      const payableLookup = manager.findOne.mock.calls.find((c: any[]) => c[0]?.name === 'AssayerPayableEntity');
      // `expenseId: IsNull()` — an expense payable is never picked up, so it is never voided.
      expect(payableLookup[1].where.expenseId).toBeDefined();
      expect(JSON.stringify(payableLookup[1].where.expenseId)).toContain('isNull');
    });
  });
});
