import { Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, IsNull, Not, Repository } from 'typeorm';

import { ExpenseEntity, ExpenseCategory, ExpenseStatus } from './expense.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import {
  ASSIGNMENT_ERROR_CODES,
  DEAD_PAYABLE_STATUSES,
  EXPENSE_APPROVAL_OVERRIDE_MIN_REASON,
  EventCategory,
  OTHER_CONFLICT_ERROR_CODES,
} from '@fapoms/shared';
import {
  evaluateExpenseApproval,
  evaluateExpenseClaim,
  liveFeeBillId,
  type ExpenseApprovalDecision,
} from '../assignment/assignment-capabilities';
import { AssayerInvoiceEntity } from '../billing-engine/assayer-invoice.entity';
import { AssayerPayableEntity } from '../billing-engine/payable.entity';
import { withCode } from '../../infrastructure/http/api-error';
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
  /** Mobile's idempotency key: a retried submission of the same claim carries the same id. */
  clientRequestId?: string;
}

/**
 * What a reviewer brought to an approval besides yes/no: a written reason to approve over the
 * approval rules' refusal, and whether they are a senior who may (decided by the route from the
 * caller's own roles — `EXPENSE_APPROVAL_OVERRIDE_ROLES` — never by anything in the body).
 */
export interface ExpenseApprovalOverrideRequest {
  reason?: string | null;
  mayOverride: boolean;
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
    @InjectRepository(AssayerInvoiceEntity)
    private readonly assayerInvoiceRepository: Repository<AssayerInvoiceEntity>,
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

