import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull } from 'typeorm';

import { ExpenseEntity, ExpenseCategory, ExpenseStatus } from './expense.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { EventCategory, AssignmentStatus } from '@fapoms/shared';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { BillingEngineService } from '../billing-engine/billing-engine.service';

export interface CreateExpenseDto {
  category: ExpenseCategory;
  amount: number;
  description?: string;
  receiptUrl?: string;
}

/** An assayer cannot claim an unbounded amount against a single visit without review. */
const MAX_SINGLE_CLAIM = 50000;

@Injectable()
export class ExpenseService {
  private readonly logger = new Logger(ExpenseService.name);

  constructor(
    @InjectRepository(ExpenseEntity)
    private readonly expenseRepository: Repository<ExpenseEntity>,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    private readonly auditService: AuditService,
    private readonly notificationDispatch: NotificationDispatchService,
    private readonly settings: PlatformSettingsService,
    private readonly billing: BillingEngineService,
  ) {}

  /**
   * Raise a claim against an assignment.
   *
   * `claimantAssayerId` is set when the caller is a field assayer, in which case the
   * assignment must be theirs — the mobile app is the main client here and an assayer must not
   * be able to claim against someone else's visit by editing an id.
   */
  async create(
    assignmentId: string,
    dto: CreateExpenseDto,
    userId: string,
    claimantAssayerId?: string | null,
  ): Promise<ExpenseEntity> {
    const assignment = await this.assignmentRepository.findOne({
      where: { id: assignmentId },
      relations: ['projectBranch', 'projectBranch.branch'],
    });
    if (!assignment) {
      throw new NotFoundException(`Assignment ${assignmentId} not found.`);
    }

    if (claimantAssayerId && assignment.assayerId !== claimantAssayerId) {
      this.logger.warn(
        `Assayer ${claimantAssayerId} attempted to claim an expense against assignment ${assignmentId}, which belongs to ${assignment.assayerId}.`,
      );
      throw new ForbiddenException('You can only claim expenses against an assignment of your own.');
    }

    const amount = Number(dto.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Expense amount must be a positive number.');
    }
    // Configurable, because "the largest plausible single claim" is a policy that varies by
    // operation and by year, not a fact about the code. The constant remains the fallback.
    const maxClaim = await this.settings
      .getNumber('expense.maxSingleClaim', MAX_SINGLE_CLAIM)
      .catch(() => MAX_SINGLE_CLAIM);
    if (amount > maxClaim) {
      throw new BadRequestException(
        `A single expense claim cannot exceed ₹${maxClaim.toLocaleString('en-IN')}. Split it or raise it with operations.`,
      );
    }
    if (!Object.values(ExpenseCategory).includes(dto.category)) {
      throw new BadRequestException(`Unknown expense category: ${dto.category}`);
    }

    // Claiming against work that was never carried out has no basis. Offered and rejected
    // assignments have involved no travel yet; cancelled ones no longer will.
    const claimable: AssignmentStatus[] = [
      AssignmentStatus.CHECKED_IN,
      AssignmentStatus.IN_PROGRESS,
      AssignmentStatus.COMPLETED,
    ];
    if (!claimable.includes(assignment.status)) {
      throw new BadRequestException(
        `Expenses can only be claimed once the visit is under way — this assignment is ${assignment.status}.`,
      );
    }

    const expense = this.expenseRepository.create({
      assignmentId,
      assayerId: assignment.assayerId,
      category: dto.category,
      amount,
      description: dto.description?.trim() || null,
      receiptUrl: dto.receiptUrl || null,
      status: ExpenseStatus.PENDING,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.expenseRepository.save(expense);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'EXPENSE_CLAIMED',
      entityType: 'EXPENSE',
      entityId: saved.id,
      userId,
      remarks: `Claimed ₹${amount} (${dto.category}) against assignment ${assignment.assignmentNumber}`,
    });

    this.notificationDispatch.emitSafe({
      type: 'EXPENSE_CLAIMED',
      entityType: 'EXPENSE',
      entityId: saved.id,
      actorUserId: userId,
      assayerId: assignment.assayerId,
      dedupeKey: `EXPENSE_CLAIMED:${saved.id}`,
      payload: {
        expenseId: saved.id,
        assignmentId,
        amount,
        category: dto.category,
        branchName: assignment.projectBranch?.branch?.name ?? 'a branch',
      },
    });

    return saved;
  }

