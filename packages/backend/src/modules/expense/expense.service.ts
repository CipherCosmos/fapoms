import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';

import { ExpenseEntity, ExpenseCategory, ExpenseStatus } from './expense.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { EventCategory, AssignmentStatus } from '@fapoms/shared';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { BillingEngineService } from '../billing-engine/billing-engine.service';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';

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
    private readonly uow: UnitOfWork,
    private readonly regionGuard: RegionGuardService,
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
    scope?: Partial<GlobalScope>,
  ): Promise<ExpenseEntity> {
    const assignment = await this.assignmentRepository.findOne({
      where: { id: assignmentId },
      relations: ['projectBranch', 'projectBranch.branch'],
    });
    if (!assignment) {
      throw new NotFoundException(`Assignment ${assignmentId} not found.`);
    }

    // The region is already on hand from the load above (no extra query): a region-restricted
    // staff member raising a claim "on someone's behalf" against an out-of-region assignment is
    // the same gap as reading one, just on the write side.
    await this.regionGuard.assertRegionAllowedStaged(
      assignment.projectBranch?.branch?.region ?? null,
      scope,
      'expense:create',
    );

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

  /**
   * All claims raised against one assignment — always one assignment, so always one region.
   * A join to that region rides along on the same query (`addSelect`, not `leftJoinAndSelect`)
   * so it reaches `raw` without ever attaching to the hydrated entities: the returned rows are
   * byte-for-byte what `.find()` returned before this check existed.
   */
  async findForAssignment(
    assignmentId: string,
    scope?: Partial<GlobalScope>,
  ): Promise<ExpenseEntity[]> {
    const { entities, raw } = await this.expenseRepository
      .createQueryBuilder('expense')
      .leftJoin('expense.assignment', 'assignment')
      .leftJoin('assignment.projectBranch', 'pb')
      .leftJoin('pb.branch', 'branch')
      .addSelect('branch.region', 'region')
      .where('expense.assignmentId = :assignmentId', { assignmentId })
      .andWhere('expense.isActive = :isActive', { isActive: true })
      .orderBy('expense.createdAt', 'DESC')
      .getRawAndEntities();

    // Every row shares one assignment, so one lookup covers the whole list — a detail-route
    // ceiling wearing a list route's clothes, not a per-row filter.
    await this.regionGuard.assertRegionAllowedStaged(
      raw[0]?.region ?? null,
      scope,
      'expense:findForAssignment',
    );
    return entities;
  }

  /**
   * `findMine` (an assayer's own claims) and the admin-facing `assayers/:assayerId/expenses`
   * route both land here. Only the latter ever supplies `scope` — `findMine` calls this with two
   * arguments, so `scope` is `undefined` and the method takes the untouched `.find()` path below,
   * unconditionally, in every settings mode. A caller's own claim history does not depend on
   * which region they happen to be standing in.
   */
  async findForAssayer(
    assayerId: string,
    status?: ExpenseStatus,
    scope?: Partial<GlobalScope>,
  ): Promise<ExpenseEntity[]> {
    const baseQuery = () =>
      this.expenseRepository.find({
        where: { assayerId, isActive: true, ...(status ? { status } : {}) },
        relations: ['assignment'],
        order: { createdAt: 'DESC' },
      });

    if (!scope?.regions?.length) return baseQuery();

    const mode = await this.regionGuard.stagedMode();
    if (mode === 'off') return baseQuery();

    // An assayer can work assignments in more than one region, so the ceiling is per-row
    // (each claim's own assignment region), not the assayer's single home region — filtering on
    // the assayer's home region would either hide a region-X claim from a region-X operator (if
    // the assayer's home is elsewhere) or expose every region a national assayer has ever
    // worked to an operator assigned to only one of them.
    const query = this.expenseRepository
      .createQueryBuilder('expense')
      .leftJoinAndSelect('expense.assignment', 'assignment')
      .leftJoin('assignment.projectBranch', 'pb')
      .leftJoin('pb.branch', 'branch')
      .addSelect('branch.region', 'region')
      .where('expense.assayerId = :assayerId', { assayerId })
      .andWhere('expense.isActive = :isActive', { isActive: true });
    if (status) query.andWhere('expense.status = :status', { status });
    query.orderBy('expense.createdAt', 'DESC');

    const { entities, raw } = await query.getRawAndEntities();
    const regions = scope.regions;

    if (mode === 'enforce') {
      return entities.filter((_, i) => {
        const region = raw[i]?.region ?? null;
        return !region || regions.includes(region as any);
      });
    }

    // Log mode: never refuse. The count below is computed from the rows already in memory —
    // no second query just to produce a log line.
    const wouldRefuse = entities.reduce((count, _, i) => {
      const region = raw[i]?.region ?? null;
      return region && !regions.includes(region as any) ? count + 1 : count;
    }, 0);
    if (wouldRefuse > 0) {
      this.logger.warn(
        `[region-scope:expense:findForAssayer] would filter ${wouldRefuse} of ${entities.length} ` +
          `claim(s) for assayer ${assayerId} outside [${regions.join(', ')}]. Currently in Log mode: ` +
          `all rows returned.`,
      );
    }
    return entities;
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

  /**
   * Everything awaiting an operations or finance decision — org-wide, every region, unless the
   * caller is region-restricted. This is the bulk cross-region view the staged rollout is
   * primarily about: a scoped operator hitting this route today sees every other region's
   * pending claims too.
   */
  async findPending(scope?: Partial<GlobalScope>): Promise<ExpenseEntity[]> {
    const baseQuery = () =>
      this.expenseRepository.find({
        where: { status: ExpenseStatus.PENDING, isActive: true },
        relations: ['assignment', 'assayer'],
        order: { createdAt: 'ASC' },
      });

    if (!scope?.regions?.length) return baseQuery();

    const mode = await this.regionGuard.stagedMode();
    if (mode === 'off') return baseQuery();

    const { entities, raw } = await this.expenseRepository
      .createQueryBuilder('expense')
      .leftJoinAndSelect('expense.assignment', 'assignment')
      .leftJoinAndSelect('expense.assayer', 'assayer')
      .leftJoin('assignment.projectBranch', 'pb')
      .leftJoin('pb.branch', 'branch')
      .addSelect('branch.region', 'region')
      .where('expense.status = :status', { status: ExpenseStatus.PENDING })
      .andWhere('expense.isActive = :isActive', { isActive: true })
      .orderBy('expense.createdAt', 'ASC')
      .getRawAndEntities();

    const regions = scope.regions;

    if (mode === 'enforce') {
      return entities.filter((_, i) => {
        const region = raw[i]?.region ?? null;
        return !region || regions.includes(region as any);
      });
    }

    // Log mode: never refuse. Computed from the result set already in memory, not a second query.
    const wouldRefuse = entities.reduce((count, _, i) => {
      const region = raw[i]?.region ?? null;
      return region && !regions.includes(region as any) ? count + 1 : count;
    }, 0);
    if (wouldRefuse > 0) {
      this.logger.warn(
        `[region-scope:expense:findPending] would filter ${wouldRefuse} of ${entities.length} ` +
          `pending claim(s) outside [${regions.join(', ')}]. Currently in Log mode: all rows returned.`,
      );
    }
    return entities;
  }

  async review(
    expenseId: string,
    approve: boolean,
    userId: string,
    notes?: string,
    scope?: Partial<GlobalScope>,
  ): Promise<ExpenseEntity> {
    const expense = await this.expenseRepository.findOne({ where: { id: expenseId } });
    if (!expense) {
      throw new NotFoundException(`Expense ${expenseId} not found.`);
    }

    // Detail-route ceiling for a mutation: approving/rejecting a claim commits money, so an
    // operator restricted to one region should not be able to act on another region's claim by
    // guessing/being handed its id. `expense.assignmentId` is a plain column already loaded above
    // — resolving the region is one small extra query (mirrors
    // RegionGuardService.assertAssignmentInScope's join), skipped entirely for unrestricted
    // callers.
    if (scope?.regions?.length) {
      const rows = await this.assignmentRepository
        .createQueryBuilder('a')
        .leftJoin('a.projectBranch', 'pb')
        .leftJoin('pb.branch', 'b')
        .select('b.region', 'region')
        .where('a.id = :id', { id: expense.assignmentId })
        .getRawOne<{ region: string | null }>();
      await this.regionGuard.assertRegionAllowedStaged(
        rows?.region ?? null,
        scope,
        'expense:review',
      );
    }

    if (expense.status !== ExpenseStatus.PENDING) {
      throw new BadRequestException(`This claim has already been ${expense.status.toLowerCase()}.`);
    }
    if (!approve && !notes?.trim()) {
      // A refusal the assayer cannot understand is a refusal they cannot correct or appeal.
      throw new BadRequestException('A reason is required when rejecting an expense claim.');
    }

    // Maker-checker: the person who RAISED a claim cannot APPROVE it. Approving writes an
    // assayer_payables row — money out — so the same staff member entering a claim and then
    // approving their own entry is exactly the self-dealing separation of duties is meant to stop.
    // Rejecting your own entry is harmless and stays allowed; another reviewer or an admin approves.
    if (approve && expense.createdBy && expense.createdBy === userId) {
      throw new ForbiddenException(
        'You cannot approve an expense claim you raised. Ask another reviewer or an administrator to approve it.',
      );
    }

    expense.status = approve ? ExpenseStatus.APPROVED : ExpenseStatus.REJECTED;
    expense.reviewedBy = userId;
    expense.reviewedAt = new Date();
    expense.reviewNotes = notes?.trim() || null;
    expense.updatedBy = userId;

    /**
     * The approval and the money are one act.
     *
     * Reimbursement goes through `assayer_payables` rather than a mechanism of its own: that
     * table already knows how to approve, pay and record a payment history, and an expense payout
     * is the same act as a fee payout. The approval and the payable are written in ONE
     * transaction, so an approved claim with no money behind it cannot exist — the failure mode
     * that previously needed an "unpaid approvals" queue and a retry button, and that opened a
     * double-payment window on the retry. If the payable cannot be written, the approval rolls
     * back and the reviewer sees the error.
     */
    const saved = approve
      ? await this.uow.run(async (m) => {
          const payable = await this.billing.createReimbursementPayable(expense, m, userId);
          expense.reimbursementPayableId = payable.id;
          return m.save(expense);
        })
      : await this.expenseRepository.save(expense);

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
}
