import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AssignmentStatus } from '@fapoms/shared';

import { ExpenseService } from './expense.service';
import { ExpenseEntity, ExpenseCategory, ExpenseStatus } from './expense.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { BillingEngineService } from '../billing-engine/billing-engine.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';

const OWNER = 'assayer-owner';
const INTRUDER = 'assayer-intruder';

describe('ExpenseService', () => {
  let service: ExpenseService;
  let expenseRepo: any;
  let assignmentRepo: any;
  let dispatch: any;
  let billing: any;
  /** The transaction's manager: `save` lands on the expense repo so the tests can see the row. */
  let txManager: any;
  let uow: any;

  const assignment = (status: AssignmentStatus = AssignmentStatus.CHECKED_IN) => ({
    id: 'asn-1',
    assayerId: OWNER,
    assignmentNumber: 'ASN-001',
    status,
    projectBranch: { branch: { name: 'Thrissur Main' } },
  });

  beforeEach(async () => {
    expenseRepo = {
      create: jest.fn((v) => v),
      save: jest.fn((v) => Promise.resolve({ id: 'exp-1', ...v })),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    assignmentRepo = { findOne: jest.fn().mockResolvedValue(assignment()) };
    dispatch = { emitSafe: jest.fn(), emit: jest.fn() };
    billing = { createReimbursementPayable: jest.fn().mockResolvedValue({ id: 'pay-1' }) };
    txManager = { save: jest.fn((v: any) => expenseRepo.save(v)) };
    // A UnitOfWork double that models ROLLBACK: the callback's writes reach the repository only
    // if the callback resolves. A throw propagates and nothing is "committed".
    uow = { run: jest.fn(async (work: any) => work(txManager, jest.fn())) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: PlatformSettingsService,
          // Nothing configured in tests: every lookup falls through to the caller's fallback,
          // which is the shipped constant.
          useValue: {
            get: jest.fn(async () => null),
            getMany: jest.fn(async () => ({})),
            getNumber: jest.fn(async (_k: string, fb?: number) => fb as number),
            describeAll: jest.fn(async () => []),
            onChange: jest.fn(),
          },
        },
        ExpenseService,
        { provide: getRepositoryToken(ExpenseEntity), useValue: expenseRepo },
        { provide: getRepositoryToken(AssignmentEntity), useValue: assignmentRepo },
        { provide: AuditService, useValue: { recordEvent: jest.fn().mockResolvedValue(undefined) , recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); })} },
        { provide: NotificationDispatchService, useValue: dispatch },
        { provide: BillingEngineService, useValue: billing },
        { provide: UnitOfWork, useValue: uow },
      ],
    }).compile();

    service = module.get<ExpenseService>(ExpenseService);
  });

  const valid = { category: ExpenseCategory.TOLL, amount: 240, description: 'NH-48 toll' };

  describe('create', () => {
    it('records a claim for the assayer the assignment belongs to', async () => {
      const result = await service.create('asn-1', valid, 'user-1', OWNER);
      expect(result).toMatchObject({ assayerId: OWNER, amount: 240, status: ExpenseStatus.PENDING });
      expect(dispatch.emitSafe).toHaveBeenCalledWith(expect.objectContaining({ type: 'EXPENSE_CLAIMED' }));
    });

    it("refuses a claim against another assayer's assignment", async () => {
      await expect(service.create('asn-1', valid, 'user-1', INTRUDER)).rejects.toThrow(ForbiddenException);
      expect(expenseRepo.save).not.toHaveBeenCalled();
    });

    it('lets internal staff raise a claim on an assayer\'s behalf', async () => {
      // No claimant id => staff path, so the ownership check does not apply.
      await expect(service.create('asn-1', valid, 'ops-1', null)).resolves.toMatchObject({ assayerId: OWNER });
    });

    it('rejects a zero or negative amount', async () => {
      await expect(service.create('asn-1', { ...valid, amount: 0 }, 'u', OWNER)).rejects.toThrow(BadRequestException);
      await expect(service.create('asn-1', { ...valid, amount: -5 }, 'u', OWNER)).rejects.toThrow(BadRequestException);
    });

    it('caps a single claim so one entry cannot commit an unbounded sum', async () => {
      await expect(service.create('asn-1', { ...valid, amount: 99999 }, 'u', OWNER)).rejects.toThrow(BadRequestException);
    });

    it('refuses a claim before the visit has started', async () => {
      // Nothing has been spent on an assignment that is merely offered.
      assignmentRepo.findOne.mockResolvedValue(assignment(AssignmentStatus.PENDING));
      await expect(service.create('asn-1', valid, 'u', OWNER)).rejects.toThrow(BadRequestException);
    });

    it('allows a claim after completion, when receipts are usually entered', async () => {
      assignmentRepo.findOne.mockResolvedValue(assignment(AssignmentStatus.COMPLETED));
      await expect(service.create('asn-1', valid, 'u', OWNER)).resolves.toBeDefined();
    });

    it('throws when the assignment does not exist', async () => {
      assignmentRepo.findOne.mockResolvedValue(null);
      await expect(service.create('nope', valid, 'u', OWNER)).rejects.toThrow(NotFoundException);
    });
  });

  describe('review', () => {
    const pending = { id: 'exp-1', assayerId: OWNER, amount: 240, category: ExpenseCategory.TOLL, status: ExpenseStatus.PENDING };

    it('approves a pending claim and stamps the reviewer', async () => {
      expenseRepo.findOne.mockResolvedValue({ ...pending });
      const result = await service.review('exp-1', true, 'ops-1', 'Receipt verified');
      expect(result.status).toBe(ExpenseStatus.APPROVED);
      expect(result.reviewedBy).toBe('ops-1');
      expect(result.reviewedAt).toBeInstanceOf(Date);
    });

    it('requires a reason to reject — an unexplained refusal cannot be acted on', async () => {
      expenseRepo.findOne.mockResolvedValue({ ...pending });
      await expect(service.review('exp-1', false, 'ops-1')).rejects.toThrow(BadRequestException);
      await expect(service.review('exp-1', false, 'ops-1', '  ')).rejects.toThrow(BadRequestException);
    });

    it('rejects with a reason and notifies the assayer', async () => {
      expenseRepo.findOne.mockResolvedValue({ ...pending });
      const result = await service.review('exp-1', false, 'ops-1', 'No receipt attached');
      expect(result.status).toBe(ExpenseStatus.REJECTED);
      expect(dispatch.emitSafe).toHaveBeenCalledWith(expect.objectContaining({ type: 'EXPENSE_REJECTED' }));
    });

    it('will not review the same claim twice', async () => {
      expenseRepo.findOne.mockResolvedValue({ ...pending, status: ExpenseStatus.APPROVED });
      await expect(service.review('exp-1', false, 'ops-1', 'reversing')).rejects.toThrow(BadRequestException);
    });

    it('refuses to let the claim\'s raiser approve their own claim', async () => {
      // Approving books a payable — money out. The same person entering and approving a claim
      // is exactly the self-dealing separation of duties exists to stop.
      expenseRepo.findOne.mockResolvedValue({ ...pending, createdBy: 'ops-1' });
      await expect(service.review('exp-1', true, 'ops-1', 'Looks fine')).rejects.toThrow(ForbiddenException);
      expect(expenseRepo.save).not.toHaveBeenCalled();
    });

    it('still lets the claim\'s raiser reject their own claim', async () => {
      // Rejecting moves no money, so self-rejection is harmless and stays allowed.
      expenseRepo.findOne.mockResolvedValue({ ...pending, createdBy: 'ops-1' });
      const result = await service.review('exp-1', false, 'ops-1', 'Filed by mistake');
      expect(result.status).toBe(ExpenseStatus.REJECTED);
    });

    it('lets a different reviewer approve a claim they did not raise', async () => {
      expenseRepo.findOne.mockResolvedValue({ ...pending, createdBy: 'ops-1' });
      const result = await service.review('exp-1', true, 'ops-2', 'Verified independently');
      expect(result.status).toBe(ExpenseStatus.APPROVED);
    });
  });

  describe('summaryForAssayer', () => {
    it('totals claims by state, coercing decimal strings from the driver', async () => {
      expenseRepo.find.mockResolvedValue([
        { amount: '240.00', status: ExpenseStatus.PENDING },
        { amount: '100.50', status: ExpenseStatus.APPROVED },
        { amount: '75.00', status: ExpenseStatus.REJECTED },
        { amount: '10.00', status: ExpenseStatus.PENDING },
      ]);
      await expect(service.summaryForAssayer(OWNER)).resolves.toEqual({
        pending: 250, approved: 100.5, rejected: 75, totalClaimed: 425.5,
      });
    });
  });

  describe('reimbursement — approval has to end in money', () => {
    const approved = (over: any = {}) => ({
      id: 'exp-1', assignmentId: 'asn-1', assayerId: OWNER, amount: 240,
      category: ExpenseCategory.TOLL, description: 'NH-48 toll',
      status: ExpenseStatus.PENDING, reimbursementPayableId: null, ...over,
    });

    beforeEach(() => {
      expenseRepo.findOne.mockResolvedValue(approved());
      expenseRepo.save.mockImplementation((v: any) => Promise.resolve(v));
    });

    it('raises a payable when a claim is approved, on the same transaction as the approval', async () => {
      // Before this, APPROVED was the end of the road: nothing owed the assayer the money and
      // there was no state that said it was still coming.
      await service.review('exp-1', true, 'reviewer-1');
      expect(uow.run).toHaveBeenCalledTimes(1);
      expect(billing.createReimbursementPayable).toHaveBeenCalledWith(
        expect.objectContaining({ assayerId: OWNER, amount: 240, assignmentId: 'asn-1' }),
        txManager,
        'reviewer-1',
      );
      // The approval itself is saved through the transaction's manager, not the repository.
      expect(txManager.save).toHaveBeenCalledWith(expect.objectContaining({ status: ExpenseStatus.APPROVED }));
    });

    it('links the claim to the payable that will pay it', async () => {
      await service.review('exp-1', true, 'reviewer-1');
      expect(txManager.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ reimbursementPayableId: 'pay-1' }),
      );
    });

    it('raises nothing when a claim is rejected, and opens no transaction', async () => {
      await service.review('exp-1', false, 'reviewer-1', 'Duplicate of ASN-001');
      expect(billing.createReimbursementPayable).not.toHaveBeenCalled();
      expect(uow.run).not.toHaveBeenCalled();
    });

    it('rolls the approval back when the payable cannot be raised', async () => {
      // The approval and the money are one act. An approved claim with no payable behind it is
      // the state that used to need an "unpaid approvals" queue, a retry button, and opened a
      // double-payment window on the retry. Now the reviewer sees the failure and the claim
      // stays PENDING.
      billing.createReimbursementPayable.mockRejectedValueOnce(new Error('db down'));
      await expect(service.review('exp-1', true, 'reviewer-1')).rejects.toThrow('db down');
      expect(expenseRepo.save).not.toHaveBeenCalled();
      expect(dispatch.emitSafe).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'EXPENSE_APPROVED' }));
    });
  });
});
