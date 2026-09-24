import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AssayerInvoiceStatus,
  AssayerPayableStatus,
  AssignmentStatus,
  EXPENSE_APPROVAL_OVERRIDABLE_CODES,
  OTHER_CONFLICT_ERROR_CODES,
  SystemRole,
} from '@fapoms/shared';

import { ExpenseService } from './expense.service';
import { ExpenseController, mayOverrideExpenseApproval } from './expense.controller';
import { ExpenseEntity, ExpenseCategory, ExpenseStatus } from './expense.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AssayerInvoiceEntity } from '../billing-engine/assayer-invoice.entity';
import { AssayerPayableEntity } from '../billing-engine/payable.entity';
import { evaluateExpenseApproval, liveFeeBillId, SENT_BILL_STATUSES } from '../assignment/assignment-capabilities';
import { AuditService } from '../../core/audit/audit.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { BillingEngineService } from '../billing-engine/billing-engine.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { ROLES_KEY } from '../auth/guards';

/**
 * APPROVING AN EXPENSE CLAIM (owner decision 2026-09-24): refused when (1) the assignment is
 * cancelled, (2) the claim's assayer no longer holds it, or (3) the job's live fee payable is on an
 * assayer bill that has been SENT (submitted, approved or paid). A senior (ADMIN, and DEVELOPER by
 * implication) may approve anyway by writing a reason, which is kept on the claim and in the
 * audit event. Rejecting is never blocked.
 *
 * Mutation checks these tests were run against (each turns at least one test red):
 *   - dropping any one of the three conditions in `evaluateExpenseApproval`;
 *   - treating an INVITED bill as sent, or reading `assayerInvoiceId` without `isLivePayable`;
 *   - letting a non-senior's reason through (`mayOverride` ignored);
 *   - dropping the minimum reason length;
 *   - not recording the reason on the claim, or recording one on a normal approval;
 *   - running the rules on a rejection.
 */

const HOLDER = 'assayer-holder';
const OTHER = 'assayer-other';
const job = (over: any = {}) => ({ id: 'asn-1', assignmentNumber: 'ASN-001', status: AssignmentStatus.COMPLETED, assayerId: HOLDER, ...over });
const fee = (over: any = {}) => ({ id: 'fee-1', status: AssayerPayableStatus.PENDING, expenseId: null, assayerInvoiceId: null, ...over });

describe('evaluateExpenseApproval', () => {
  const claim = { assayerId: HOLDER };

  it('allows a claim on a live job, still held by the claimant, whose pay is on no sent bill', () => {
    expect(evaluateExpenseApproval(job(), claim, null, null)).toEqual({ allowed: true, blocks: [] });
    expect(evaluateExpenseApproval(job(), claim, fee(), null).allowed).toBe(true);
  });

  it('(1) refuses a cancelled assignment, naming it', () => {
    const d = evaluateExpenseApproval(job({ status: AssignmentStatus.CANCELLED }), claim, null, null);
    expect(d).toMatchObject({ allowed: false, code: OTHER_CONFLICT_ERROR_CODES.EXPENSE_APPROVAL_ASSIGNMENT_CANCELLED });
    expect(!d.allowed && d.reason).toContain('Assignment ASN-001 has been cancelled.');
  });

  it('(2) refuses when the claimant no longer holds the assignment (reassigned away, or unassigned)', () => {
    for (const assayerId of [OTHER, null]) {
      const d = evaluateExpenseApproval(job({ assayerId }), claim, null, null);
      expect(d).toMatchObject({ allowed: false, code: OTHER_CONFLICT_ERROR_CODES.EXPENSE_APPROVAL_ASSAYER_REASSIGNED });
      expect(!d.allowed && d.reason).toContain('no longer holds assignment ASN-001');
    }
  });

  it.each(SENT_BILL_STATUSES)('(3) refuses when the live fee payable is on a %s bill', (billStatus) => {
    const d = evaluateExpenseApproval(job(), claim, fee({ assayerInvoiceId: 'ainv-1' }), billStatus);
    expect(d).toMatchObject({ allowed: false, code: OTHER_CONFLICT_ERROR_CODES.EXPENSE_APPROVAL_JOB_ON_SENT_BILL });
    expect(!d.allowed && d.reason).toContain('already been sent');
  });

  it('(3) does not refuse a bill that has not been sent yet (INVITED) — the assayer has seen nothing', () => {
    expect(evaluateExpenseApproval(job(), claim, fee({ assayerInvoiceId: 'ainv-1' }), AssayerInvoiceStatus.INVITED).allowed).toBe(true);
  });

  it('(3) reads "on a bill" exactly as the claim rule does: a voided payable is history, never on a bill', () => {
    const voided = fee({ status: AssayerPayableStatus.VOIDED, assayerInvoiceId: 'ainv-old' });
    expect(liveFeeBillId(voided)).toBeNull();
    expect(evaluateExpenseApproval(job(), claim, voided, AssayerInvoiceStatus.APPROVED).allowed).toBe(true);
    // And a status with no bill link behind it is not a bill.
    expect(evaluateExpenseApproval(job(), claim, fee(), AssayerInvoiceStatus.PAID).allowed).toBe(true);
  });

  it('lists every condition that applies, first one as the code, and says a senior can override', () => {
    const d = evaluateExpenseApproval(
      job({ status: AssignmentStatus.CANCELLED, assayerId: OTHER }),
      claim,
      fee({ assayerInvoiceId: 'ainv-1' }),
      AssayerInvoiceStatus.SUBMITTED,
    );
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    expect(d.blocks.map((b) => b.code)).toEqual([...EXPENSE_APPROVAL_OVERRIDABLE_CODES]);
    expect(d.code).toBe(OTHER_CONFLICT_ERROR_CODES.EXPENSE_APPROVAL_ASSIGNMENT_CANCELLED);
    expect(d.reason).toMatch(/cancelled\..*reassigned\..*already been sent.*A senior can still approve it by writing a reason\.$/);
  });
});