    // Idempotency: a retried submission (flaky field connection) carries the same
    // clientRequestId as the attempt it is retrying. Returning the existing claim here — rather
    // than letting the unique index reject the insert — keeps the retry a 200 with the same
    // shape a first-time success gets, which is what a client-side retry loop expects.
    if (dto.clientRequestId) {
      const existingClaim = await this.expenseRepository.findOne({
        where: { assayerId: assignment.assayerId, clientRequestId: dto.clientRequestId },
      });
      if (existingClaim) {
        return existingClaim;
      }
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

    /**
     * The claim rule — `evaluateExpenseClaim` (assignment-capabilities.ts), the same function the
     * field app's CLAIM_EXPENSE capability is built from, so the app offers a claim only when this
     * would accept it. Two halves:
     *
     * Claiming against work that was never carried out has no basis. Offered and rejected
     * assignments have involved no travel yet; cancelled ones no longer will.
     *
     * No new claim once the job's pay is on a bill — owner decision 2026-09-24: "Refuse once on a
     * bill." Claims are made before billing.
     *
     * "The job's pay" is its LIVE fee payable (`isLivePayable` / `DEAD_PAYABLE_STATUSES`): a voided
     * payable from an earlier, reopened completion is history and never blocks a claim on the redo.
     *
     * "On a bill" is the payable→assayer-invoice link (`assayerInvoiceId`), in ANY bill state —
     * including a bill still waiting for the assayer to confirm. The link is the whole question
     * because every path that takes a payable off a bill clears it: cancelling a bill releases its
     * lines (`AssayerInvoiceService.cancel`), a revision detaches the lines it does not carry, and
     * `releaseFromAssayerInvoice` does the same for a voided or held line.
     *
     * A payable approved or paid WITHOUT a bill — the desk's recorded direct-approval exception —
     * has had its money settled just the same, so the APPROVED/PAID stages ("Ready to pay", "Paid")
     * also refuse, with their own code.
     *
     * Applies to every caller, staff raising a claim on an assayer's behalf included: the rule is
     * about the state of the money, not about who is typing. The visit-state half is read first and
     * answers 400 as it always has; the money half answers 409, as it always has.
     */
    const visit = evaluateExpenseClaim(assignment, null);
    if (!visit.allowed) {
      throw withCode(new BadRequestException(visit.reason), visit.code as any);
    }
    const feePayable = await this.billing.liveFeePayable(assignmentId);
    const money = evaluateExpenseClaim(assignment, feePayable);
    if (!money.allowed) {
      throw withCode(new ConflictException(money.reason), money.code as any);
    }

    const expense = this.expenseRepository.create({
      assignmentId,
      assayerId: assignment.assayerId,
      category: dto.category,
      amount,
      description: dto.description?.trim() || null,
      receiptUrl: dto.receiptUrl || null,
      status: ExpenseStatus.PENDING,
      clientRequestId: dto.clientRequestId || null,
      createdBy: userId,
      updatedBy: userId,
    });

    let saved: ExpenseEntity;
    try {
      saved = await this.expenseRepository.save(expense);
    } catch (err: any) {
      // A concurrent retry can lose the read-then-check race above and hit the partial unique
      // index instead; treat that the same as finding it up front rather than surfacing a 500.
      if (dto.clientRequestId && err?.code === '23505') {
        const existingClaim = await this.expenseRepository.findOne({
          where: { assayerId: assignment.assayerId, clientRequestId: dto.clientRequestId },
        });
        if (existingClaim) return existingClaim;
      }
      throw err;
    }

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
    overrideRequest?: ExpenseApprovalOverrideRequest,
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

    /**
     * The approval rules (owner decision 2026-09-24) — `evaluateExpenseApproval`: refused when the
     * assignment was cancelled, when the claim's assayer no longer holds it, or when the job's pay
     * is on a bill that has been sent. A senior may approve anyway by writing a reason; the reason
     * and the refusals it set aside are kept on the claim and in the audit event. A reason sent
     * with an approval the rules allow is not an override and is not recorded as one. Rejecting is
     * never refused.
     */
    const override = approve ? await this.resolveApprovalRules(expense, overrideRequest) : null;

    /**
     * The approval and the money are one act — AND the PENDING→APPROVED/REJECTED transition is a
     * compare-and-swap under a row lock, not a check-then-write around the read above.
     *
     * The status/maker-checker checks above run on a row read with no lock, so two concurrent
     * reviews both saw PENDING. The unique index `UQ_assayer_payables_expense` stops a second
     * APPROVE from booking a second payable, but an APPROVE racing a REJECT does not collide on
     * that index — the reject writes no payable — so the two could interleave to leave the claim
     * REJECTED with a reimbursement payable already booked against it: money out for a refused
     * claim. Re-reading the row `FOR UPDATE` inside the transaction and re-asserting PENDING there
     * makes the loser fail cleanly with "already <status>", exactly as a second sequential review
     * would, whichever verb it carried.
     *
     * Reimbursement goes through `assayer_payables` rather than a mechanism of its own: that table
     * already knows how to approve, pay and record a payment history, and an expense payout is the
     * same act as a fee payout. Approval and payable are written in ONE transaction, so an approved
     * claim with no money behind it cannot exist.
     */
    const saved = await this.uow.run(async (m) => {
      const locked = await m.findOne(ExpenseEntity, {
        where: { id: expenseId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) throw new NotFoundException(`Expense ${expenseId} not found.`);
      if (locked.status !== ExpenseStatus.PENDING) {
        throw new BadRequestException(`This claim has already been ${locked.status.toLowerCase()}.`);
      }

      locked.status = approve ? ExpenseStatus.APPROVED : ExpenseStatus.REJECTED;
      locked.reviewedBy = userId;
      locked.reviewedAt = new Date();
      locked.reviewNotes = notes?.trim() || null;
      locked.updatedBy = userId;

      if (approve) {
        // The rules were checked above for a fast, lock-free answer; check them again here under
        // lock so a cancel, reassign or bill sent in between is not missed. An override covers
        // only the refusals the senior saw and wrote a reason against — a new one refuses.
        const current = await this.approvalDecision(locked, m);
        const newBlocks = current.allowed ? [] : current.blocks.filter((b) => !override?.codes.includes(b.code));
        if (newBlocks.length > 0) {
          throw withCode(new ConflictException(newBlocks.map((b) => b.reason).join(' ')), newBlocks[0].code as any);
        }
        locked.approvalOverrideReason = override?.reason ?? null;
        locked.approvalOverrideCodes = override?.codes ?? null;
        const payable = await this.billing.createReimbursementPayable(locked, m, userId);
        locked.reimbursementPayableId = payable.id;
      }
      return m.save(locked);
    });

    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: approve ? 'EXPENSE_APPROVED' : 'EXPENSE_REJECTED',
      entityType: 'EXPENSE',
      entityId: saved.id,
      previousState: ExpenseStatus.PENDING,
      newState: saved.status,
      userId,
      remarks: override
        ? `Approved by a senior over ${override.codes.join(', ')}. Reason: ${override.reason}`
          + (notes?.trim() ? ` Notes: ${notes.trim()}` : '')
        : notes?.trim() || `Expense ${saved.status.toLowerCase()}`,
      ...(override ? { metadata: { approvalOverride: { reason: override.reason, codes: override.codes } } } : {}),
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
   * The approval rules' answer for this claim, from the facts as they stand: the assignment's
   * status and holder, the job's live fee payable, and the status of the bill that payable is on.
   */
  async approvalDecision(
    expense: Pick<ExpenseEntity, 'assignmentId' | 'assayerId'>,
    m?: EntityManager,
  ): Promise<ExpenseApprovalDecision> {
    // With a transaction manager, the assignment and the bill are read under a SHARE lock: a
    // concurrent cancel, reassign or bill send (each writes one of those rows) waits for this
    // approval to commit, or this read waits for it — either way the rules see the final facts.
    const lock = m ? { lock: { mode: 'pessimistic_read' as const } } : {};
    const assignment = m
      ? await m.findOne(AssignmentEntity, { where: { id: expense.assignmentId }, ...lock })
      : await this.assignmentRepository.findOne({
          where: { id: expense.assignmentId },
          select: ['id', 'assignmentNumber', 'status', 'assayerId'],
        });
    if (!assignment) throw new NotFoundException(`Assignment ${expense.assignmentId} not found.`);
    const feePayable = m
      ? await m.findOne(AssayerPayableEntity, {
          where: { assignmentId: expense.assignmentId, expenseId: IsNull(), status: Not(In([...DEAD_PAYABLE_STATUSES])) },
        })
      : await this.billing.liveFeePayable(expense.assignmentId);
    const billId = liveFeeBillId(feePayable);
    const bill = billId
      ? m
        ? await m.findOne(AssayerInvoiceEntity, { where: { id: billId }, ...lock })
        : await this.assayerInvoiceRepository.findOne({ where: { id: billId }, select: ['id', 'status'] })
      : null;
    return evaluateExpenseApproval(assignment, expense, feePayable, bill?.status ?? null);
  }

  /**
   * Allowed → null. Refused → an override if a senior wrote a real reason, else the refusal:
   *   no reason          409, the rule's own code (`EXPENSE_APPROVAL_*`), naming which applies
   *   not a senior       403 EXPENSE_APPROVAL_OVERRIDE_NOT_PERMITTED
   *   reason too short   400 OVERRIDE_REASON_REQUIRED
   */
  private async resolveApprovalRules(
    expense: Pick<ExpenseEntity, 'assignmentId' | 'assayerId'>,
    request: ExpenseApprovalOverrideRequest | undefined,
  ): Promise<{ reason: string; codes: string[] } | null> {
    const decision = await this.approvalDecision(expense);
    if (decision.allowed) return null;

    const reason = (request?.reason ?? '').trim();
    if (!reason) {
      throw withCode(new ConflictException(decision.reason), decision.code as any);
    }
    if (!request?.mayOverride) {
      throw withCode(
        new ForbiddenException(
          `Only a senior can approve this claim anyway. ${decision.blocks.map((b) => b.reason).join(' ')}`,
        ),
        OTHER_CONFLICT_ERROR_CODES.EXPENSE_APPROVAL_OVERRIDE_NOT_PERMITTED,
      );
    }
    if (reason.length < EXPENSE_APPROVAL_OVERRIDE_MIN_REASON) {
      throw withCode(
        new BadRequestException(
          `Approving this claim anyway needs a reason of at least ${EXPENSE_APPROVAL_OVERRIDE_MIN_REASON} characters saying why.`,
        ),
        ASSIGNMENT_ERROR_CODES.OVERRIDE_REASON_REQUIRED,
      );
    }
    return { reason, codes: decision.blocks.map((b) => b.code) };
  }
}
