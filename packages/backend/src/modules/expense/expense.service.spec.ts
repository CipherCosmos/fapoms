import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AssignmentStatus } from '@fapoms/shared';

import { ExpenseService } from './expense.service';
import { ExpenseEntity, ExpenseCategory, ExpenseStatus } from './expense.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';

const OWNER = 'assayer-owner';
const INTRUDER = 'assayer-intruder';

describe('ExpenseService', () => {
  let service: ExpenseService;
  let expenseRepo: any;
  let assignmentRepo: any;
  let dispatch: any;

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpenseService,
        { provide: getRepositoryToken(ExpenseEntity), useValue: expenseRepo },
        { provide: getRepositoryToken(AssignmentEntity), useValue: assignmentRepo },
        { provide: AuditService, useValue: { recordEvent: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationDispatchService, useValue: dispatch },
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
});