describe('ExpenseService.review — the approval rules and the senior override', () => {
  let service: ExpenseService;
  let expenseRepo: any;
  let assignmentRepo: any;
  let invoiceRepo: any;
  let billing: any;
  let audit: any;
  let txManager: any;
  let txAssignment: any;
  let txBill: any;
  let txFee: any;

  const pending = (over: any = {}) => ({
    id: 'exp-1', assignmentId: 'asn-1', assayerId: HOLDER, amount: 240, category: ExpenseCategory.TOLL,
    status: ExpenseStatus.PENDING, createdBy: HOLDER, reimbursementPayableId: null, ...over,
  });
  const senior = (reason?: string) => ({ reason, mayOverride: true });
  const reviewer = (reason?: string) => ({ reason, mayOverride: false });
  const codeOf = (err: any) => err?.getResponse?.()?.code;

  beforeEach(async () => {
    expenseRepo = {
      findOne: jest.fn().mockResolvedValue(pending()),
      save: jest.fn((v: any) => Promise.resolve(v)),
      create: jest.fn((v: any) => v),
    };
    assignmentRepo = { findOne: jest.fn().mockResolvedValue(job()), createQueryBuilder: jest.fn() };
    invoiceRepo = { findOne: jest.fn().mockResolvedValue(null) };
    billing = {
      createReimbursementPayable: jest.fn().mockResolvedValue({ id: 'pay-1' }),
      liveFeePayable: jest.fn().mockResolvedValue(null),
    };
    audit = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    // Inside the approval's transaction the same facts are read again under lock; by default the
    // transaction sees what the lock-free pre-check saw. `txAssignment` / `txBill` / `txFee` let a
    // test change the world between the two reads.
    txAssignment = undefined; txBill = undefined; txFee = undefined;
    txManager = {
      save: jest.fn((v: any) => Promise.resolve(v)),
      findOne: jest.fn((entity: any, opts: any) => {
        if (entity === AssignmentEntity) return txAssignment !== undefined ? Promise.resolve(txAssignment) : assignmentRepo.findOne(opts);
        if (entity === AssayerInvoiceEntity) return txBill !== undefined ? Promise.resolve(txBill) : invoiceRepo.findOne(opts);
        if (entity === AssayerPayableEntity) return txFee !== undefined ? Promise.resolve(txFee) : billing.liveFeePayable();
        return expenseRepo.findOne();
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpenseService,
        { provide: getRepositoryToken(ExpenseEntity), useValue: expenseRepo },
        { provide: getRepositoryToken(AssignmentEntity), useValue: assignmentRepo },
        { provide: getRepositoryToken(AssayerInvoiceEntity), useValue: invoiceRepo },
        { provide: AuditService, useValue: audit },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn() } },
        { provide: BillingEngineService, useValue: billing },
        { provide: PlatformSettingsService, useValue: { getNumber: jest.fn(async (_k: string, fb: number) => fb) } },
        { provide: UnitOfWork, useValue: { run: jest.fn(async (work: any) => work(txManager, jest.fn())) } },
        { provide: RegionGuardService, useValue: { assertRegionAllowedStaged: jest.fn(), stagedMode: jest.fn(async () => 'off') } },
      ],
    }).compile();
    service = module.get(ExpenseService);
  });

  it('refuses approving a claim on a cancelled assignment with 409 and the condition\'s own code', async () => {
    assignmentRepo.findOne.mockResolvedValue(job({ status: AssignmentStatus.CANCELLED }));
    const err = await service.review('exp-1', true, 'ops-1', undefined, undefined, reviewer()).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(codeOf(err)).toBe(OTHER_CONFLICT_ERROR_CODES.EXPENSE_APPROVAL_ASSIGNMENT_CANCELLED);
    expect(err.message).toContain('has been cancelled');
    expect(billing.createReimbursementPayable).not.toHaveBeenCalled();
    expect(txManager.save).not.toHaveBeenCalled();
  });

  it('refuses approving a claim whose assayer was reassigned away', async () => {
    assignmentRepo.findOne.mockResolvedValue(job({ assayerId: OTHER }));
    const err = await service.review('exp-1', true, 'ops-1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(codeOf(err)).toBe(OTHER_CONFLICT_ERROR_CODES.EXPENSE_APPROVAL_ASSAYER_REASSIGNED);
  });

  it('reads the status of the very bill the live fee payable is on, and refuses once it is sent', async () => {
    billing.liveFeePayable.mockResolvedValue(fee({ assayerInvoiceId: 'ainv-7' }));
    invoiceRepo.findOne.mockResolvedValue({ id: 'ainv-7', status: AssayerInvoiceStatus.SUBMITTED });
    const err = await service.review('exp-1', true, 'ops-1').catch((e) => e);
    expect(invoiceRepo.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'ainv-7' } }));
    expect(codeOf(err)).toBe(OTHER_CONFLICT_ERROR_CODES.EXPENSE_APPROVAL_JOB_ON_SENT_BILL);
  });

  it('approves normally while the bill is only INVITED, and records no override', async () => {
    billing.liveFeePayable.mockResolvedValue(fee({ assayerInvoiceId: 'ainv-7' }));
    invoiceRepo.findOne.mockResolvedValue({ id: 'ainv-7', status: AssayerInvoiceStatus.INVITED });
    const saved = await service.review('exp-1', true, 'ops-1');
    expect(saved).toMatchObject({ status: ExpenseStatus.APPROVED, approvalOverrideReason: null, approvalOverrideCodes: null });
  });

  it('never blocks a rejection — not even on a cancelled, reassigned, sent-bill job', async () => {
    assignmentRepo.findOne.mockResolvedValue(job({ status: AssignmentStatus.CANCELLED, assayerId: OTHER }));
    billing.liveFeePayable.mockResolvedValue(fee({ assayerInvoiceId: 'ainv-7' }));
    invoiceRepo.findOne.mockResolvedValue({ id: 'ainv-7', status: AssayerInvoiceStatus.PAID });
    const saved = await service.review('exp-1', false, 'ops-1', 'Job was cancelled');
    expect(saved.status).toBe(ExpenseStatus.REJECTED);
    expect(assignmentRepo.findOne).not.toHaveBeenCalled();
  });

  it('refuses a reason from someone who is not a senior (403), and books nothing', async () => {
    assignmentRepo.findOne.mockResolvedValue(job({ status: AssignmentStatus.CANCELLED }));
    const err = await service
      .review('exp-1', true, 'ops-1', undefined, undefined, reviewer('The visit happened before the cancellation'))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(codeOf(err)).toBe(OTHER_CONFLICT_ERROR_CODES.EXPENSE_APPROVAL_OVERRIDE_NOT_PERMITTED);
    expect(err.message).toContain('has been cancelled');
    expect(billing.createReimbursementPayable).not.toHaveBeenCalled();
  });

  it('refuses a senior\'s reason that is too short to mean anything (400 OVERRIDE_REASON_REQUIRED)', async () => {
    assignmentRepo.findOne.mockResolvedValue(job({ status: AssignmentStatus.CANCELLED }));
    const err = await service.review('exp-1', true, 'admin-1', undefined, undefined, senior('  ok  ')).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(codeOf(err)).toBe('OVERRIDE_REASON_REQUIRED');
    expect(billing.createReimbursementPayable).not.toHaveBeenCalled();
  });

  it('a senior with a real reason approves anyway: reason and set-aside codes kept on the claim and in the audit', async () => {
    assignmentRepo.findOne.mockResolvedValue(job({ status: AssignmentStatus.CANCELLED, assayerId: OTHER }));
    const why = 'Visit was done on the 12th; cancelled afterwards by mistake';
    const saved = await service.review('exp-1', true, 'admin-1', 'Receipt checked', undefined, senior(`  ${why}  `));
    expect(saved.status).toBe(ExpenseStatus.APPROVED);
    expect(saved.approvalOverrideReason).toBe(why);
    expect(saved.approvalOverrideCodes).toEqual([
      OTHER_CONFLICT_ERROR_CODES.EXPENSE_APPROVAL_ASSIGNMENT_CANCELLED,
      OTHER_CONFLICT_ERROR_CODES.EXPENSE_APPROVAL_ASSAYER_REASSIGNED,
    ]);
    expect(billing.createReimbursementPayable).toHaveBeenCalledTimes(1);
    expect(audit.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'EXPENSE_APPROVED',
      remarks: expect.stringContaining(`Reason: ${why}`),
      metadata: { approvalOverride: { reason: why, codes: saved.approvalOverrideCodes } },
    }));
  });

  it('re-checks under lock inside the transaction: a cancel that lands after the pre-check still refuses, and books nothing', async () => {
    txAssignment = job({ status: AssignmentStatus.CANCELLED });
    const err = await service.review('exp-1', true, 'ops-1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(codeOf(err)).toBe(OTHER_CONFLICT_ERROR_CODES.EXPENSE_APPROVAL_ASSIGNMENT_CANCELLED);
    expect(txManager.findOne).toHaveBeenCalledWith(AssignmentEntity, expect.objectContaining({ lock: { mode: 'pessimistic_read' } }));
    expect(billing.createReimbursementPayable).not.toHaveBeenCalled();
    expect(txManager.save).not.toHaveBeenCalled();
  });

  it('an override covers only the refusals the senior saw: a bill sent meanwhile still refuses', async () => {
    assignmentRepo.findOne.mockResolvedValue(job({ status: AssignmentStatus.CANCELLED }));
    txFee = fee({ assayerInvoiceId: 'ainv-9' });
    txBill = { id: 'ainv-9', status: AssayerInvoiceStatus.SUBMITTED };
    const err = await service.review('exp-1', true, 'admin-1', undefined, undefined, senior('Travelled before the cancel; bus ticket attached.')).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(codeOf(err)).toBe(OTHER_CONFLICT_ERROR_CODES.EXPENSE_APPROVAL_JOB_ON_SENT_BILL);
    expect(billing.createReimbursementPayable).not.toHaveBeenCalled();
  });

  it('a reason sent with an approval the rules allow is not an override and is not recorded as one', async () => {
    const saved = await service.review('exp-1', true, 'admin-1', undefined, undefined, senior('Just to be safe, approving'));
    expect(saved).toMatchObject({ status: ExpenseStatus.APPROVED, approvalOverrideReason: null, approvalOverrideCodes: null });
    expect(audit.recordEvent).toHaveBeenCalledWith(expect.not.objectContaining({ metadata: expect.anything() }));
  });
});