  async findForAssignment(assignmentId: string): Promise<ExpenseEntity[]> {
    return this.expenseRepository.find({
      where: { assignmentId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  async findForAssayer(assayerId: string, status?: ExpenseStatus): Promise<ExpenseEntity[]> {
    return this.expenseRepository.find({
      where: { assayerId, isActive: true, ...(status ? { status } : {}) },
      relations: ['assignment'],
      order: { createdAt: 'DESC' },
    });
  }

  /** Totals for the mobile earnings screen, which previously had no source at all. */
  async summaryForAssayer(assayerId: string): Promise<{
    pending: number;
    approved: number;
    rejected: number;
    totalClaimed: number;
  }> {
    const rows = await this.expenseRepository.find({ where: { assayerId, isActive: true } });
    const sum = (s: ExpenseStatus) =>
      rows.filter((r) => r.status === s).reduce((acc, r) => acc + Number(r.amount), 0);

    return {
      pending: sum(ExpenseStatus.PENDING),
      approved: sum(ExpenseStatus.APPROVED),
      rejected: sum(ExpenseStatus.REJECTED),
      totalClaimed: rows.reduce((acc, r) => acc + Number(r.amount), 0),
    };
  }

  /** Everything awaiting an operations or finance decision. */
  async findPending(): Promise<ExpenseEntity[]> {
    return this.expenseRepository.find({
      where: { status: ExpenseStatus.PENDING, isActive: true },
      relations: ['assignment', 'assayer'],
      order: { createdAt: 'ASC' },
    });
  }

  async review(
    expenseId: string,
    approve: boolean,
    userId: string,
    notes?: string,
  ): Promise<ExpenseEntity> {
    const expense = await this.expenseRepository.findOne({ where: { id: expenseId } });
    if (!expense) {
      throw new NotFoundException(`Expense ${expenseId} not found.`);
    }
    if (expense.status !== ExpenseStatus.PENDING) {
      throw new BadRequestException(`This claim has already been ${expense.status.toLowerCase()}.`);
    }
    if (!approve && !notes?.trim()) {
      // A refusal the assayer cannot understand is a refusal they cannot correct or appeal.
      throw new BadRequestException('A reason is required when rejecting an expense claim.');
    }

    expense.status = approve ? ExpenseStatus.APPROVED : ExpenseStatus.REJECTED;
    expense.reviewedBy = userId;
    expense.reviewedAt = new Date();
    expense.reviewNotes = notes?.trim() || null;
    expense.updatedBy = userId;

    const saved = await this.expenseRepository.save(expense);

    if (approve) {
      await this.raiseReimbursement(saved, userId);
    }

    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: approve ? 'EXPENSE_APPROVED' : 'EXPENSE_REJECTED',
      entityType: 'EXPENSE',
      entityId: saved.id,
      previousState: ExpenseStatus.PENDING,
      newState: saved.status,
      userId,
      remarks: notes?.trim() || `Expense ${saved.status.toLowerCase()}`,
    });

    this.notificationDispatch.emitSafe({
      type: approve ? 'EXPENSE_APPROVED' : 'EXPENSE_REJECTED',
      entityType: 'EXPENSE',
      entityId: saved.id,
      actorUserId: userId,
      assayerId: saved.assayerId,
      dedupeKey: `EXPENSE_REVIEWED:${saved.id}`,
      payload: {
        expenseId: saved.id,
        amount: Number(saved.amount),
        category: saved.category,
        reason: saved.reviewNotes ?? '',
      },
    });

    return saved;
  }

  /**
   * Turns an approved claim into money the assayer is actually owed.
   *
   * Reimbursement goes through `assayer_payables` rather than a mechanism of its own: that table
   * already knows how to approve, withhold TDS, disburse and record a payment history, and an
   * expense payout is the same act as a fee payout. A second route to "pay an assayer" would
   * mean two places to look when someone asks what they are owed, and two to fix when the payout
   * rules change.
   *
   * Booked as `baseAmount` with no travel component. An expense is a reimbursement of money the
   * assayer already spent, so `travelAmount` — which the transport rate card computes as an
   * allowance — would double-count a claim that is itself often for travel.
   *
   * Failure here does not undo the approval. The reviewer's decision is a real event that has
   * already been recorded and notified, and rolling it back because the payable could not be
   * written would leave the assayer told nothing at all. `reimbursementPayableId` stays null,
   * which is exactly the state {@link listUnpaidApprovals} reports so ops can retry it.
   */
  private async raiseReimbursement(expense: ExpenseEntity, userId: string): Promise<void> {
    // The unique index is the real guard against double payment; this is the cheap check that
    // keeps the common case from reaching it.
    if (expense.reimbursementPayableId) return;

    try {
      const assignment = await this.assignmentRepository.findOne({
        where: { id: expense.assignmentId },
        select: ['id', 'assayerId', 'projectId'],
      });

      const payable = await this.billing.createPayable({
        assayerId: expense.assayerId,
        assignmentId: expense.assignmentId,
        projectId: assignment?.projectId ?? undefined,
        baseAmount: Number(expense.amount),
        travelAmount: 0,
        // No TDS on a reimbursement: this is the assayer's own money being returned, not income
        // earned. Withholding on it would take tax on a sum they were never paid.
        taxRate: 0,
        tdsRate: 0,
        remarks: `Expense reimbursement — ${expense.category}${expense.description ? `: ${expense.description}` : ''}`,
        rateSnapshot: { source: 'EXPENSE_CLAIM', expenseId: expense.id, category: expense.category },
      }, userId);

      expense.reimbursementPayableId = payable.id;
      await this.expenseRepository.save(expense);
    } catch (err) {
      // Logged rather than thrown, for the reason in the doc comment above.
      this.logger.error(
        `Approved expense ${expense.id} but could not raise its reimbursement payable: ${
          err instanceof Error ? err.message : String(err)
        }. It will appear in the unpaid-approvals list until retried.`,
      );
    }
  }

  /**
   * Approved claims that never became a payable — the queue that stops a failed reimbursement
   * from being invisible.
   *
   * Without this the failure mode is silent in the worst way: the assayer has been told their
   * claim was approved, and nobody on the finance side has anything to act on.
   */
  async listUnpaidApprovals(): Promise<ExpenseEntity[]> {
    return this.expenseRepository.find({
      where: { status: ExpenseStatus.APPROVED, reimbursementPayableId: IsNull(), isActive: true },
      order: { reviewedAt: 'ASC' },
    });
  }

  /** Raises the missing payables for {@link listUnpaidApprovals}. Safe to run repeatedly. */
  async retryUnpaidApprovals(userId: string): Promise<{ attempted: number; raised: number }> {
    const pending = await this.listUnpaidApprovals();
    let raised = 0;
    for (const expense of pending) {
      await this.raiseReimbursement(expense, userId);
      if (expense.reimbursementPayableId) raised += 1;
    }
    return { attempted: pending.length, raised };
  }
}
