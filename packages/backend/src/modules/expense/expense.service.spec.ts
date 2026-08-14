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

const OWNER = 'assayer-owner';
const INTRUDER = 'assayer-intruder';

describe('ExpenseService', () => {
  let service: ExpenseService;
  let expenseRepo: any;
  let assignmentRepo: any;
  let dispatch: any;
  let billing: any;

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
    billing = { createPayable: jest.fn().mockResolvedValue({ id: 'pay-1' }) };

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

    it('raises a payable when a claim is approved', async () => {
      // Before this, APPROVED was the end of the road: nothing owed the assayer the money and
      // there was no state that said it was still coming.
      await service.review('exp-1', true, 'reviewer-1');
      expect(billing.createPayable).toHaveBeenCalledWith(
        expect.objectContaining({ assayerId: OWNER, baseAmount: 240, assignmentId: 'asn-1' }),
        'reviewer-1',
      );
    });

    it('links the claim to the payable that will pay it', async () => {
      await service.review('exp-1', true, 'reviewer-1');
      expect(expenseRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ reimbursementPayableId: 'pay-1' }),
      );
    });

    it('withholds no tds, because a reimbursement is not income', async () => {
      // The assayer is getting their own money back. Withholding would deduct tax on a sum
      // they were never paid.
      await service.review('exp-1', true, 'reviewer-1');
      expect(billing.createPayable).toHaveBeenCalledWith(
        expect.objectContaining({ tdsRate: 0, taxRate: 0 }),
        expect.anything(),
      );
    });

    it('books nothing as travel, so a travel claim is not paid twice', async () => {
      // The transport rate card already puts a travel allowance in the assignment fee. Booking
      // a toll claim as travel as well would reimburse the same journey through two channels.
      await service.review('exp-1', true, 'reviewer-1');
      expect(billing.createPayable).toHaveBeenCalledWith(
        expect.objectContaining({ travelAmount: 0 }),
        expect.anything(),
      );
    });

    it('raises nothing when a claim is rejected', async () => {
      await service.review('exp-1', false, 'reviewer-1', 'Duplicate of ASN-001');
      expect(billing.createPayable).not.toHaveBeenCalled();
    });

    it('keeps the approval when the payable cannot be raised, and leaves it retryable', async () => {
      // Rolling the approval back would leave the assayer told nothing at all. The claim stays
      // approved with a null payable id — which is exactly what the unpaid-approvals queue looks
      // for — rather than the decision silently disappearing.
      billing.createPayable.mockRejectedValueOnce(new Error('db down'));
      const result = await service.review('exp-1', true, 'reviewer-1');
      expect(result.status).toBe(ExpenseStatus.APPROVED);
      expect(result.reimbursementPayableId).toBeNull();
    });

    it('does not raise a second payable for a claim that already has one', async () => {
      // The double-payment guard. A retry sweep must be safe to run as often as anyone likes.
      expenseRepo.find.mockResolvedValueOnce([approved({ status: ExpenseStatus.APPROVED, reimbursementPayableId: 'pay-existing' })]);
      const result = await service.retryUnpaidApprovals('reviewer-1');
      expect(billing.createPayable).not.toHaveBeenCalled();
      expect(result).toEqual({ attempted: 1, raised: 1 });
    });

    it('raises the missing payables when the queue is retried', async () => {
      expenseRepo.find.mockResolvedValueOnce([approved({ status: ExpenseStatus.APPROVED })]);
      const result = await service.retryUnpaidApprovals('reviewer-1');
      expect(billing.createPayable).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ attempted: 1, raised: 1 });
    });
  });
});