describe('who is a senior for the override', () => {
  const user = (...roles: string[]) => ({ roles: roles.map((name) => ({ name, permissions: [] })) });

  it('ADMIN is; DEVELOPER is through the role hierarchy', () => {
    expect(mayOverrideExpenseApproval(user(SystemRole.ADMIN))).toBe(true);
    expect(mayOverrideExpenseApproval(user(SystemRole.DEVELOPER))).toBe(true);
    expect(mayOverrideExpenseApproval({ roles: [SystemRole.ADMIN] })).toBe(true); // string-shaped roles
  });

  it('the day-to-day reviewer (OPERATIONS), a custom role and nobody are not', () => {
    expect(mayOverrideExpenseApproval(user(SystemRole.OPERATIONS))).toBe(false);
    expect(mayOverrideExpenseApproval(user('REGIONAL_MANAGER'))).toBe(false);
    expect(mayOverrideExpenseApproval(undefined)).toBe(false);
  });

  it('the route decides it from the caller\'s own roles and hands the body\'s reason through', async () => {
    const review = jest.fn().mockResolvedValue({});
    const controller = new ExpenseController({ review } as any);
    await controller.review('exp-1', { approve: true, overrideReason: 'Because of X and Y' } as any, { user: { id: 'u1', ...user(SystemRole.OPERATIONS) } });
    expect(review).toHaveBeenLastCalledWith('exp-1', true, 'u1', undefined, undefined, { reason: 'Because of X and Y', mayOverride: false });
    await controller.review('exp-1', { approve: true, overrideReason: 'Because of X and Y' } as any, { user: { id: 'u2', ...user(SystemRole.ADMIN) } });
    expect(review).toHaveBeenLastCalledWith('exp-1', true, 'u2', undefined, undefined, { reason: 'Because of X and Y', mayOverride: true });
  });

  it('the review route itself is unchanged: ADMIN and OPERATIONS may review', () => {
    const roles = new Reflector().get<SystemRole[]>(ROLES_KEY, ExpenseController.prototype.review);
    expect(roles).toEqual([SystemRole.ADMIN, SystemRole.OPERATIONS]);
  });
});
