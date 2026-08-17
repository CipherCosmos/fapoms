import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Between, EntityManager } from 'typeorm';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { isUniqueViolation } from '../../infrastructure/database/unique-violation';
import { BillingEntryEntity } from './billing-entry.entity';
import { BillingInvoiceEntity } from './invoice.entity';
import { BillingPaymentEntity } from './payment.entity';
import { AssayerPayableEntity } from './payable.entity';
import { BillingConflictEntity } from './conflict.entity';
import { BillingHistoryEntity } from './history.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectEntity } from '../project/project.entity';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { CacheService } from '../../infrastructure/cache/cache.service';
import {
  NotificationDispatchService,
  EmitOptions,
} from '../notifications/notification-dispatch.service';
import {
  BillingLevel,
  BillingState,
  PaymentState,
  InvoiceStatus,
  InvoiceType,
  PaymentStatus,
  PaymentMethod,
  PaymentDirection,
  AssayerPayableStatus,
  BillingConflictStatus,
  BillingConflictSeverity,
  BillingEntityType,
  BillingPricingModel,
  AssignmentStatus,
} from '@fapoms/shared';
import {
  BILLING_STATE_TRANSITIONS,
  INVOICE_TRANSITIONS,
  PAYMENT_STATE_TRANSITIONS,
  PAYABLE_TRANSITIONS,
  isValidTransition,
} from '@fapoms/shared';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { payableCost, entryRevenue, totalPayableCost, totalEntryRevenue, margin, assignmentFee, applyTaxes } from './billing-money';
import type { ProgressCallback } from '../../infrastructure/queue/queued-job';

export interface CreateEntryDto {
  level: BillingLevel;
  clientId: string;
  projectId?: string;
  assignmentId?: string;
  assayerId?: string;
  pricingModel?: BillingPricingModel;
  rate?: number;
  quantity?: number;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  description?: string;
  baseAmount?: number;
  travelAmount?: number;
  adjustmentAmount?: number;
  discountAmount?: number;
  taxRate?: number;
  tdsRate?: number;
  currency?: string;
  initialState?: BillingState;
}

export interface SplitEntryDto {
  amounts: number[];
  notes?: string;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Rounding slack when comparing money. Two figures within this are equal. */
const MONEY_EPSILON = 0.01;

/**
 * One page of a billing list, and the size of the set it was cut from.
 *
 * `total` is the count across ALL pages, not the length of `items` — the client needs it to
 * draw a pager and to say "50 of 85,733", and it is the only figure that stays right when the
 * window moves.
 */
export interface BillingPage<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

/** Rows returned when a caller names no window. */
const BILLING_PAGE_DEFAULT = 50;

/**
 * The most rows any single billing list request can return.
 *
 * This clamp is the whole point of the change. Every list on this service used to run an
 * unbounded `find()`: `GET /billing-engine/entries` with no filters returned one row per
 * completed assignment — 85,733 on the scale book, and one of EIGHT queries the Billing page
 * fires on mount. A ceiling that the caller cannot raise is what stops a future `?limit=999999`
 * from quietly restoring exactly the behaviour being removed here.
 */
const BILLING_PAGE_MAX = 100;

/**
 * Resolve a `page`/`limit` pair into a clamped window.
 *
 * There is no shared paginator in this codebase — `document.service.ts`, `feedback.service.ts`
 * and `validation.service.ts` each clamp inline in the same shape — so this follows that local
 * convention rather than introducing a cross-cutting abstraction the rest of the repo would
 * not use. Junk input (`limit=abc`, `page=-3`, `limit=0`) resolves to the default rather than
 * to `NaN`, which as an OFFSET makes Postgres reject the query outright.
 */
function billingPageWindow(page?: number | string, limit?: number | string): { skip: number; take: number; page: number; limit: number } {
  const safeLimit = Math.min(BILLING_PAGE_MAX, Math.max(1, Number(limit) || BILLING_PAGE_DEFAULT));
  const safePage = Math.max(1, Math.trunc(Number(page)) || 1);
  return { skip: (safePage - 1) * safeLimit, take: safeLimit, page: safePage, limit: safeLimit };
}

/** Work that is real revenue but has not reached an invoice yet. */
const UNBILLED_STATES: BillingState[] = [
  BillingState.PENDING_BILLING,
  BillingState.READY_FOR_BILLING,
  BillingState.DRAFT,
  BillingState.SUBMITTED,
  BillingState.UNDER_REVIEW,
  BillingState.APPROVED,
];

/**
 * How often the backfill reports progress, in assignments.
 *
 * Each report is a Redis round trip. At one per row a 200,000-assignment scan would spend more
 * time telling the caller what it was doing than doing it; at one per 500 the poll endpoint still
 * moves visibly on any book large enough for the wait to matter.
 */
const SYNC_PROGRESS_INTERVAL = 500;

@Injectable()
/**
 * A second root billing entry for an assignment was refused by the database.
 * A ConflictException (409) for API callers; a distinguishable type for the auto-sync paths,
 * which treat it as "the other sync won" rather than as an error.
 */
export class DuplicateBillingEntryError extends ConflictException {
  constructor() {
    super('This assignment already has a billing entry. Adjust or split the existing line rather than creating a second one.');
  }
}

/** A second fee payable for an assignment was refused by the database. See DuplicateBillingEntryError. */
export class DuplicateFeePayableError extends ConflictException {
  constructor() {
    super('This assignment already has a fee payable. Record an adjustment or an expense reimbursement rather than a second fee.');
  }
}

export class BillingEngineService implements OnModuleInit {
  private readonly logger = new Logger(BillingEngineService.name);

  constructor(
    @InjectRepository(BillingEntryEntity)
    private readonly entryRepository: Repository<BillingEntryEntity>,
    @InjectRepository(BillingInvoiceEntity)
    private readonly invoiceRepository: Repository<BillingInvoiceEntity>,
    @InjectRepository(BillingPaymentEntity)
    private readonly paymentRepository: Repository<BillingPaymentEntity>,
    @InjectRepository(AssayerPayableEntity)
    private readonly payableRepository: Repository<AssayerPayableEntity>,
    @InjectRepository(BillingConflictEntity)
    private readonly conflictRepository: Repository<BillingConflictEntity>,
    @InjectRepository(BillingHistoryEntity)
    private readonly historyRepository: Repository<BillingHistoryEntity>,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly cache: CacheService,
    private readonly uow: UnitOfWork,
    private readonly notificationDispatch: NotificationDispatchService,
    private readonly settings: PlatformSettingsService,
  ) {}

  /**
   * Branch label for a billing row, resolved the same way `resolveNames` does it —
   * assignments carry the project-branch link, billing rows only carry the assignment.
   */
  private async billingBranchName(assignmentId?: string | null): Promise<string> {
    if (!assignmentId) return 'a branch';
    const rows = await this.entryRepository.manager.query(
      `SELECT b.name AS branch_name
         FROM assignments a
         LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
         LEFT JOIN branches b ON b.id = pb.branch_id
        WHERE a.id = $1`,
      [assignmentId],
    );
    return rows?.[0]?.branch_name ?? 'a branch';
  }

  /**
   * Fire-and-forget a notification whose body needs a branch label.
   *
   * Detached on purpose: the label costs a join, and neither that query nor the dispatch
   * may be allowed to fail a payment or an approval that has already committed. Call sites
   * invoke this only after `inTx` has returned, so nothing here can roll money back.
   */
  private notifyWithBranch(
    assignmentId: string | null | undefined,
    build: (branchName: string) => EmitOptions,
  ): void {
    void this.billingBranchName(assignmentId)
      .then((branchName) => this.notificationDispatch.emitSafe(build(branchName)))
      .catch((err) =>
        this.logger.error(`Billing notification skipped: ${(err as Error).message}`),
      );
  }

  // -----------------------------------------------------------------------
  // Transaction + row-locking primitives
  //
  // Every method in this file that moves money or changes a billing state runs
  // inside `inTx`. Before this, each of them was a sequence of independent
  // autocommitted saves: `recordPayment` wrote the payment row, then the invoice,
  // then one row per entry — 2+N separate transactions. A crash, a statement
  // timeout or a lost connection anywhere in that sequence left the ledger in a
  // state no code could produce deliberately: a payment recorded against an
  // unadjusted invoice, or an invoice marked PAID whose entries still showed the
  // full amount outstanding. Nothing detected it and nothing could repair it,
  // because there was no record of how far the sequence had got.
  // -----------------------------------------------------------------------

  /**
   * Run `work` in one database transaction, releasing its domain events only after commit.
   *
   * The isolation level and the after-COMMIT event ordering now live in `UnitOfWork`, so this
   * is a name rather than a mechanism — kept because the 16 call sites below read better as
   * `inTx` than as `uow.run`, and because it keeps the locking helpers and the boundary they
   * depend on adjacent in the file.
   */
  private inTx<T>(
    work: (
      manager: EntityManager,
      emit: (event: string, payload: Record<string, unknown>) => void,
    ) => Promise<T>,
  ): Promise<T> {
    return this.uow.run(work);
  }

  /**
   * Load one billing entry with a write lock held for the rest of the transaction.
   *
   * `@VersionColumn()` has been on every one of these entities since the beginning and has
   * never protected anything: TypeORM only compares versions when a caller explicitly asks
   * for an optimistic lock, and no call site here ever did. The column incremented and the
   * lost update happened anyway.
   *
   * A write lock is also the better fit than fixing that. Optimistic locking would let the
   * second writer evaluate every guard against stale data and only then reject it. A lock
   * makes the second writer wait and then evaluate the guards against what actually
   * committed — so a transition that has become invalid, or a payment that would now
   * overpay, is refused for the right reason instead of being refused as a version clash.
   */
  private async lockEntry(manager: EntityManager, entryId: string): Promise<BillingEntryEntity> {
    const entry = await manager.findOne(BillingEntryEntity, {
      where: { id: entryId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!entry) throw new NotFoundException(`Billing entry ${entryId} not found.`);
    return entry;
  }

  /**
   * Write-lock a set of entries, acquired in a stable order.
   *
   * The ordering is what keeps two overlapping operations from deadlocking: if a payment
   * against invoice X and a merge both touch entries {A, B}, both take A before B and one
   * simply waits. Without it they can take them in opposite orders and Postgres kills one
   * with a deadlock (40P01).
   *
   * This makes the common deadlock impossible rather than merely unlikely — the executor
   * is free to lock in scan order, so a 40P01 remains theoretically reachable. It surfaces
   * as a failed request with the whole transaction rolled back, never as half-applied money.
   */
  private async lockEntriesById(
    manager: EntityManager,
    entryIds: string[],
  ): Promise<BillingEntryEntity[]> {
    if (!entryIds.length) return [];
    return manager
      .createQueryBuilder(BillingEntryEntity, 'e')
      .setLock('pessimistic_write')
      .where('e.id IN (:...entryIds)', { entryIds })
      .orderBy('e.id', 'ASC')
      .getMany();
  }

  /** Write-lock every entry attached to an invoice, in the same stable order. */
  private async lockEntriesByInvoice(
    manager: EntityManager,
    invoiceId: string,
  ): Promise<BillingEntryEntity[]> {
    return manager
      .createQueryBuilder(BillingEntryEntity, 'e')
      .setLock('pessimistic_write')
      .where('e.invoice_id = :invoiceId', { invoiceId })
      .orderBy('e.id', 'ASC')
      .getMany();
  }

  /**
   * Write-lock one invoice, without its relations.
   *
   * Postgres refuses `FOR UPDATE` on the nullable side of an outer join, and `getInvoice`
   * eager-loads `entries` and `payments` as LEFT JOINs — so locking and loading have to be
   * two steps. Entries are locked separately by `lockEntriesByInvoice`.
   */
  private async lockInvoice(
    manager: EntityManager,
    invoiceId: string,
  ): Promise<BillingInvoiceEntity> {
    const invoice = await manager.findOne(BillingInvoiceEntity, {
      where: { id: invoiceId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!invoice) throw new NotFoundException(`Invoice ${invoiceId} not found.`);
    return invoice;
  }

  /** Write-lock one assayer payable. */
  private async lockPayable(
    manager: EntityManager,
    payableId: string,
  ): Promise<AssayerPayableEntity> {
    const payable = await manager.findOne(AssayerPayableEntity, {
      where: { id: payableId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!payable) throw new NotFoundException(`Payable ${payableId} not found.`);
    return payable;
  }

  /** Auto-sync: when an assignment completes, create its billing entry automatically. */
  onModuleInit() {
    this.eventPublisher.subscribe('assignment:status-changed', async (payload: any) => {
      const newState = payload?.newState;
      if (newState !== AssignmentStatus.COMPLETED && newState !== AssignmentStatus.IN_PROGRESS && newState !== AssignmentStatus.CHECKED_IN) {
        return;
      }
      const assignmentId = payload?.assignmentId;
      if (!assignmentId) return;

      // Serialize concurrent syncs for the SAME assignment across all replicas. The event
      // bus can deliver two status changes back-to-back (e.g. IN_PROGRESS then COMPLETED),
      // and without this their check-then-create in syncAssignment / syncPayableForAssignment
      // can interleave into a duplicate billing entry AND payable — a double-bill and a
      // double-pay. Fail-open: if Redis is unavailable, the "already billed / already exists"
      // guards inside the sync methods remain the correctness backstop.
      await this.cache.withLock(`lock:billing:sync:${assignmentId}`, 30, async () => {
        try {
          const result = await this.syncAssignment(assignmentId);
          if (result.created) {
            this.logger.log(`Auto-billed completed assignment ${assignmentId} (entry ${result.entryId}).`);
          }
        } catch (err) {
          this.logger.error(`Auto-bill failed for assignment ${assignmentId}: ${(err as Error).message}`);
        }
        // Cost leg, recorded from the same event so revenue and cost can never drift
        // apart. Failure here must not roll back the receivable above, hence separate.
        try {
          const payable = await this.syncPayableForAssignment(assignmentId);
          if (payable.created) {
            this.logger.log(`Auto-created assayer payable for assignment ${assignmentId} (payable ${payable.payableId}).`);
          }
        } catch (err) {
          this.logger.error(`Auto-payable failed for assignment ${assignmentId}: ${(err as Error).message}`);
        }
      });
    });
  }

  private seq(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private moneyOf(entry: BillingEntryEntity) {
    return {
      baseAmount: Number(entry.baseAmount),
      travelAmount: Number(entry.travelAmount),
      adjustmentAmount: Number(entry.adjustmentAmount),
      discountAmount: Number(entry.discountAmount),
      taxAmount: Number(entry.taxAmount),
      taxRate: Number(entry.taxRate),
      tdsAmount: Number(entry.tdsAmount),
      totalAmount: Number(entry.totalAmount),
      currency: entry.currency,
    };
  }

  /**
   * Recomputes tax/TDS/total from the current line values. Pure money math.
   *
   * GST is charged on the taxable value; TDS is withheld by the client from the
   * same taxable value (not from the GST). So the invoice-payable figure is
   * taxable + GST − TDS.
   */
  private recompute(entry: BillingEntryEntity): BillingEntryEntity {
    const gross = round2(Number(entry.baseAmount) + Number(entry.travelAmount) + Number(entry.adjustmentAmount));
    const taxable = round2(gross - Number(entry.discountAmount));
    // Reads the dedicated rate columns. TDS previously read `tdsAmount` — a rupee
    // figure — and divided it by 100 as though it were a percentage, which meant
    // TDS evaluated to 0 on every entry that had not already been given a TDS amount.
    const settled = applyTaxes(taxable, { taxRate: entry.taxRate, tdsRate: entry.tdsRate });
    entry.taxableAmount = taxable;
    entry.taxAmount = settled.taxAmount;
    entry.tdsAmount = settled.tdsAmount;
    entry.totalAmount = settled.totalAmount;
    return entry;
  }

  /**
   * The client's contracted billing terms. `client_billing` has held these all
   * along (payment terms, GSTIN, cycle) but the engine never read it, so every
   * line was taxed at 0% and every invoice due date had to be typed by hand.
   * Falls back to Indian audit-services defaults when a client has no billing
   * record yet rather than failing the sale.
   */
  private async clientTaxRates(
    clientId: string,
    manager?: EntityManager,
  ): Promise<{ gstRate: number; tdsRate: number; paymentTerms: string | null }> {
    const rows = await (manager ?? this.entryRepository.manager).query(
      `SELECT gst_rate, tds_rate, payment_terms FROM client_billing WHERE client_id = $1 AND is_active = true LIMIT 1`,
      [clientId],
    );
    const row = rows?.[0];
    // The client's own billing profile wins; the platform defaults below are configurable
    // rather than literals, so all three tax numbers in this file have one home and one
    // direction stated on the label. Both are snapshotted onto the entry at creation, so a
    // later change never restates an issued invoice.
    const [gstDefault, tdsDefault] = await Promise.all([
      this.settings.getNumber('billing.defaultClientGstRate', 18).catch(() => 18),
      this.settings.getNumber('billing.defaultClientTdsRate', 10).catch(() => 10),
    ]);
    return {
      gstRate: row ? Number(row.gst_rate) : gstDefault,
      tdsRate: row ? Number(row.tds_rate) : tdsDefault,
      paymentTerms: row?.payment_terms ?? null,
    };
  }

  /**
   * Turns contractual terms ("NET30", "NET45", "DUE_ON_RECEIPT") into a real due
   * date. Invoices previously defaulted to no due date at all, which left nothing
   * for ageing or overdue collection to work from.
   */
  private dueDateFromTerms(issueDate: string, terms: string | null): string {
    const days = terms ? Number(/net\s*(\d+)/i.exec(terms)?.[1] ?? 0) : 0;
    const d = new Date(`${issueDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /** Small cache: the same operator writes many history rows per request. */
  private readonly userNameCache = new Map<string, string>();

  private async resolveUserName(userId: string, manager?: EntityManager): Promise<string> {
    if (!userId || userId === 'system') return 'System (automated)';
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;
    try {
      const rows = await (manager ?? this.entryRepository.manager).query(
        `SELECT display_name FROM users WHERE id = $1 LIMIT 1`,
        [userId],
      );
      const name = rows?.[0]?.display_name ?? userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  /**
   * Append one immutable row to the money trail.
   *
   * `manager` is not optional in spirit: every caller that changes money passes the
   * transaction's manager, so the history row commits or rolls back with the change it
   * describes. Writing it on its own connection is what previously allowed a state change
   * to land with no record of who made it or what it replaced — the one thing an audit
   * trail for a bank cannot do. The parameter stays optional only for the read-only and
   * not-yet-transactional callers.
   */
  private async history(
    userId: string,
    h: Partial<BillingHistoryEntity>,
    manager?: EntityManager,
  ): Promise<BillingHistoryEntity> {
    const rec = this.historyRepository.create({
      ...h,
      // The column existed but nothing ever wrote it, so the audit trail could only
      // ever show a raw user id — useless for "who approved this invoice?".
      userName: h.userName ?? (await this.resolveUserName(userId, manager)),
      createdBy: userId,
      updatedBy: userId,
    } as BillingHistoryEntity);
    return manager ? manager.save(rec) : this.historyRepository.save(rec);
  }

  private async publish(event: string, payload: Record<string, unknown>): Promise<void> {
    try {
      this.eventPublisher.publish(event, { ...payload, timestamp: new Date() });
    } catch (err) {
      this.logger.error(`Failed to publish ${event}:`, err);
    }
  }

  // -----------------------------------------------------------------------
  // Entries + state machine
  // -----------------------------------------------------------------------

  async createEntry(dto: CreateEntryDto, userId: string): Promise<BillingEntryEntity> {
    if (!dto.clientId) throw new BadRequestException('clientId is required for any billing entry.');
    if (dto.level === BillingLevel.PROJECT && !dto.projectId) {
      throw new BadRequestException('projectId is required for PROJECT-level billing.');
    }
    if (dto.level === BillingLevel.ASSIGNMENT && !dto.assignmentId) {
      throw new BadRequestException('assignmentId is required for ASSIGNMENT-level billing.');
    }

    return this.inTx(async (m, emit) => {
      try {
        return await this.createEntryInTx(dto, userId, m, emit);
      } catch (err) {
        if (isUniqueViolation(err, 'UQ_billing_entries_root_per_assignment')) {
          throw new DuplicateBillingEntryError();
        }
        throw err;
      }
    });
  }

  private async createEntryInTx(
    dto: CreateEntryDto,
    userId: string,
    m: EntityManager,
    emit: (event: string, payload: Record<string, unknown>) => void,
  ): Promise<BillingEntryEntity> {
    {
    // Tax treatment falls back to the client's contracted rates when the caller
    // does not state them, so auto-generated lines are taxed the same as manual
    // ones instead of silently going out at 0%.
    const contract = await this.clientTaxRates(dto.clientId, m);

    const entry = this.entryRepository.create({
      entryNumber: `BE-${Date.now().toString(36).toUpperCase()}-${this.seq()}`,
      level: dto.level,
      clientId: dto.clientId,
      projectId: dto.projectId ?? null,
      assignmentId: dto.assignmentId ?? null,
      assayerId: dto.assayerId ?? null,
      pricingModel: dto.pricingModel ?? BillingPricingModel.FLAT_RATE,
      rate: dto.rate ?? null,
      quantity: dto.quantity ?? null,
      billingPeriodStart: dto.billingPeriodStart ?? null,
      billingPeriodEnd: dto.billingPeriodEnd ?? null,
      description: dto.description ?? null,
      baseAmount: dto.baseAmount ?? 0,
      travelAmount: dto.travelAmount ?? 0,
      adjustmentAmount: dto.adjustmentAmount ?? 0,
      discountAmount: dto.discountAmount ?? 0,
      taxRate: dto.taxRate ?? contract.gstRate,
      tdsRate: dto.tdsRate ?? contract.tdsRate,
      taxableAmount: 0,
      tdsAmount: 0,
      totalAmount: 0,
      currency: dto.currency ?? 'INR',
      state: dto.initialState ?? BillingState.PENDING_BILLING,
      paymentState: PaymentState.UNPAID,
      billedAmount: 0,
      paidAmount: 0,
      outstandingAmount: 0,
      disputedAmount: 0,
      cancelledAmount: 0,
      adjustedAmount: 0,
      createdBy: userId,
      updatedBy: userId,
    });
    this.recompute(entry);
    const saved = await m.save(entry);

    await this.history(userId, {
      clientId: saved.clientId,
      projectId: saved.projectId,
      assignmentId: saved.assignmentId,
      assayerId: saved.assayerId,
      entityType: BillingEntityType.ENTRY,
      entityId: saved.id,
      action: 'ENTRY_CREATED',
      fromState: null,
      toState: saved.state,
      newValue: this.moneyOf(saved),
      reason: dto.description ?? null,
    }, m);
    emit('billing:entry-created', { entryId: saved.id, level: saved.level, clientId: saved.clientId });

    // Duplicate detection fires at creation (spec §7) — never silently. It runs in the
    // same transaction as the entry it is about, so a line can never commit without the
    // conflict that flags it.
    const duplicates = await this.findDuplicates(saved, m);
    for (const dup of duplicates) {
      await this.raiseDuplicateConflict(saved, dup, userId, m, emit);
    }

    return saved;
    }
  }

  /**
   * Bridge: ingest real billable operational work into the billing engine.
   * Scans assignments that carry an agreed fee in a billable state (CHECKED_IN /
   * IN_PROGRESS / COMPLETED) and creates ASSIGNMENT-level billing entries linked
   * to the real client (via project), project, assignment and assayer.
   *
   * Idempotent: an assignment that already has a billing entry is skipped, so
   * repeated syncs never duplicate. This is the single source of truth that makes
   * the Billing page reflect real field work instead of an empty engine.
   */
  /**
   * Backfill: bring every billable assignment into the billing engine.
   *
   * ## What this had to stop doing
   *
   * It called `syncPayableForAssignment` for EVERY billable assignment before checking whether
   * anything needed doing, and that method opens with its own lookups — the assignment, its fee
   * payable, the project's client, the commercial profile. Three to four queries each, run for
   * assignments that were fully billed months ago, on every invocation. At the 200k assignments
   * the scale database holds, one press of the Sync button was on the order of 800,000 queries
   * against a twenty-connection pool, inside a single HTTP request.
   *
   * Both legs now pre-load what already exists — receivable entries and fee payables — as two
   * set queries, and an assignment that has both is skipped before any per-assignment work. On a
   * settled book, which is the normal state, that is two queries and no loop at all.
   *
   * `onProgress` is optional so the queued path can report "1,240 / 200,000 scanned" while the
   * synchronous path (small books, and the tests) stays a plain call.
   */
  async syncFromAssignments(
    userId: string,
    onProgress?: ProgressCallback,
  ): Promise<{
    scanned: number;
    created: number;
    skipped: number;
    payablesCreated: number;
    errors: Array<{ assignmentId: string; reason: string }>;
  }> {
    const billableStates = [
      AssignmentStatus.CHECKED_IN,
      AssignmentStatus.IN_PROGRESS,
      AssignmentStatus.COMPLETED,
    ];

    const assignments = await this.assignmentRepository.find({
      where: { status: In(billableStates) },
      select: ['id', 'assignmentNumber', 'status', 'projectId', 'assayerId', 'agreedFee', 'completionDate'],
    });

    // Already-billed assignments (any state, so re-approval never double-charges).
    const existing = await this.entryRepository.find({ select: ['assignmentId'] });
    const existingIds = new Set(existing.filter((e) => e.assignmentId).map((e) => e.assignmentId as string));

    /**
     * Assignments that already carry a fee payable.
     *
     * The predicate is the one the database enforces uniqueness on
     * (`UQ_assayer_payables_fee_per_assignment`): a payable counts as the fee payable unless it
     * is an expense reimbursement, which is marked `rate_snapshot.source = 'EXPENSE_CLAIM'` and
     * of which there can legitimately be several. Deriving the skip set from the same predicate
     * as the constraint is what stops this loop from either re-doing settled work or, worse,
     * treating a reimbursement as proof the fee was already raised.
     */
    const payableRows: Array<{ assignment_id: string }> = await this.payableRepository
      .createQueryBuilder('p')
      .select('p.assignment_id', 'assignment_id')
      .where('p.assignment_id IS NOT NULL')
      .andWhere(`(p.rate_snapshot->>'source') IS DISTINCT FROM 'EXPENSE_CLAIM'`)
      .getRawMany();
    const existingPayableIds = new Set(payableRows.map((r) => r.assignment_id));

    // Resolve clientId for each project involved.
    const projectIds = [...new Set(assignments.map((a) => a.projectId))];
    const projects = projectIds.length
      ? await this.projectRepository.find({ where: { id: In(projectIds) }, select: ['id', 'clientId'] })
      : [];
    const projectClient = new Map(projects.map((p) => [p.id, p.clientId]));

    const created: BillingEntryEntity[] = [];
    const errors: Array<{ assignmentId: string; reason: string }> = [];
    let skipped = 0;
    let payablesCreated = 0;
    let scanned = 0;

    for (const a of assignments) {
      scanned += 1;
      // Report every so often rather than every row: a progress write is a Redis round trip,
      // and 200,000 of them would cost more than the work being reported on.
      if (onProgress && scanned % SYNC_PROGRESS_INTERVAL === 0) {
        await onProgress(scanned, assignments.length, `Scanned ${scanned} of ${assignments.length} assignments`);
      }

      const hasEntry = existingIds.has(a.id);
      const hasPayable = existingPayableIds.has(a.id);

      // Nothing owed on either leg. This is the overwhelming majority of a settled book, and
      // skipping it here — before syncPayableForAssignment's own lookups — is the whole point.
      if (hasEntry && hasPayable) {
        skipped += 1;
        continue;
      }

      if (!hasPayable) {
        // Backfills the cost leg for work completed before payables were automated,
        // independently of whether the receivable already exists.
        try {
          const payable = await this.syncPayableForAssignment(a.id, userId);
          if (payable.created) payablesCreated += 1;
        } catch (err) {
          errors.push({ assignmentId: a.id, reason: `payable: ${(err as Error).message}` });
        }
      }

      if (hasEntry) { skipped += 1; continue; }
      const clientId = projectClient.get(a.projectId);
      if (!clientId) { errors.push({ assignmentId: a.id, reason: 'no project/client mapping' }); continue; }
      const fee = assignmentFee(a, 'REVENUE').fee;
      if (fee <= 0) { errors.push({ assignmentId: a.id, reason: 'no agreed fee' }); continue; }

      try {
        const entry = await this.createEntryFromAssignment(a, clientId, userId);
        created.push(entry);
      } catch (err) {
        errors.push({ assignmentId: a.id, reason: (err as Error).message });
      }
    }

    if (created.length > 0 || payablesCreated > 0) {
      this.logger.log(`Billing sync: ${created.length} receivable entries, ${payablesCreated} assayer payables.`);
    }

    if (onProgress) {
      await onProgress(assignments.length, assignments.length, 'Complete');
    }

    return {
      scanned: assignments.length,
      created: created.length,
      skipped,
      payablesCreated,
      errors,
    };
  }

  /**
   * Creates a billing entry for a single assignment. Used by the auto-sync
   * subscription (assignment:status-changed → COMPLETED). Idempotent: returns
   * { created: false } if the assignment is already billed or not billable.
   */
  async syncAssignment(assignmentId: string): Promise<{ created: boolean; entryId?: string; reason?: string }> {
    const a = await this.assignmentRepository.findOne({ where: { id: assignmentId } });
    if (!a) return { created: false, reason: 'assignment not found' };

    const alreadyBilled = await this.entryRepository.findOne({ where: { assignmentId } });
    if (alreadyBilled) {
      // The entry was opened while the audit was still running. Now that the work
      // is delivered it becomes billable — without this the line would sit in
      // PENDING_BILLING forever and the revenue would never be invoiced.
      if (a.status === AssignmentStatus.COMPLETED && alreadyBilled.state === BillingState.PENDING_BILLING) {
        await this.transitionEntry(alreadyBilled.id, BillingState.READY_FOR_BILLING, 'system', 'Assignment completed — work delivered.');
        return { created: false, entryId: alreadyBilled.id, reason: 'promoted to READY_FOR_BILLING' };
      }
      return { created: false, reason: 'already billed' };
    }

    const clientId = a.projectId
      ? (await this.projectRepository.findOne({ where: { id: a.projectId }, select: ['id', 'clientId'] }))?.clientId
      : undefined;
    if (!clientId) return { created: false, reason: 'no project/client mapping' };

    const fee = assignmentFee(a, 'REVENUE').fee;
    if (fee <= 0) return { created: false, reason: 'no agreed fee' };

    try {
      const entry = await this.createEntryFromAssignment(a, clientId, 'system');
      return { created: true, entryId: entry.id };
    } catch (err) {
      // Two syncs raced between the find above and this insert — the event bus delivers
      // at-least-once and the lock around us fails open. The database's unique index on root
      // entries per assignment (migration 1790500000000) is the real guard; the loser simply
      // reports what the winner did. This is the double-invoice-line the audit found.
      if (err instanceof DuplicateBillingEntryError || isUniqueViolation(err, 'UQ_billing_entries_root_per_assignment')) {
        const winner = await this.entryRepository.findOne({ where: { assignmentId } });
        return { created: false, entryId: winner?.id, reason: 'already billed (concurrent sync)' };
      }
      throw err;
    }
  }

  /**
   * The cost side of the same assignment: what we owe the assayer who did the work.
   *
   * This half of the engine existed as a manual data-entry form only — nothing in
   * the system ever created a payable, so completed field work produced client
   * receivables while the corresponding assayer cost stayed invisible. Since the
   * platform's whole purpose is optimising cost per audit, the cost leg has to be
   * captured automatically from the same operational event as the revenue leg.
   *
   * Idempotent per assignment.
   */
  async syncPayableForAssignment(assignmentId: string, userId = 'system'): Promise<{ created: boolean; payableId?: string; reason?: string }> {
    const a = await this.assignmentRepository.findOne({ where: { id: assignmentId } });
    if (!a) return { created: false, reason: 'assignment not found' };
    if (a.status !== AssignmentStatus.COMPLETED) return { created: false, reason: 'assignment not completed' };
    if (!a.assayerId) return { created: false, reason: 'no assayer on assignment' };

    // The FEE payable only. Expense reimbursements are also payables against this assignment
    // (one per approved claim, marked rate_snapshot.source = 'EXPENSE_CLAIM'); a claim approved
    // before completion must not make the fee itself look "already paid" — that would leave the
    // assayer's fee never raised.
    const existing = await this.findFeePayable(assignmentId);
    if (existing) return { created: false, reason: 'payable already exists', payableId: existing.id };

    // The agreed fee is what the assayer negotiated and accepted for this job.
    const resolvedFee = assignmentFee(a, 'COST');
    const fee = resolvedFee.fee;
    if (fee <= 0) return { created: false, reason: 'no agreed fee' };

    const clientId = a.projectId
      ? (await this.projectRepository.findOne({ where: { id: a.projectId }, select: ['id', 'clientId'] }))?.clientId
      : undefined;

    const profile = await this.payableRepository.manager.query(
      `SELECT base_fee, travel_reimbursement, daily_rate, currency
         FROM assayer_commercial_profiles
        WHERE assayer_id = $1 AND is_active = true
          AND (effective_end_date IS NULL OR effective_end_date >= NOW())
        ORDER BY effective_start_date DESC LIMIT 1`,
      [a.assayerId],
    );
    const rateCard = profile?.[0] ?? null;

    /**
     * The agreed fee already CONTAINS travel — the quote that became `proposedFee` was
     * base + travel, and the mobile app tells the assayer so in as many words ("Your fee for
     * this assignment already includes ₹X for travel"). Assignments now record that travel
     * component at offer time (`quotedTravelFee`), so the payable can carve the agreed total
     * into base and travel instead of paying the fee whole AND adding the commercial
     * profile's flat travel reimbursement on top — which paid travel twice for any assayer
     * whose profile carried one.
     *
     * The carve keeps gross = agreed fee exactly: negotiation moves the total, and whatever
     * was negotiated lands in the base component while the travel attribution stays what was
     * quoted (clamped so a fee negotiated below the travel figure can never produce a
     * negative base). Offers made before the column existed keep the legacy behaviour —
     * their fee's travel share is unknowable, and restating history is worse than the known
     * flaw.
     */
    const quotedTravel = a.quotedTravelFee != null ? Number(a.quotedTravelFee) : null;
    const travel = quotedTravel != null
      ? Math.min(Math.max(0, quotedTravel), fee)
      : (rateCard ? Number(rateCard.travel_reimbursement ?? 0) : 0);
    const base = quotedTravel != null ? fee - travel : fee;

    let payable: AssayerPayableEntity;
    try {
      payable = await this.createPayable({
        assayerId: a.assayerId,
        clientId: clientId ?? undefined,
        projectId: a.projectId ?? undefined,
        assignmentId: a.id,
        baseAmount: base,
        travelAmount: travel,
        // Assayers are professional-service vendors: TDS is withheld from what we pay
        // them, and no GST is added on our side unless they are registered. The withholding
        // rate is configurable — it is set by tax law, which changes without this code changing
        // — and it is captured on each payable, so a later change never restates an old one.
        taxRate: 0,
        tdsRate: await this.settings.getNumber('billing.tdsRate', 10).catch(() => 10),
        // The snapshot must justify the amount actually booked. The payable is booked at the
        // assignment's agreed fee, so `baseFee` here is that fee — not the assayer's standard
        // profile rate, which was recorded before and disagreed with every payable (base_amount
        // 2000 against a snapshot claiming 3406). The standard profile rate is kept alongside as
        // context, clearly labelled, so "why did we pay this?" resolves to the agreed fee and the
        // profile it was compared against, both immutable on the payable.
        rateSnapshot: {
          source: quotedTravel != null
            ? 'assignment.agreedFee split by assignment.quotedTravelFee'
            : 'assignment.agreedFee',
          baseFee: base,
          travelReimbursement: travel,
          agreedFee: fee,
          proposedFee: a.proposedFee != null ? Number(a.proposedFee) : null,
          quotedTravelFee: quotedTravel,
          quotedTransportMode: a.quotedTransportMode ?? null,
          profileStandardBaseFee: rateCard ? Number(rateCard.base_fee) : null,
          profileTravelReimbursement: rateCard ? Number(rateCard.travel_reimbursement ?? 0) : null,
          profileDailyRate: rateCard ? Number(rateCard.daily_rate) : null,
          capturedAt: new Date().toISOString(),
        },
        remarks: `Auto-generated on completion of ${a.assignmentNumber}.`,
      }, userId);
    } catch (err) {
      // Same race as syncAssignment: at-least-once delivery under a fail-open lock. The
      // unique index on fee payables per assignment (migration 1790500000000) is the guard
      // against a double payout; the loser reports the winner.
      if (err instanceof DuplicateFeePayableError || isUniqueViolation(err, 'UQ_assayer_payables_fee_per_assignment')) {
        const winner = await this.findFeePayable(assignmentId);
        return { created: false, reason: 'payable already exists (concurrent sync)', payableId: winner?.id };
      }
      throw err;
    }

    /**
     * The one-sided-ledger guard.
     *
     * A payable can be booked from the *proposed* fee when no agreed one exists, while the
     * client-billing side refuses an entry without an agreed fee. So this exact case books the
     * cost and never the revenue: the assayer is paid, the client is never invoiced, and margin
     * is quietly short by the whole job with nothing anywhere saying so.
     *
     * Every accept path writes `agreedFee`, so this should be unreachable — which is precisely
     * why it needs to be loud rather than trusted. Raised as a conflict against the payable that
     * was just written, so it lands on the billing desk's existing exception queue instead of
     * being discovered at month end.
     */
    if (!resolvedFee.settled) {
      await this.raiseConflict({
        severity: BillingConflictSeverity.CRITICAL,
        entityType: BillingEntityType.PAYABLE,
        entryIds: [payable.id],
        description:
          `${a.assignmentNumber} was paid ${'\u20B9'}${fee} from its PROPOSED fee — no fee was ever agreed. ` +
          `The client will NOT be billed for this assignment, so its full cost falls to margin.`,
        reason: 'ASSIGNMENT_COMPLETED_WITHOUT_AGREED_FEE',
        blocksBilling: false,
      }, userId).catch((err) => {
        // Never let the guard's own failure lose the payable that was already written.
        this.logger.error(
          `Payable ${payable.id} was booked from an unagreed fee and the conflict could not be ` +
          `raised: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    return { created: true, payableId: payable.id };
  }

  /**
   * The fee payable for an assignment — never a reimbursement.
   *
   * Reimbursements are payables against the same assignment (one per approved expense claim),
   * marked `rate_snapshot.source = 'EXPENSE_CLAIM'`. The predicate here is the same one the
   * database enforces uniqueness on (`UQ_assayer_payables_fee_per_assignment`), so "does the fee
   * payable exist" and "may another be inserted" can never disagree.
   */
  private findFeePayable(assignmentId: string): Promise<AssayerPayableEntity | null> {
    return this.payableRepository
      .createQueryBuilder('p')
      .where('p.assignment_id = :assignmentId', { assignmentId })
      .andWhere(`(p.rate_snapshot->>'source') IS DISTINCT FROM 'EXPENSE_CLAIM'`)
      .orderBy('p.created_at', 'ASC')
      .getOne();
  }

  private async createEntryFromAssignment(a: AssignmentEntity, clientId: string, userId: string): Promise<BillingEntryEntity> {
    const assayerFee = assignmentFee(a, 'REVENUE').fee;
    // What the CLIENT is billed comes from the client's own contracted rate card, not from
    // what the assayer was paid. Billing the client the assayer's fee made revenue equal cost
    // on every audit — margin was structurally zero. The spread between this rate and the
    // assayer's fee is the margin the business earns.
    //
    // Falls back to the assayer fee only when the client has set no rate, so an unconfigured
    // client keeps the old pass-through behaviour rather than being billed a platform default
    // that might sit below cost. The Client Billing Settings page is where this rate is set.
    const clientBase = await this.clientContractedBaseFor(clientId);
    // Travel paid to the assayer is recovered from the client when their contract
    // says it is rechargeable. Without this the assayer's travel was a pure cost
    // absorbed on every job — the reason completed audits showed a negative margin
    // exactly equal to the travel reimbursement.
    const travel = await this.rechargeableTravelFor(a, clientId);
    /**
     * The two rates mean different things, and the base has to match the one in play.
     *
     * A client's contracted rate is a travel-exclusive audit fee, so `base + travel` is the
     * correct invoice. The assayer fee is not: the agreed fee already CONTAINS travel (see the
     * payable carve above, which splits the same figure into base + travel). Passing it through
     * whole and then adding `travel` again billed the client for the journey twice — and the
     * duplicate surfaced as margin, since revenue exceeded cost by exactly the travel amount, so
     * the error read as profit rather than as a fault.
     *
     * On the fallback path we therefore carve the fee the same way the payable does, which keeps
     * a genuine pass-through: base + travel === the agreed fee. Offers made before
     * `quotedTravelFee` existed have no knowable split, so they keep the whole fee as base and
     * `rechargeableTravelFor` returns the legacy profile figure for them.
     */
    const fee = clientBase ?? (a.quotedTravelFee != null ? Math.max(0, assayerFee - travel) : assayerFee);
    // Only finished work is billable-ready. An assignment still CHECKED_IN or
    // IN_PROGRESS is real revenue in the making, but invoicing it before the audit
    // is delivered would bill the client for work not yet done — so it is recorded
    // as PENDING_BILLING and promoted when the assignment completes.
    const isComplete = a.status === AssignmentStatus.COMPLETED;
    return this.createEntry({
      level: BillingLevel.ASSIGNMENT,
      clientId,
      projectId: a.projectId,
      assignmentId: a.id,
      assayerId: a.assayerId,
      pricingModel: BillingPricingModel.PER_ASSIGNMENT,
      baseAmount: fee,
      travelAmount: travel,
      // taxRate/tdsRate intentionally omitted so the client's contracted rates apply.
      billingPeriodEnd: a.completionDate ? this.toISO(a.completionDate) : undefined,
      description: clientBase != null
        ? `Auto-synced from ${a.assignmentNumber} (${a.status}) — billed at client contracted rate`
        : `Auto-synced from ${a.assignmentNumber} (${a.status}) — no client rate set, billed at assayer cost`,
      initialState: isComplete ? BillingState.READY_FOR_BILLING : BillingState.PENDING_BILLING,
    }, userId);
  }

  /**
   * The client's contracted per-audit base fee, or null when they have not set one.
   *
   * This is the client rate card (client_configurations.default_base_fee), distinct from the
   * assayer's commercial profile. Reading it here keeps the client-billed amount independent of
   * the assayer's cost, which is what produces a real margin.
   */
  private async clientContractedBaseFor(clientId: string): Promise<number | null> {
    const rows = await this.entryRepository.manager.query(
      `SELECT cc.default_base_fee
         FROM client_configurations cc
        WHERE cc.client_id = $1
        LIMIT 1`,
      [clientId],
    ).catch(() => []);
    const value = rows?.[0]?.default_base_fee;
    return value != null && Number(value) > 0 ? Number(value) : null;
  }

  /**
   * Travel we can recharge to the client for this assignment.
   *
   * Controlled per client by `planningPreferences.rechargeTravel` (default true):
   * some contracts are all-inclusive, in which case travel stays our cost and
   * must not appear on the client's invoice.
   */
  private async rechargeableTravelFor(a: AssignmentEntity, clientId: string): Promise<number> {
    const rows = await this.entryRepository.manager.query(
      `SELECT planning_preferences FROM clients WHERE id = $1 LIMIT 1`, [clientId],
    ).catch(() => []);
    const prefs = rows?.[0]?.planning_preferences ?? {};
    if (prefs?.rechargeTravel === false) return 0;

    // Mirrors what the assayer is actually reimbursed, so the recharge and the cost cannot
    // drift apart. That is the quoted travel component of the fee when the offer recorded one
    // — the same figure the payable now carves out — and the legacy flat profile
    // reimbursement for offers that predate the column.
    if (a.quotedTravelFee != null) {
      // COST, not REVENUE: this clamp exists to mirror the payable, so it has to resolve the fee
      // the same way the payable does or the recharge could exceed what we actually paid out.
      const fee = assignmentFee(a, 'COST').fee;
      return Math.min(Math.max(0, Number(a.quotedTravelFee)), fee > 0 ? fee : Number(a.quotedTravelFee));
    }

    const profile = await this.payableRepository.manager.query(
      `SELECT travel_reimbursement
         FROM assayer_commercial_profiles
        WHERE assayer_id = $1 AND is_active = true
          AND (effective_end_date IS NULL OR effective_end_date >= NOW())
        ORDER BY effective_start_date DESC LIMIT 1`,
      [a.assayerId],
    ).catch(() => []);
    return Number(profile?.[0]?.travel_reimbursement ?? 0);
  }

  private toISO(d: Date | string): string {
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    return String(d).slice(0, 10);
  }

  /**
   * Move one billing entry to a new state.
   *
   * The read, the three guards and the write are now one atomic, serialized unit. They used
   * to be a read-modify-write on an unlocked row: two operators approving the same entry
   * both read `SUBMITTED`, both found the transition valid, and both wrote — the second
   * silently overwriting the first, with two history rows claiming to describe the same
   * change from the same starting state. Worse, the conflict-freeze check below could pass
   * against a conflict raised microseconds later, letting a disputed line be invoiced.
   *
   * Holding the row lock across the guards is the point: the entry cannot change between
   * "is this transition legal?" and "apply it".
   */
  async transitionEntry(entryId: string, targetState: BillingState, userId: string, reason?: string): Promise<BillingEntryEntity> {
    return this.inTx(async (m, emit) => {
      const { saved } = await this.transitionEntryLocked(m, emit, entryId, targetState, userId, reason);
      return saved;
    });
  }

  /**
   * The transition itself, assuming an open transaction.
   *
   * Split out so `bulkTransitionEntries` can give each row its own transaction while still
   * reporting the state each row actually moved *from* — read under the row lock rather
   * than from an earlier unlocked glance that a concurrent writer may have invalidated.
   */
  private async transitionEntryLocked(
    m: EntityManager,
    emit: (event: string, payload: Record<string, unknown>) => void,
    entryId: string,
    targetState: BillingState,
    userId: string,
    reason?: string,
  ): Promise<{ saved: BillingEntryEntity; fromState: BillingState }> {
      const entry = await this.lockEntry(m, entryId);

      if (entry.state === targetState) throw new ConflictException(`Entry is already ${targetState}.`);

      // An unresolved blocking conflict freezes the entries it names (spec §8).
      // This used to count every open blocking conflict in the system regardless of
      // which entries it referenced, so a single disputed line halted billing for
      // every client in the database. Only conflicts naming *this* entry may stop it.
      if (![BillingState.ON_HOLD, BillingState.DISPUTED].includes(targetState)) {
        const blocking = await m
          .createQueryBuilder(BillingConflictEntity, 'c')
          .where('c.status = :status', { status: BillingConflictStatus.OPEN })
          .andWhere('c.blocks_billing = true')
          .andWhere('c.entry_ids @> :entryId::jsonb', { entryId: JSON.stringify([entryId]) })
          .getOne();
        if (blocking) {
          throw new ConflictException(
            `Blocked by unresolved conflict ${blocking.conflictNumber}: ${blocking.description}. Resolve it first.`,
          );
        }
      }

      if (!isValidTransition(BILLING_STATE_TRANSITIONS, entry.state, targetState)) {
        throw new BadRequestException(
          `Cannot transition billing entry from ${entry.state} to ${targetState}.`,
        );
      }

      const fromState = entry.state;
      entry.state = targetState;
      entry.updatedBy = userId;

      // Keeping payment state in sync as money moves through the pipeline.
      if (targetState === BillingState.PAID) entry.paymentState = PaymentState.PAID;
      if (targetState === BillingState.PARTIALLY_PAID) entry.paymentState = PaymentState.PARTIALLY_PAID;
      if (targetState === BillingState.CANCELLED) {
        entry.paymentState = PaymentState.REVERSED;
        entry.cancelledAmount = entry.totalAmount;
        entry.outstandingAmount = 0;
      }

      const saved = await m.save(entry);
      await this.history(userId, {
        clientId: saved.clientId,
        projectId: saved.projectId,
        assignmentId: saved.assignmentId,
        assayerId: saved.assayerId,
        entityType: BillingEntityType.ENTRY,
        entityId: saved.id,
        action: 'ENTRY_STATE_CHANGED',
        fromState,
        toState: targetState,
        reason: reason ?? null,
      }, m);
      emit('billing:entry-state-changed', { entryId: saved.id, fromState, toState: targetState });
      return { saved, fromState };
  }

  /**
   * Move a batch of billing entries to a target state as one operation. Each row
   * runs through the normal transition rules (conflict freeze, valid transition)
   * and is history-logged individually. Per-row errors are isolated so one bad
   * entry never aborts the rest; rows already in the target state are skipped.
   *
   * Deliberately one transaction PER ROW rather than one around the batch. The
   * per-row error isolation above is the documented contract — an operator selecting
   * two hundred lines expects the hundred and ninety-eight valid ones to move — and a
   * single enclosing transaction would roll all of them back on the first bad row.
   * Each row is still atomic with its own history entry, which is the property that
   * was missing.
   */
  async bulkTransitionEntries(
    entryIds: string[],
    targetState: BillingState,
    userId: string,
    reason?: string,
  ): Promise<{
    succeeded: { id: string; from: BillingState; to: BillingState }[];
    skipped: { id: string; current: BillingState; reason: string }[];
    failed: { id: string; reason: string }[];
  }> {
    const succeeded: { id: string; from: BillingState; to: BillingState }[] = [];
    const skipped: { id: string; current: BillingState; reason: string }[] = [];
    const failed: { id: string; reason: string }[] = [];

    for (const entryId of entryIds) {
      try {
        // The from-state comes back from inside the row lock, so the report describes
        // the transition that actually happened rather than one read beforehand.
        const { fromState } = await this.inTx((m, emit) =>
          this.transitionEntryLocked(m, emit, entryId, targetState, userId, reason),
        );
        succeeded.push({ id: entryId, from: fromState, to: targetState });
      } catch (e) {
        // "Already in the target state" is a skip, not a failure — the row is where the
        // operator wanted it. It arrives here as the ConflictException raised under the
        // lock, which is the only reading of "already" that cannot be stale.
        const message = (e as Error).message;
        if (e instanceof ConflictException && message.includes(`already ${targetState}`)) {
          skipped.push({ id: entryId, current: targetState, reason: `Already ${targetState}` });
          continue;
        }
        failed.push({ id: entryId, reason: message });
      }
    }

    return { succeeded, skipped, failed };
  }

  /**
   * Re-price an entry by `delta`.
   *
   * Locked because the "nothing collected yet" guard is a check-then-act against money:
   * unlocked, a payment landing between the check and the save re-priced a line that had
   * just been paid, leaving `paidAmount` above the new `totalAmount` — a negative balance
   * owed to the client that no report expects to exist.
   */
  async adjustEntry(entryId: string, delta: number, reason: string, userId: string): Promise<BillingEntryEntity> {
    return this.inTx(async (m, emit) => {
    const entry = await this.lockEntry(m, entryId);

    // Money that has already been collected cannot be quietly re-priced; that
    // needs a credit note, not an in-place edit.
    if (Number(entry.paidAmount) > 0) {
      throw new ConflictException(
        `Entry ${entry.entryNumber} has ₹${entry.paidAmount} collected against it — issue a credit note instead of adjusting it.`,
      );
    }

    const fromState = entry.state;
    const previousTotal = Number(entry.totalAmount);
    const previousAdjustment = Number(entry.adjustmentAmount);

    entry.adjustmentAmount = round2(previousAdjustment + delta);
    entry.adjustedAmount = round2(Number(entry.adjustedAmount) + delta);
    entry.state = BillingState.ADJUSTED;
    entry.updatedBy = userId;
    this.recompute(entry);
    const saved = await m.save(entry);

    await this.history(userId, {
      clientId: saved.clientId,
      projectId: saved.projectId,
      assignmentId: saved.assignmentId,
      assayerId: saved.assayerId,
      entityType: BillingEntityType.ENTRY,
      entityId: saved.id,
      action: 'ENTRY_ADJUSTED',
      // Was hardcoded to APPROVED, so the trail claimed every adjustment came from
      // an approved line even when it came from DRAFT, DISPUTED or elsewhere.
      fromState,
      toState: BillingState.ADJUSTED,
      previousValue: { adjustmentAmount: previousAdjustment, totalAmount: previousTotal },
      newValue: { adjustmentAmount: Number(saved.adjustmentAmount), totalAmount: Number(saved.totalAmount) },
      reason,
    }, m);
    emit('billing:entry-adjusted', { entryId: saved.id, delta, totalAmount: Number(saved.totalAmount) });
    return saved;
    });
  }

  /**
   * Credit an entry that has already been paid.
   *
   * `adjustEntry` refuses a line with money against it and tells the operator to issue a credit
   * note — and until now there was nothing to issue. So the one case the engine explicitly
   * directs people towards was the one case the product could not do, and an over-charged client
   * stayed over-charged.
   *
   * What this does, and the reasoning behind each choice — all three are finance decisions and
   * should be confirmed before this is relied on for real money:
   *
   *  1. **It reduces what is owed; it does not move money.** A credit note is a document, a
   *     refund is a payment. The note lowers the entry's value, and where that falls below what
   *     has already been collected the difference is reported as `refundDue` for the finance team
   *     to settle however they settle things — offset against the next invoice or paid back.
   *     Nothing here pretends to have returned any money.
   *
   *  2. **Tax reverses in proportion, at the entry's own rates.** The credit is applied as a
   *     negative adjustment and the line is then recomputed through the same `recompute` used
   *     everywhere else, so GST and TDS come off at exactly the rates that were charged. Hand-
   *     computing the tax on a credit is how a credit note ends up disagreeing with the invoice
   *     it corrects.
   *
   *  3. **Large credits are held for approval.** Above `billing.creditNoteApprovalThreshold`
   *     (default ₹10,000) the note is refused rather than applied, because a credit is the one
   *     operation that reduces revenue and no other control stands behind it.
   */
  async creditEntry(
    entryId: string,
    amount: number,
    reason: string,
    userId: string,
  ): Promise<{ entry: BillingEntryEntity; creditedTotal: number; refundDue: number }> {
    if (!(amount > 0)) {
      throw new BadRequestException('A credit note must be for a positive amount.');
    }
    if (!reason?.trim()) {
      throw new BadRequestException(
        'Say why this credit is being issued — it is the record the client and the auditor both read.',
      );
    }

    const threshold = await this.settings
      .getNumber('billing.creditNoteApprovalThreshold', 10000)
      .catch(() => 10000);

    return this.inTx(async (m, emit) => {
      const entry = await this.lockEntry(m, entryId);

      // Only the taxable value can be credited; crediting more than was charged would invent a
      // negative sale rather than correct an over-charge.
      const creditableTaxable = round2(Number(entry.taxableAmount));
      if (amount > creditableTaxable) {
        throw new BadRequestException(
          `Cannot credit ₹${round2(amount)} against ${entry.entryNumber}: only ₹${creditableTaxable} was charged.`,
        );
      }
      if (amount > threshold) {
        throw new ForbiddenException(
          `A credit of ₹${round2(amount)} is above the ₹${threshold} limit that can be issued directly. `
          + 'Raise it with finance, or change the limit in Platform Settings.',
        );
      }

      const fromState = entry.state;
      const previousTotal = round2(Number(entry.totalAmount));
      const previousAdjustment = round2(Number(entry.adjustmentAmount));

      entry.adjustmentAmount = round2(previousAdjustment - amount);
      entry.adjustedAmount = round2(Number(entry.adjustedAmount) - amount);
      entry.updatedBy = userId;
      this.recompute(entry);

      const newTotal = round2(Number(entry.totalAmount));
      const paid = round2(Number(entry.paidAmount));
      const refundDue = round2(Math.max(0, paid - newTotal));

      /**
       * The payment state follows the new total. There is deliberately no "overpaid" state used
       * here: `PaymentState` has no such member, and adding one would have to be understood by
       * every report, filter and invoice roll-up that reads it. An over-collection is instead
       * reported as `refundDue` — returned to the caller and written into the history entry — so
       * the money owed back is visible without changing the meaning of an existing state.
       */
      if (paid >= newTotal) {
        entry.paymentState = PaymentState.PAID;
      } else if (paid > 0) {
        entry.paymentState = PaymentState.PARTIALLY_PAID;
      } else {
        entry.paymentState = PaymentState.UNPAID;
      }

      const saved = await m.save(entry);

      await this.history(userId, {
        clientId: saved.clientId,
        projectId: saved.projectId,
        assignmentId: saved.assignmentId,
        assayerId: saved.assayerId,
        entityType: BillingEntityType.ENTRY,
        entityId: saved.id,
        action: 'CREDIT_NOTE_ISSUED',
        fromState,
        toState: saved.state,
        previousValue: { totalAmount: previousTotal, adjustmentAmount: previousAdjustment },
        newValue: {
          totalAmount: newTotal,
          adjustmentAmount: round2(Number(saved.adjustmentAmount)),
          creditAmount: round2(amount),
          // What the client's bill actually fell by, tax and TDS included. Recorded rather than
          // derived so the trail does not depend on re-deriving the rates later.
          totalReduction: round2(previousTotal - newTotal),
          refundDue,
        },
        reason,
      }, m);

      emit('billing:credit-note-issued', {
        entryId: saved.id,
        amount: round2(amount),
        totalAmount: newTotal,
        refundDue,
      });

      return { entry: saved, creditedTotal: round2(previousTotal - newTotal), refundDue };
    });
  }

  async findEntries(filters: {
    clientId?: string;
    projectId?: string;
    assignmentId?: string;
    assayerId?: string;
    level?: BillingLevel;
    state?: BillingState;
  } = {}): Promise<BillingEntryEntity[]> {
    return this.entryRepository.find({ where: this.entryWhere(filters), order: { createdAt: 'DESC' } });
  }

  /** The TypeORM `where` every entry list shares, so the paged and unpaged paths cannot drift. */
  private entryWhere(filters: {
    clientId?: string; projectId?: string; assignmentId?: string;
    assayerId?: string; level?: BillingLevel; state?: BillingState;
  }): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    if (filters.clientId) where.clientId = filters.clientId;
    if (filters.projectId) where.projectId = filters.projectId;
    if (filters.assignmentId) where.assignmentId = filters.assignmentId;
    if (filters.assayerId) where.assayerId = filters.assayerId;
    if (filters.level) where.level = filters.level;
    if (filters.state) where.state = filters.state;
    return where;
  }

  /**
   * One clamped page of billing entries, plus the total the filter matches.
   *
   * The unpaged {@link findEntries} above is kept for the bulk export in `reports.service`,
   * which genuinely needs every row and runs on a background export path with progress
   * reporting. Nothing reached from an interactive request may use it: this is the method the
   * controller calls.
   */
  async findEntriesPage(filters: Parameters<BillingEngineService['findEntries']>[0] & { page?: number | string; limit?: number | string } = {}): Promise<BillingPage<BillingEntryEntity>> {
    const w = billingPageWindow(filters.page, filters.limit);
    const [items, total] = await this.entryRepository.findAndCount({
      where: this.entryWhere(filters),
      order: { createdAt: 'DESC' },
      skip: w.skip,
      take: w.take,
    });
    return { items, total, page: w.page, limit: w.limit };
  }

  /**
   * Entries with their client/project/assignment/assayer labels attached. The raw
   * rows only carry foreign keys, so the entries table could not show which client
   * or project a line belonged to — the first thing anyone needs to know about a
   * billing line.
   */
  async findEntriesEnriched(filters: Parameters<BillingEngineService['findEntries']>[0] = {}) {
    const entries = await this.findEntries(filters);
    return this.attachEntryNames(entries);
  }

  /**
   * A page of entries, enriched — what `GET /billing-engine/entries` serves.
   *
   * The name lookups run against the PAGE, not the table: `resolveNames` issues four
   * `id = ANY($1)` queries whose parameter arrays used to hold one id per row in the whole
   * book, so the enrichment step scaled with the table exactly as badly as the list did.
   */
  async findEntriesPageEnriched(
    filters: Parameters<BillingEngineService['findEntriesPage']>[0] = {},
  ): Promise<BillingPage<Awaited<ReturnType<BillingEngineService['attachEntryNames']>>[number]>> {
    const { items, total, page, limit } = await this.findEntriesPage(filters);
    return { items: await this.attachEntryNames(items), total, page, limit };
  }

  private async attachEntryNames(entries: BillingEntryEntity[]) {
    const names = await this.resolveNames(entries);
    return entries.map((e) => ({
      ...e,
      clientName: names.clients.get(e.clientId) ?? null,
      projectName: e.projectId ? names.projects.get(e.projectId) ?? null : null,
      projectNumber: e.projectId ? names.projectNumbers.get(e.projectId) ?? null : null,
      assignmentNumber: e.assignmentId ? names.assignments.get(e.assignmentId) ?? null : null,
      branchName: e.assignmentId ? names.branches.get(e.assignmentId) ?? null : null,
      assayerName: e.assayerId ? names.assayers.get(e.assayerId) ?? null : null,
    }));
  }

  /** Payables with assayer/project labels — the table rendered raw UUIDs before. */
  async findPayablesEnriched(filters: { assayerId?: string; clientId?: string; status?: AssayerPayableStatus } = {}) {
    return this.attachPayableNames(await this.findPayables(filters));
  }

  /**
   * A page of payables, enriched — what `GET /billing-engine/payables` serves.
   *
   * Same shape and the same reason as {@link findEntriesPageEnriched}: the label lookups now
   * cover a page rather than every payable ever raised.
   */
  async findPayablesPageEnriched(
    filters: { assayerId?: string; clientId?: string; status?: AssayerPayableStatus; page?: number | string; limit?: number | string } = {},
  ): Promise<BillingPage<Awaited<ReturnType<BillingEngineService['attachPayableNames']>>[number]>> {
    const w = billingPageWindow(filters.page, filters.limit);
    const where: Record<string, unknown> = {};
    if (filters.assayerId) where.assayerId = filters.assayerId;
    if (filters.clientId) where.clientId = filters.clientId;
    if (filters.status) where.status = filters.status;

    const [payables, total] = await this.payableRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: w.skip,
      take: w.take,
    });
    return { items: await this.attachPayableNames(payables), total, page: w.page, limit: w.limit };
  }

  private async attachPayableNames(payables: AssayerPayableEntity[]) {
    const names = await this.resolveNames([], payables);
    // Payables reference projects/assignments that the entry-based lookup above
    // does not cover, so those labels are resolved directly.
    const projectIds = [...new Set(payables.map((p) => p.projectId).filter(Boolean))] as string[];
    const assignmentIds = [...new Set(payables.map((p) => p.assignmentId).filter(Boolean))] as string[];
    const [projects, assignments] = await Promise.all([
      projectIds.length ? this.entryRepository.manager.query(`SELECT id, name FROM projects WHERE id = ANY($1)`, [projectIds]) : [],
      assignmentIds.length ? this.entryRepository.manager.query(`SELECT id, assignment_number FROM assignments WHERE id = ANY($1)`, [assignmentIds]) : [],
    ]);
    const projectName = new Map<string, string>(projects.map((r: any) => [r.id, r.name]));
    const assignmentNumber = new Map<string, string>(assignments.map((r: any) => [r.id, r.assignment_number]));

    return payables.map((p) => ({
      ...p,
      assayerName: names.assayers.get(p.assayerId) ?? null,
      assayerCode: names.assayerCodes.get(p.assayerId) ?? null,
      projectName: p.projectId ? projectName.get(p.projectId) ?? null : null,
      assignmentNumber: p.assignmentId ? assignmentNumber.get(p.assignmentId) ?? null : null,
    }));
  }

  async getEntry(entryId: string): Promise<BillingEntryEntity> {
    const entry = await this.entryRepository.findOne({ where: { id: entryId } });
    if (!entry) throw new NotFoundException(`Billing entry ${entryId} not found.`);
    return entry;
  }

  // -----------------------------------------------------------------------
  // Duplicate detection (spec §7)
  // -----------------------------------------------------------------------

  /**
   * Duplicates are structurally-identical money lines that should not both be
   * billed. Compared per level:
   *   - ASSIGNMENT: same assignment twice (also caught via parentEntryId).
   *   - PROJECT: same project + period + amount.
   *   - CLIENT: same period + amount, no project tie.
   * An entry that is a split/merge child (parentEntryId set) is excluded.
   */
  private async findDuplicates(
    entry: BillingEntryEntity,
    manager?: EntityManager,
  ): Promise<BillingEntryEntity[]> {
    const q = (manager
      ? manager.createQueryBuilder(BillingEntryEntity, 'e')
      : this.entryRepository.createQueryBuilder('e'))
      .where('e.is_active = :ia', { ia: true })
      .andWhere('e.id != :id', { id: entry.id })
      .andWhere('e.parent_entry_id IS NULL')
      .andWhere('e.state IN (:...states)', {
        states: [BillingState.PENDING_BILLING, BillingState.READY_FOR_BILLING, BillingState.DRAFT, BillingState.SUBMITTED, BillingState.APPROVED, BillingState.INVOICED],
      });

    if (entry.level === BillingLevel.ASSIGNMENT) {
      q.andWhere('e.assignment_id = :asn', { asn: entry.assignmentId });
    } else if (entry.level === BillingLevel.PROJECT) {
      q.andWhere('e.project_id = :pid', { pid: entry.projectId });
      q.andWhere('e.total_amount = :amt', { amt: entry.totalAmount });
    } else {
      q.andWhere('e.project_id IS NULL');
      q.andWhere('e.total_amount = :amt', { amt: entry.totalAmount });
    }
    return q.getMany();
  }

  private async raiseDuplicateConflict(
    entry: BillingEntryEntity,
    duplicateOf: BillingEntryEntity,
    userId: string,
    manager: EntityManager,
    emit: (event: string, payload: Record<string, unknown>) => void,
  ): Promise<void> {
    const conflict = this.conflictRepository.create({
      conflictNumber: `BC-${Date.now().toString(36).toUpperCase()}-${this.seq()}`,
      severity: BillingConflictSeverity.WARNING,
      entityType: BillingEntityType.ENTRY,
      entryIds: [entry.id, duplicateOf.id],
      description: `Duplicate billing detected: ${entry.entryNumber} duplicates ${duplicateOf.entryNumber} (level=${entry.level}).`,
      reason: 'Automatic duplicate detection on entry creation.',
      createdById: userId,
      status: BillingConflictStatus.OPEN,
      blocksBilling: false,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await manager.save(conflict);
    await this.history(userId, {
      clientId: entry.clientId,
      projectId: entry.projectId,
      assignmentId: entry.assignmentId,
      entityType: BillingEntityType.CONFLICT,
      entityId: saved.id,
      action: 'DUPLICATE_FLAGGED',
      newValue: { entryIds: [entry.id, duplicateOf.id] },
      reason: conflict.description,
    }, manager);
    emit('billing:duplicate-detected', { conflictId: saved.id, entryIds: conflict.entryIds });
  }

  // -----------------------------------------------------------------------
  // Conflict management (spec §8)
  // -----------------------------------------------------------------------

  async raiseConflict(
    dto: {
      severity: BillingConflictSeverity;
      entityType: BillingEntityType;
      entryIds: string[];
      description: string;
      reason?: string;
      blocksBilling?: boolean;
    },
    userId: string,
  ): Promise<BillingConflictEntity> {
    if (!dto.entryIds?.length) throw new BadRequestException('At least one entryId is required.');
    const { conflict: raised, assignmentId } = await this.inTx(async (m) => {
    const conflict = this.conflictRepository.create({
      conflictNumber: `BC-${Date.now().toString(36).toUpperCase()}-${this.seq()}`,
      severity: dto.severity,
      entityType: dto.entityType,
      entryIds: dto.entryIds,
      description: dto.description,
      reason: dto.reason ?? null,
      createdById: userId,
      status: BillingConflictStatus.OPEN,
      blocksBilling: dto.blocksBilling ?? dto.severity === BillingConflictSeverity.CRITICAL,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await m.save(conflict);
    await this.history(userId, {
      entityType: BillingEntityType.CONFLICT,
      entityId: saved.id,
      action: 'CONFLICT_RAISED',
      toState: BillingConflictStatus.OPEN,
      newValue: { entryIds: dto.entryIds, severity: dto.severity },
      reason: dto.description,
    }, m);
    // Read on the transaction's own connection: the conflict names entries, and the branch
    // label the notification needs hangs off whichever of them is assignment-level.
    const conflicted = await m.find(BillingEntryEntity, { where: { id: In(dto.entryIds) } });
    return {
      conflict: saved,
      assignmentId: conflicted.find((e) => e.assignmentId)?.assignmentId ?? null,
    };
    });

    // A blocking conflict stops billing silently; finance and ops found out by noticing.
    this.notifyWithBranch(assignmentId, (branchName) => ({
      type: 'BILLING_CONFLICT_RAISED',
      entityType: 'BILLING_CONFLICT',
      entityId: raised.id,
      actorUserId: userId,
      dedupeKey: `BILLING_CONFLICT_RAISED:${raised.id}`,
      payload: {
        conflictId: raised.id,
        conflictNumber: raised.conflictNumber,
        severity: dto.severity,
        branchName,
        description: dto.description,
      },
    }));

    return raised;
  }

  async resolveConflict(
    conflictId: string,
    dto: {
      status: BillingConflictStatus;
      action: string;
      note: string;
    },
    userId: string,
  ): Promise<BillingConflictEntity> {
    return this.inTx(async (m, emit) => {
    // Locked: resolving a conflict is what unfreezes the entries it names, so two
    // resolvers racing here could otherwise both believe they released the block.
    const conflict = await m.findOne(BillingConflictEntity, {
      where: { id: conflictId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!conflict) throw new NotFoundException(`Conflict ${conflictId} not found.`);

    const fromStatus = conflict.status;
    conflict.status = dto.status;
    conflict.resolutionAction = dto.action as any;
    conflict.resolutionNote = dto.note;
    conflict.resolvedById = userId;
    conflict.resolvedAt = new Date();
    conflict.updatedBy = userId;
    const saved = await m.save(conflict);

    await this.history(userId, {
      entityType: BillingEntityType.CONFLICT,
      entityId: saved.id,
      action: 'CONFLICT_RESOLVED',
      fromState: fromStatus,
      toState: saved.status,
      newValue: { action: dto.action },
      reason: dto.note,
    }, m);
    emit('billing:conflict-resolved', { conflictId: saved.id, status: saved.status });
    return saved;
    });
  }

  async findConflicts(status?: BillingConflictStatus): Promise<any[]> {
    return (await this.findConflictsPage(status)).items;
  }

  /**
   * One clamped page of conflicts, newest first.
   *
   * Conflicts are raised automatically by duplicate detection on every entry created, so this
   * table grows with the billing book rather than with operator activity — an unbounded read
   * here was the same defect as on entries, just less obvious.
   */
  async findConflictsPage(
    status?: BillingConflictStatus,
    pageParams: { page?: number | string; limit?: number | string } = {},
  ): Promise<BillingPage<any>> {
    const w = billingPageWindow(pageParams.page, pageParams.limit);
    const [conflicts, total] = await this.conflictRepository.findAndCount({
      where: status ? { status } : {},
      order: { createdAt: 'DESC' },
      skip: w.skip,
      take: w.take,
    });

    const userIds = [...new Set([
      ...conflicts.map((c) => c.createdById).filter(Boolean),
      ...conflicts.map((c) => c.resolvedById).filter(Boolean),
    ])];

    const users = userIds.length
      ? await this.conflictRepository.manager.query(
          `SELECT id, display_name FROM users WHERE id = ANY($1)`,
          [userIds],
        )
      : [];

    const userNameById = new Map<string, string>(users.map((u: any) => [u.id, u.display_name]));

    return {
      items: conflicts.map((c) => ({
        ...c,
        createdByName: c.createdById ? userNameById.get(c.createdById) ?? null : null,
        resolvedByName: c.resolvedById ? userNameById.get(c.resolvedById) ?? null : null,
      })),
      total,
      page: w.page,
      limit: w.limit,
    };
  }

  // -----------------------------------------------------------------------
  // Split / Merge (spec §9)
  // -----------------------------------------------------------------------

  /**
   * Replace one entry with N children whose amounts sum to its total.
   *
   * Atomic because a partial split is unbillable in both directions: children created but
   * the parent left billable double-counts the revenue, and a parent retired before its
   * children exist loses it. Both were reachable — the children were saved one autocommit
   * at a time and the parent was retired in a separate one at the end.
   */
  async splitEntry(entryId: string, dto: SplitEntryDto, userId: string): Promise<BillingEntryEntity[]> {
    return this.inTx(async (m) => {
    const entry = await this.lockEntry(m, entryId);
    if (entry.parentEntryId) throw new BadRequestException('Cannot split an entry that is itself a split/merge child.');
    if (!dto.amounts?.length || dto.amounts.some((a) => a <= 0)) {
      throw new BadRequestException('Split requires a non-empty list of positive amounts.');
    }
    const total = round2(dto.amounts.reduce((a, b) => a + b, 0));
    if (Math.abs(total - Number(entry.totalAmount)) > MONEY_EPSILON) {
      throw new BadRequestException(`Split amounts (${total}) must sum to the entry total (${entry.totalAmount}).`);
    }
    // A line that has been invoiced or part-paid is already attached to money that has
    // moved; splitting it would detach that money from the rows recording it. `mergeEntries`
    // has always refused this — the split path did not, so the same line could be split
    // after invoicing and the invoice would reference a parent no longer billable.
    if (entry.invoiceId || Number(entry.paidAmount) > 0) {
      throw new ConflictException(
        `Cannot split ${entry.entryNumber}: it is already invoiced or part-paid.`,
      );
    }

    // Mark the parent as split into children (kept for traceability, no longer billable itself).
    const savedChildren: BillingEntryEntity[] = [];
    for (const amount of dto.amounts) {
      const child = this.entryRepository.create({
        entryNumber: `BE-${Date.now().toString(36).toUpperCase()}-${this.seq()}`,
        level: entry.level,
        clientId: entry.clientId,
        projectId: entry.projectId,
        assignmentId: entry.assignmentId,
        assayerId: entry.assayerId,
        pricingModel: entry.pricingModel,
        rate: entry.rate,
        quantity: entry.quantity,
        billingPeriodStart: entry.billingPeriodStart,
        billingPeriodEnd: entry.billingPeriodEnd,
        description: `${entry.description ?? 'Split'} (split part)`,
        baseAmount: amount,
        travelAmount: 0,
        adjustmentAmount: 0,
        discountAmount: 0,
        taxRate: entry.taxRate,
        tdsAmount: 0,
        totalAmount: 0,
        currency: entry.currency,
        state: entry.state,
        paymentState: entry.paymentState,
        parentEntryId: entry.id,
        billedAmount: 0,
        paidAmount: 0,
        outstandingAmount: 0,
        disputedAmount: 0,
        cancelledAmount: 0,
        adjustedAmount: 0,
        createdBy: userId,
        updatedBy: userId,
      });
      this.recompute(child);
      const saved = await m.save(child);
      savedChildren.push(saved);
      await this.history(userId, {
        clientId: child.clientId,
        projectId: child.projectId,
        assignmentId: child.assignmentId,
        entityType: BillingEntityType.ENTRY,
        entityId: saved.id,
        action: 'ENTRY_SPLIT',
        fromState: entry.state,
        toState: child.state,
        previousValue: { parentEntryId: entry.id, totalAmount: entry.totalAmount },
        newValue: { totalAmount: Number(child.totalAmount) },
        reason: dto.notes ?? null,
      }, m);
    }

    // Preserve traceability on the parent: it is superseded by its children.
    entry.state = BillingState.ADJUSTED;
    entry.updatedBy = userId;
    await m.save(entry);

    return savedChildren;
    });
  }

  async mergeEntries(entryIds: string[], userId: string, note?: string): Promise<BillingEntryEntity> {
    if (!entryIds?.length || entryIds.length < 2) {
      throw new BadRequestException('Merge requires at least two entries.');
    }
    return this.inTx(async (m) => {
    // Locked in id order so a merge and a payment touching the same lines serialize
    // instead of deadlocking. The invoiced/part-paid guard below is a check-then-act
    // against money, so it is only sound while these rows are held.
    const entries = await this.lockEntriesById(m, entryIds);
    if (entries.length !== entryIds.length) throw new NotFoundException('One or more entries not found.');

    // Merging across clients would move one client's money onto another's ledger,
    // and merging invoiced/paid lines would silently detach money that has already
    // been billed or collected.
    const clientIds = new Set(entries.map((e) => e.clientId));
    if (clientIds.size > 1) {
      throw new BadRequestException('Cannot merge billing entries belonging to different clients.');
    }
    const locked = entries.filter((e) => e.invoiceId || Number(e.paidAmount) > 0);
    if (locked.length) {
      throw new ConflictException(
        `Cannot merge already-invoiced or part-paid entries: ${locked.map((e) => e.entryNumber).join(', ')}.`,
      );
    }

    // The merged line inherits level, client, project and tax rate from one source entry.
    // That used to be whichever row Postgres returned first from an unordered `find`, so
    // the same merge could produce a different `projectId` on a retry. It is now explicitly
    // the first id the caller listed — the one an operator would name as the line they are
    // merging the others into. (Rows are locked in id order, which is a different order and
    // deliberately so: lock ordering is about deadlocks, not about semantics.)
    const byId = new Map(entries.map((e) => [e.id, e]));
    const first = byId.get(entryIds[0]) ?? entries[0];
    const total = round2(entries.reduce((a, e) => a + Number(e.totalAmount), 0));
    const baseTotal = round2(entries.reduce((a, e) => a + Number(e.baseAmount), 0));
    const taxTotal = round2(entries.reduce((a, e) => a + Number(e.taxAmount), 0));
    const tdsTotal = round2(entries.reduce((a, e) => a + Number(e.tdsAmount), 0));

    const merged = this.entryRepository.create({
      entryNumber: `BE-${Date.now().toString(36).toUpperCase()}-${this.seq()}`,
      level: first.level,
      clientId: first.clientId,
      projectId: first.projectId,
      assignmentId: first.assignmentId,
      assayerId: first.assayerId,
      pricingModel: first.pricingModel,
      description: note ?? `Merged ${entryIds.length} entries`,
      baseAmount: baseTotal,
      travelAmount: 0,
      adjustmentAmount: 0,
      discountAmount: 0,
      taxRate: first.taxRate,
      taxAmount: taxTotal,
      tdsAmount: tdsTotal,
      totalAmount: total,
      currency: first.currency,
      state: first.state,
      paymentState: first.paymentState,
      // The merged line is the new parent, so it has no parent of its own. It
      // previously pointed at its own first child while that child pointed back at
      // it, producing a two-node cycle that would hang any recursive walk of the
      // split/merge lineage.
      parentEntryId: null,
      billedAmount: 0,
      paidAmount: 0,
      outstandingAmount: 0,
      disputedAmount: 0,
      cancelledAmount: 0,
      adjustedAmount: 0,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await m.save(merged);

    // Source entries become children of the merge (traceable, not separately billable).
    for (const e of entries) {
      // Captured before mutating: this was read after the assignment below, so every
      // merge logged "ADJUSTED → ADJUSTED" and the real prior state was lost.
      const fromState = e.state;
      e.parentEntryId = saved.id;
      e.state = BillingState.ADJUSTED;
      e.updatedBy = userId;
      await m.save(e);
      await this.history(userId, {
        clientId: e.clientId,
        projectId: e.projectId,
        assignmentId: e.assignmentId,
        entityType: BillingEntityType.ENTRY,
        entityId: e.id,
        action: 'ENTRY_MERGED',
        fromState,
        toState: BillingState.ADJUSTED,
        previousValue: { totalAmount: Number(e.totalAmount) },
        newValue: { mergedInto: saved.id },
        reason: note ?? null,
      }, m);
    }

    await this.history(userId, {
      clientId: saved.clientId,
      projectId: saved.projectId,
      assignmentId: saved.assignmentId,
      entityType: BillingEntityType.ENTRY,
      entityId: saved.id,
      action: 'ENTRY_MERGED',
      fromState: first.state,
      toState: first.state,
      newValue: { sourceEntryIds: entryIds, totalAmount: total },
      reason: note ?? null,
    }, m);
    return saved;
    });
  }

  // -----------------------------------------------------------------------
  // Invoices (spec §2/§3/§9)
  // -----------------------------------------------------------------------

  async createInvoice(dto: {
    clientId: string;
    projectId?: string;
    type: InvoiceType;
    entryIds: string[];
    issueDate?: string;
    dueDate?: string;
    notes?: string;
  }, userId: string): Promise<BillingInvoiceEntity> {
    if (!dto.entryIds?.length) throw new BadRequestException('At least one entry is required to invoice.');
    return this.inTx(async (m, emit) => {
    // Every entry is write-locked before the guards run. The `alreadyInvoiced` check is the
    // one that matters: unlocked, two operators invoicing overlapping selections both read
    // `invoiceId = null`, both passed, and the same work was billed to the client twice on
    // two invoices — the second silently overwriting the first's `invoiceId` on the shared
    // entries, so the first invoice's total no longer matched any entry pointing at it.
    const entries = await this.lockEntriesById(m, dto.entryIds);
    if (entries.length !== dto.entryIds.length) throw new NotFoundException('One or more entries not found.');

    // Only APPROVED entries may be invoiced.
    const notApproved = entries.filter((e) => e.state !== BillingState.APPROVED);
    if (notApproved.length) {
      throw new BadRequestException(`Only APPROVED entries can be invoiced. ${notApproved.map((e) => e.entryNumber).join(', ')} are in ${notApproved.map((e) => e.state).join(', ')}.`);
    }
    // Prevent duplicate invoicing of the same entry.
    const alreadyInvoiced = entries.filter((e) => e.invoiceId);
    if (alreadyInvoiced.length) {
      throw new ConflictException(`Entry ${alreadyInvoiced[0].entryNumber} is already on invoice ${alreadyInvoiced[0].invoiceId}.`);
    }

    // All entries on one invoice must belong to the invoice's client, or the
    // document would bill one client for another's work.
    const foreign = entries.filter((e) => e.clientId !== dto.clientId);
    if (foreign.length) {
      throw new BadRequestException(
        `Entries ${foreign.map((e) => e.entryNumber).join(', ')} do not belong to client ${dto.clientId}.`,
      );
    }

    // Subtotal is the pre-tax taxable value; tax and TDS are shown separately and
    // the payable total is subtotal + GST − TDS. Previously `subtotal` was the sum
    // of entry *totals* (already tax-inclusive) while `taxAmount` was also listed
    // beside it, so the invoice appeared to double-count tax and ignored TDS entirely.
    const subtotal = totalEntryRevenue(entries);
    const tax = round2(entries.reduce((a, e) => a + Number(e.taxAmount), 0));
    const tds = round2(entries.reduce((a, e) => a + Number(e.tdsAmount), 0));
    const discount = round2(entries.reduce((a, e) => a + Number(e.discountAmount), 0));
    const total = round2(entries.reduce((a, e) => a + Number(e.totalAmount), 0));

    const contract = await this.clientTaxRates(dto.clientId, m);
    const issueDate = dto.issueDate ?? new Date().toISOString().slice(0, 10);

    const invoice = this.invoiceRepository.create({
      invoiceNumber: `INV-${Date.now().toString(36).toUpperCase()}-${this.seq()}`,
      clientId: dto.clientId,
      projectId: dto.projectId ?? null,
      type: dto.type,
      status: InvoiceStatus.DRAFT,
      issueDate,
      // Derived from the client's contracted payment terms (NET30/NET45/…) when the
      // caller does not override it, so ageing and collections have a real deadline.
      dueDate: dto.dueDate ?? this.dueDateFromTerms(issueDate, contract.paymentTerms),
      currency: entries[0].currency,
      subtotal,
      taxAmount: tax,
      tdsAmount: tds,
      discountAmount: discount,
      total,
      paidAmount: 0,
      outstandingAmount: total,
      notes: dto.notes ?? null,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await m.save(invoice);

    for (const e of entries) {
      e.invoiceId = saved.id;
      e.state = BillingState.INVOICED;
      e.billedAmount = Number(e.totalAmount);
      e.outstandingAmount = Number(e.totalAmount);
      e.updatedBy = userId;
      await m.save(e);
      await this.history(userId, {
        clientId: e.clientId,
        projectId: e.projectId,
        assignmentId: e.assignmentId,
        entityType: BillingEntityType.ENTRY,
        entityId: e.id,
        action: 'ENTRY_INVOICED',
        fromState: BillingState.APPROVED,
        toState: BillingState.INVOICED,
        newValue: { invoiceId: saved.id, billedAmount: e.billedAmount },
      }, m);
    }

    await this.history(userId, {
      clientId: saved.clientId,
      projectId: saved.projectId,
      entityType: BillingEntityType.INVOICE,
      entityId: saved.id,
      action: 'INVOICE_CREATED',
      fromState: null,
      toState: InvoiceStatus.DRAFT,
      newValue: { total: saved.total, entryIds: dto.entryIds },
    }, m);
    emit('billing:invoice-created', { invoiceId: saved.id, clientId: saved.clientId });
    return saved;
    });
  }

  async transitionInvoice(invoiceId: string, target: InvoiceStatus, userId: string, reason?: string): Promise<BillingInvoiceEntity> {
    return this.inTx(async (m, emit) => {
    // Locked against `recordPayment`, which also moves this row's status. Unlocked, an
    // operator cancelling an invoice at the moment a payment lands could overwrite the
    // PAID status the payment had just written, leaving collected money against a
    // CANCELLED invoice.
    const invoice = await this.lockInvoice(m, invoiceId);
    if (invoice.status === target) throw new ConflictException(`Invoice is already ${target}.`);
    if (!isValidTransition(INVOICE_TRANSITIONS, invoice.status, target)) {
      throw new BadRequestException(`Cannot transition invoice from ${invoice.status} to ${target}.`);
    }
    const fromState = invoice.status;
    invoice.status = target;
    if (target === InvoiceStatus.ISSUED && !invoice.issueDate) invoice.issueDate = new Date().toISOString().slice(0, 10);
    invoice.updatedBy = userId;
    const saved = await m.save(invoice);
    await this.history(userId, {
      clientId: saved.clientId,
      projectId: saved.projectId,
      entityType: BillingEntityType.INVOICE,
      entityId: saved.id,
      action: 'INVOICE_STATUS_CHANGED',
      fromState,
      toState: target,
      reason: reason ?? null,
    }, m);
    emit('billing:invoice-status-changed', { invoiceId: saved.id, fromState, toState: target });
    return saved;
    });
  }

  /**
   * Every invoice matching the filter, each with its entries hydrated.
   *
   * Retained for the bulk export in `reports.service`, which prints an entry count per invoice
   * and so genuinely needs the relation. Interactive callers must use {@link findInvoicesPage}:
   * this one loads the whole invoice book AND every billing line hanging off it.
   */
  async findInvoices(filters: { clientId?: string; projectId?: string; status?: InvoiceStatus } = {}): Promise<BillingInvoiceEntity[]> {
    return this.invoiceRepository.find({ where: this.invoiceWhere(filters), relations: ['entries'], order: { createdAt: 'DESC' } });
  }

  private invoiceWhere(filters: { clientId?: string; projectId?: string; status?: InvoiceStatus }): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    if (filters.clientId) where.clientId = filters.clientId;
    if (filters.projectId) where.projectId = filters.projectId;
    if (filters.status) where.status = filters.status;
    return where;
  }

  /**
   * One clamped page of invoices — what `GET /billing-engine/invoices` serves.
   *
   * Deliberately WITHOUT `relations: ['entries']`. The list screen renders an invoice's number,
   * status, dates and money columns; it never opens the lines, which are fetched by
   * {@link getInvoice} when a row is expanded. Hydrating them for the list meant every invoice
   * dragged its entire set of billing entries across the wire to be discarded — the single
   * largest multiplier on this endpoint. `entryCount` replaces the one thing a list could want
   * from them, at the cost of a grouped count rather than N hydrated rows.
   */
  async findInvoicesPage(
    filters: { clientId?: string; projectId?: string; status?: InvoiceStatus; page?: number | string; limit?: number | string } = {},
  ): Promise<BillingPage<BillingInvoiceEntity & { entryCount: number }>> {
    const w = billingPageWindow(filters.page, filters.limit);
    const [invoices, total] = await this.invoiceRepository.findAndCount({
      where: this.invoiceWhere(filters),
      order: { createdAt: 'DESC' },
      skip: w.skip,
      take: w.take,
    });

    // One grouped count for the page, rather than one hydrated relation per invoice.
    const ids = invoices.map((i) => i.id);
    const countRows: Array<{ invoice_id: string; n: string }> = ids.length
      ? await this.invoiceRepository.manager.query(
          `SELECT invoice_id, COUNT(*) AS n FROM billing_entries WHERE invoice_id = ANY($1) GROUP BY invoice_id`,
          [ids],
        )
      : [];
    const countById = new Map(countRows.map((r) => [r.invoice_id, Number(r.n)]));

    return {
      items: invoices.map((i) => Object.assign(i, { entryCount: countById.get(i.id) ?? 0 })),
      total,
      page: w.page,
      limit: w.limit,
    };
  }

  async getInvoice(invoiceId: string): Promise<BillingInvoiceEntity> {
    const invoice = await this.invoiceRepository.findOne({
      where: { id: invoiceId },
      relations: ['entries', 'payments'],
    });
    if (!invoice) throw new NotFoundException(`Invoice ${invoiceId} not found.`);
    return invoice;
  }

  // -----------------------------------------------------------------------
  // Payments (spec §10)
  // -----------------------------------------------------------------------

  /**
   * Record money received against an invoice.
   *
   * This was the worst of the untransacted paths: 2 + N autocommitted writes — the payment
   * row, then the invoice, then one row per entry. Anything that interrupted the sequence
   * left a ledger no code could produce on purpose. A statement timeout after the invoice
   * save committed an invoice marked PAID whose entries still carried the full amount
   * outstanding; a crash before it recorded cash received against an invoice that still
   * looked unpaid. Both survive a restart and neither is detectable afterwards, because the
   * partial trail looks exactly like a completed one.
   *
   * Concurrency was the other half. Two finance users allocating against the same invoice
   * both read the same `outstandingAmount`, both passed the overpayment guard, and both
   * wrote — collecting more than the invoice was for, with the second write erasing the
   * first's arithmetic. The invoice row is now write-locked before the guard, so the second
   * user waits and is refused against the balance the first actually left.
   */
  async recordPayment(dto: {
    invoiceId: string;
    paymentReference: string;
    method: PaymentMethod;
    amount: number;
    receivedDate?: string;
    allocatedToEntryIds?: string[];
    notes?: string;
  }, userId: string): Promise<BillingPaymentEntity> {
    if (dto.amount <= 0) throw new BadRequestException('Payment amount must be positive.');

    return this.inTx(async (m, emit) => {
      const invoice = await this.lockInvoice(m, dto.invoiceId);

      // Idempotency. A retried POST carries the same `paymentReference`, so if this invoice
      // already has an INBOUND payment under it, this call is that retry and returns the
      // original rather than recording a second one. The invoice write lock above makes this
      // safe under concurrency: a racing retry blocks until the first commits, then re-reads
      // here and finds it. `UQ_billing_payments_inbound_ref` is the backstop for any path that
      // reaches an INSERT without this lock — it turns a double-insert into a failed request
      // instead of a double-payment. The check precedes the overpayment guard deliberately: on
      // a retry the balance is already reduced, so that guard would otherwise reject the retry
      // with a misleading "exceeds outstanding" rather than treating it as the no-op it is.
      const existingPayment = await m.findOne(BillingPaymentEntity, {
        where: {
          invoice: { id: invoice.id },
          paymentReference: dto.paymentReference,
          direction: PaymentDirection.INBOUND,
        },
      });
      if (existingPayment) return existingPayment;

      const remaining = round2(Number(invoice.outstandingAmount) - dto.amount);
      if (remaining < -MONEY_EPSILON) {
        throw new BadRequestException(`Payment exceeds outstanding (${invoice.outstandingAmount}).`);
      }

      // Locked in the same id order every other multi-entry operation uses.
      const entries = await this.lockEntriesByInvoice(m, invoice.id);

      const payment = this.paymentRepository.create({
        invoice,
        paymentReference: dto.paymentReference,
        direction: PaymentDirection.INBOUND,
        method: dto.method,
        amount: dto.amount,
        currency: invoice.currency,
        receivedDate: dto.receivedDate ?? new Date().toISOString().slice(0, 10),
        status: PaymentStatus.RECEIVED,
        allocatedToEntryIds: dto.allocatedToEntryIds ?? null,
        notes: dto.notes ?? null,
        createdBy: userId,
        updatedBy: userId,
      });
      const saved = await m.save(payment);

      // Captured before the mutation below. The history row used to infer the prior status
      // from the new one ("PAID now, so it must have been PARTIALLY_PAID"), which was simply
      // wrong whenever a single payment settled an ISSUED invoice outright — the common case.
      const fromStatus = invoice.status;

      // Update invoice money and status.
      invoice.paidAmount = round2(Number(invoice.paidAmount) + dto.amount);
      invoice.outstandingAmount = round2(Number(invoice.outstandingAmount) - dto.amount);
      if (Math.abs(invoice.outstandingAmount) < MONEY_EPSILON) invoice.outstandingAmount = 0;
      invoice.status = invoice.outstandingAmount <= 0 ? InvoiceStatus.PAID : InvoiceStatus.PARTIALLY_PAID;
      invoice.updatedBy = userId;
      await m.save(invoice);

      // Reflect payment across the invoice's entries (pro-rata unless allocated).
      if (entries.length) {
        const totalOutstanding = entries.reduce((a, e) => a + Number(e.outstandingAmount), 0) || 1;
        let totalApplied = 0;
        for (const e of entries) {
          const share = dto.allocatedToEntryIds?.includes(e.id)
            ? (dto.amount / (dto.allocatedToEntryIds.length || 1))
            : round2(Number(e.outstandingAmount) * (dto.amount / totalOutstanding));
          const applied = Math.min(share, Number(e.outstandingAmount));
          totalApplied = round2(totalApplied + applied);
          e.paidAmount = round2(Number(e.paidAmount) + applied);
          e.outstandingAmount = round2(Number(e.outstandingAmount) - applied);
          if (e.outstandingAmount < MONEY_EPSILON) e.outstandingAmount = 0;
          e.paymentState = e.outstandingAmount <= 0 ? PaymentState.PAID : PaymentState.PARTIALLY_PAID;
          e.updatedBy = userId;
          await m.save(e);
        }

        /**
         * The entries must never absorb more than the payment was worth.
         *
         * The allocation rule above does not enforce that on its own. When
         * `allocatedToEntryIds` names only some of the invoice's entries, the named ones
         * each take `amount / count` while the unnamed ones *still* take a pro-rata slice of
         * the full amount, so the two allocations overlap. The `Math.min(share, outstanding)`
         * clamp hides this whenever the payment settles the invoice outright — each entry can
         * only absorb its own balance and those sum to the invoice — which is why it went
         * unnoticed. On a part-payment the clamp does not bind: ₹500 allocated to one of two
         * entries outstanding ₹600 and ₹400 credits ₹500 + ₹200 = ₹700.
         *
         * Deciding what partial allocation *should* mean is a product question, not a
         * transactional one, so the semantics are left exactly as they were. What changes is
         * that the transaction now refuses to commit an over-allocation instead of silently
         * persisting one. Raising it as a hard failure is the point: it surfaces the case the
         * moment someone hits it, with the money still intact.
         */
        if (totalApplied - dto.amount > MONEY_EPSILON) {
          throw new ConflictException(
            `Allocation error: ₹${totalApplied} would be credited across entries for a ₹${dto.amount} payment. ` +
            `This happens when 'allocatedToEntryIds' names only some of the invoice's entries. ` +
            `Either allocate across every entry or omit the allocation to split pro-rata.`,
          );
        }
      }

      await this.history(userId, {
        clientId: invoice.clientId,
        projectId: invoice.projectId,
        entityType: BillingEntityType.PAYMENT,
        entityId: saved.id,
        action: 'PAYMENT_RECEIVED',
        fromState: fromStatus,
        toState: invoice.status,
        newValue: { amount: dto.amount, paymentReference: dto.paymentReference, invoiceId: invoice.id },
        reason: dto.notes ?? null,
      }, m);
      emit('billing:payment-received', { paymentId: saved.id, invoiceId: invoice.id, amount: dto.amount });
      return saved;
    });
  }

  // -----------------------------------------------------------------------
  // Assayer payable (spec §5) — kept fully separate from client billing
  // -----------------------------------------------------------------------

  async createPayable(dto: {
    assayerId: string;
    clientId?: string;
    projectId?: string;
    assignmentId?: string;
    baseAmount: number;
    travelAmount?: number;
    taxRate?: number;
    tdsRate?: number;
    rateSnapshot?: Record<string, unknown>;
    remarks?: string;
  }, userId: string): Promise<AssayerPayableEntity> {
    if (!dto.assayerId) throw new BadRequestException('assayerId is required.');
    // Fee and travel are kept as the distinct figures they are. They used to be
    // summed into `baseAmount` while travel was *also* stored separately, so the
    // payables table showed base and travel as two independent amounts that did
    // not add up to the total.
    const fee = Number(dto.baseAmount);
    const travel = Number(dto.travelAmount || 0);
    // Same two helpers the dashboards read this payable back through, so what is stored and what
    // is later reported can never disagree about the same row.
    const gross = payableCost({ baseAmount: fee, travelAmount: travel });
    const { taxAmount: tax, tdsAmount: tds, totalAmount: total } =
      applyTaxes(gross, { taxRate: dto.taxRate, tdsRate: dto.tdsRate });

    return this.inTx(async (m) => {
    try {
    const payable = this.payableRepository.create({
      payableNumber: `PY-${Date.now().toString(36).toUpperCase()}-${this.seq()}`,
      assayerId: dto.assayerId,
      clientId: dto.clientId ?? null,
      projectId: dto.projectId ?? null,
      assignmentId: dto.assignmentId ?? null,
      status: AssayerPayableStatus.PENDING,
      baseAmount: fee,
      travelAmount: travel,
      taxAmount: tax,
      tdsAmount: tds,
      totalAmount: total,
      currency: 'INR',
      paidAmount: 0,
      rateSnapshot: dto.rateSnapshot ?? null,
      remarks: dto.remarks ?? null,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await m.save(payable);
    await this.history(userId, {
      clientId: dto.clientId ?? null,
      projectId: dto.projectId ?? null,
      assignmentId: dto.assignmentId ?? null,
      assayerId: dto.assayerId,
      entityType: BillingEntityType.PAYABLE,
      entityId: saved.id,
      action: 'PAYABLE_CREATED',
      fromState: null,
      toState: AssayerPayableStatus.PENDING,
      newValue: { totalAmount: total },
      reason: dto.remarks ?? null,
    }, m);
    return saved;
    } catch (err) {
      // The auto-sync callers catch this themselves and report the winner; a manual creation
      // through the API gets a clear refusal instead of a 500.
      if (isUniqueViolation(err, 'UQ_assayer_payables_fee_per_assignment')) {
        throw new DuplicateFeePayableError();
      }
      throw err;
    }
    });
  }

  async transitionPayable(payableId: string, target: AssayerPayableStatus, userId: string, reason?: string): Promise<AssayerPayableEntity> {
    const saved = await this.inTx(async (m, emit) => {
    // Locked against `recordDisbursement`, which also writes `status` and `paidAmount` on
    // this row. Approval is the control that gates money leaving the business, so the two
    // must not interleave.
    const payable = await this.lockPayable(m, payableId);
    if (payable.status === target) throw new ConflictException(`Payable is already ${target}.`);
    if (!isValidTransition(PAYABLE_TRANSITIONS, payable.status, target)) {
      throw new BadRequestException(`Cannot transition payable from ${payable.status} to ${target}.`);
    }
    const fromState = payable.status;
    payable.status = target;
    if (target === AssayerPayableStatus.APPROVED) { payable.approvedAt = new Date(); payable.approvedBy = userId; }
    if (target === AssayerPayableStatus.PAID) { payable.paidAt = new Date(); payable.paidBy = userId; payable.paidAmount = payable.totalAmount; }
    payable.updatedBy = userId;
    const saved = await m.save(payable);
    await this.history(userId, {
      clientId: payable.clientId,
      projectId: payable.projectId,
      assignmentId: payable.assignmentId,
      assayerId: payable.assayerId,
      entityType: BillingEntityType.PAYABLE,
      entityId: saved.id,
      action: 'PAYABLE_STATUS_CHANGED',
      fromState,
      toState: target,
      reason: reason ?? null,
    }, m);
    emit('billing:payable-status-changed', { payableId: saved.id, fromState, toState: target });
    return saved;
    });

    // The assayer only learned their fee had been approved by checking the earnings screen.
    if (saved.status === AssayerPayableStatus.APPROVED) {
      this.notifyWithBranch(saved.assignmentId, (branchName) => ({
        type: 'PAYABLE_APPROVED',
        entityType: 'PAYABLE',
        entityId: saved.id,
        actorUserId: userId,
        assayerId: saved.assayerId,
        dedupeKey: `PAYABLE_APPROVED:${saved.id}`,
        payload: {
          payableId: saved.id,
          amount: Number(saved.totalAmount),
          branchName,
        },
      }));
    }

    return saved;
  }

  /**
   * Disburses money against an approved payable — the outbound half of the
   * engine.
   *
   * This replaces a separate ledger module that credited a `running_balance`
   * column on the assayer with no link to what was being paid for, no payment
   * reference and no partial-payment support. Disbursements are recorded as
   * ordinary payment rows (direction OUTBOUND) so every rupee in and out of the
   * business is one table.
   */
  async recordDisbursement(dto: {
    payableId: string;
    paymentReference: string;
    method: PaymentMethod;
    amount?: number;
    paidDate?: string;
    notes?: string;
  }, userId: string): Promise<BillingPaymentEntity> {
    // Set only on the path that genuinely moves money; the idempotent early-return leaves it
    // null, so a retried disbursement cannot tell the assayer they were paid a second time.
    let notify: { assignmentId: string | null; assayerId: string; amount: number } | null = null;

    const result = await this.inTx(async (m, emit) => {
    // Write-locked before the outstanding-balance guard. Unlocked, two operators
    // disbursing the same approved payable both read the same `paidAmount`, both computed
    // the same outstanding, both passed the "does not exceed what is owed" check, and both
    // paid — money out of the business twice against one obligation, with the second
    // `paidAmount` write erasing the first.
    const payable = await this.lockPayable(m, dto.payableId);

    // Idempotency, mirroring `recordPayment`: a retried disbursement carries the same
    // `paymentReference`, so if this payable already has an OUTBOUND payment under that
    // reference, return it rather than paying the assayer a second time. The payable write
    // lock serialises a concurrent retry; `UQ_billing_payments_outbound_ref` backstops any
    // unlocked path. Placed before the balance guard so a retry is not rejected as exceeding
    // what is now (post-first-payment) owed.
    const existingDisbursement = await m.findOne(BillingPaymentEntity, {
      where: {
        payableId: payable.id,
        paymentReference: dto.paymentReference,
        direction: PaymentDirection.OUTBOUND,
      },
    });
    if (existingDisbursement) return existingDisbursement;

    // Paying out unapproved work is how duplicate and fraudulent payments happen;
    // approval is the control that has to precede money leaving the business.
    if (payable.status !== AssayerPayableStatus.APPROVED && payable.status !== AssayerPayableStatus.PAID) {
      throw new BadRequestException(
        `Payable ${payable.payableNumber} is ${payable.status}. Only APPROVED payables can be disbursed.`,
      );
    }

    const outstanding = round2(Number(payable.totalAmount) - Number(payable.paidAmount));
    if (outstanding <= 0) {
      throw new ConflictException(`Payable ${payable.payableNumber} is already fully paid.`);
    }
    const amount = round2(dto.amount ?? outstanding);
    if (amount <= 0) throw new BadRequestException('Disbursement amount must be positive.');
    if (amount - outstanding > MONEY_EPSILON) {
      throw new BadRequestException(`Disbursement ₹${amount} exceeds the ₹${outstanding} still owed on this payable.`);
    }

    const fromStatus = payable.status;
    payable.paidAmount = round2(Number(payable.paidAmount) + amount);
    const fullyPaid = Number(payable.totalAmount) - payable.paidAmount <= MONEY_EPSILON;
    if (fullyPaid) {
      payable.status = AssayerPayableStatus.PAID;
      payable.paidAt = new Date();
      payable.paidBy = userId;
    }
    payable.updatedBy = userId;
    await m.save(payable);

    // Balance still owed to this assayer across all their payables, after this
    // payment — the running statement the old ledger tried to maintain, now
    // derived from real obligations instead of a free-floating counter.
    //
    // Computed on the transaction's own connection so it sees the `paidAmount` written a
    // few lines above. On a separate connection it would read the pre-payment figure and
    // stamp a running balance onto the payment row that was stale the moment it was written.
    const balance = await this.assayerOutstanding(payable.assayerId, m);

    const payment = this.paymentRepository.create({
      paymentReference: dto.paymentReference,
      direction: PaymentDirection.OUTBOUND,
      method: dto.method,
      amount,
      currency: payable.currency,
      receivedDate: dto.paidDate ?? new Date().toISOString().slice(0, 10),
      status: PaymentStatus.RECEIVED,
      payableId: payable.id,
      assayerId: payable.assayerId,
      runningBalance: balance,
      invoice: null,
      notes: dto.notes ?? null,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await m.save(payment);

    await this.history(userId, {
      clientId: payable.clientId,
      projectId: payable.projectId,
      assignmentId: payable.assignmentId,
      assayerId: payable.assayerId,
      entityType: BillingEntityType.PAYMENT,
      entityId: saved.id,
      action: 'DISBURSEMENT_PAID',
      // Was hardcoded to APPROVED. A second, settling disbursement against a payable that
      // was already PAID recorded the same false starting point, so the trail could not
      // distinguish a first payment from a top-up.
      fromState: fromStatus,
      toState: payable.status,
      newValue: { amount, paymentReference: dto.paymentReference, payableId: payable.id, balanceAfter: balance },
      reason: dto.notes ?? null,
    }, m);
    emit('billing:disbursement-paid', {
      paymentId: saved.id, payableId: payable.id, assayerId: payable.assayerId, amount,
    });
    // Only the settling disbursement is "you have been paid" — a partial one still leaves a
    // balance owed, and announcing it as paid would be wrong.
    if (fullyPaid) {
      notify = {
        assignmentId: payable.assignmentId,
        assayerId: payable.assayerId,
        amount: Number(payable.paidAmount),
      };
    }
    return saved;
    });

    if (notify) {
      const { assignmentId, assayerId, amount } = notify;
      this.notifyWithBranch(assignmentId, (branchName) => ({
        type: 'PAYABLE_PAID',
        entityType: 'PAYMENT',
        entityId: result.id,
        actorUserId: userId,
        assayerId,
        // Keyed on the reference rather than the payment row, so any retry that slipped past
        // the early-return still collapses onto the one notification.
        dedupeKey: `PAYABLE_PAID:${dto.payableId}:${dto.paymentReference}`,
        payload: {
          paymentId: result.id,
          payableId: dto.payableId,
          amount,
          branchName,
          paymentReference: dto.paymentReference,
        },
      }));
    }

    return result;
  }

  /** Total still owed to an assayer across every payable not yet fully paid. */
  private async assayerOutstanding(assayerId: string, manager?: EntityManager): Promise<number> {
    const rows = await (manager ?? this.payableRepository.manager).query(
      `SELECT COALESCE(SUM(total_amount - paid_amount), 0) AS owed
         FROM assayer_payables
        WHERE assayer_id = $1 AND is_active = true
          AND status NOT IN ('DISPUTED', 'ON_HOLD')`,
      [assayerId],
    );
    return round2(Number(rows?.[0]?.owed ?? 0));
  }

  /**
   * An assayer's financial statement: what they earned, what we have paid, what
   * is still owed, and the transaction history behind it.
   *
   * Replaces the standalone ledger endpoint, which reported a running balance
   * that no longer reconciled to anything because nothing kept it in step with
   * the work actually completed.
   */
  async assayerStatement(assayerId: string): Promise<any> {
    const [payables, payments, assayer] = await Promise.all([
      this.payableRepository.find({ where: { assayerId }, order: { createdAt: 'DESC' } }),
      this.paymentRepository.find({
        where: { assayerId, direction: PaymentDirection.OUTBOUND },
        order: { createdAt: 'DESC' },
      }),
      this.payableRepository.manager.query(
        `SELECT display_name, assayer_code FROM assayers WHERE id = $1 LIMIT 1`, [assayerId],
      ),
    ]);

    const earned = round2(payables.reduce((a, p) => a + Number(p.totalAmount), 0));
    const paid = round2(payables.reduce((a, p) => a + Number(p.paidAmount), 0));

    return {
      assayerId,
      assayerName: assayer?.[0]?.display_name ?? null,
      assayerCode: assayer?.[0]?.assayer_code ?? null,
      totals: {
        earned,
        paid,
        outstanding: round2(earned - paid),
        awaitingApproval: round2(
          payables.filter((p) => p.status === AssayerPayableStatus.PENDING).reduce((a, p) => a + Number(p.totalAmount), 0),
        ),
        onHoldOrDisputed: round2(
          payables
            .filter((p) => p.status === AssayerPayableStatus.ON_HOLD || p.status === AssayerPayableStatus.DISPUTED)
            .reduce((a, p) => a + Number(p.totalAmount), 0),
        ),
        payableCount: payables.length,
      },
      payables: payables.map((p) => ({
        id: p.id,
        payableNumber: p.payableNumber,
        status: p.status,
        assignmentId: p.assignmentId,
        baseAmount: Number(p.baseAmount),
        travelAmount: Number(p.travelAmount),
        tdsAmount: Number(p.tdsAmount),
        totalAmount: Number(p.totalAmount),
        paidAmount: Number(p.paidAmount),
        outstanding: round2(Number(p.totalAmount) - Number(p.paidAmount)),
        createdAt: p.createdAt,
      })),
      payments: payments.map((pm) => ({
        id: pm.id,
        paymentReference: pm.paymentReference,
        method: pm.method,
        amount: Number(pm.amount),
        paidDate: pm.receivedDate,
        balanceAfter: pm.runningBalance !== null ? Number(pm.runningBalance) : null,
        notes: pm.notes,
      })),
    };
  }

  async findPayables(filters: { assayerId?: string; clientId?: string; status?: AssayerPayableStatus } = {}): Promise<AssayerPayableEntity[]> {
    const where: Record<string, unknown> = {};
    if (filters.assayerId) where.assayerId = filters.assayerId;
    if (filters.clientId) where.clientId = filters.clientId;
    if (filters.status) where.status = filters.status;
    return this.payableRepository.find({ where, order: { createdAt: 'DESC' } });
  }

  // -----------------------------------------------------------------------
  // History / audit trail (spec §10)
  // -----------------------------------------------------------------------

  async getHistory(filters: { clientId?: string; projectId?: string; assignmentId?: string; assayerId?: string; entityType?: BillingEntityType } = {}): Promise<BillingHistoryEntity[]> {
    return this.historyRepository.find({ where: this.historyWhere(filters), order: { createdAt: 'DESC' }, take: 200 });
  }

  private historyWhere(filters: { clientId?: string; projectId?: string; assignmentId?: string; assayerId?: string; entityType?: BillingEntityType }): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    if (filters.clientId) where.clientId = filters.clientId;
    if (filters.projectId) where.projectId = filters.projectId;
    if (filters.assignmentId) where.assignmentId = filters.assignmentId;
    if (filters.assayerId) where.assayerId = filters.assayerId;
    if (filters.entityType) where.entityType = filters.entityType;
    return where;
  }

  /**
   * One clamped page of the audit trail, plus the true number of matching events.
   *
   * This list was already bounded at 200 rows, so it was never the memory problem the others
   * were — but a fixed `take` with no `total` and no way to reach row 201 is a silent truncation
   * rather than a page: the trail simply stopped, with nothing on screen to say more existed.
   */
  async getHistoryPage(
    filters: { clientId?: string; projectId?: string; assignmentId?: string; assayerId?: string; entityType?: BillingEntityType; page?: number | string; limit?: number | string } = {},
  ): Promise<BillingPage<BillingHistoryEntity>> {
    const w = billingPageWindow(filters.page, filters.limit);
    const [items, total] = await this.historyRepository.findAndCount({
      where: this.historyWhere(filters),
      order: { createdAt: 'DESC' },
      skip: w.skip,
      take: w.take,
    });
    return { items, total, page: w.page, limit: w.limit };
  }

  // -----------------------------------------------------------------------
  // Dashboard & reports (spec §11)
  // -----------------------------------------------------------------------

  /**
   * Receivables ageing, computed in SQL over the whole invoice book.
   *
   * The buckets are the ones {@link ageInvoices} produced row by row in JS. The day count is
   * reproduced exactly: `daysOverdue` measures from UTC midnight on the due date to now and
   * treats anything not yet past due — and anything fully paid — as `current`.
   */
  private static readonly AGEING_SELECT = `
    COALESCE(SUM(outstanding_amount) FILTER (WHERE outstanding_amount > 0 AND (due_date IS NULL OR $OD <= 0)), 0) AS current,
    COALESCE(SUM(outstanding_amount) FILTER (WHERE outstanding_amount > 0 AND due_date IS NOT NULL AND $OD > 0  AND $OD <= 30), 0) AS d1_30,
    COALESCE(SUM(outstanding_amount) FILTER (WHERE outstanding_amount > 0 AND due_date IS NOT NULL AND $OD > 30 AND $OD <= 60), 0) AS d31_60,
    COALESCE(SUM(outstanding_amount) FILTER (WHERE outstanding_amount > 0 AND due_date IS NOT NULL AND $OD > 60 AND $OD <= 90), 0) AS d61_90,
    COALESCE(SUM(outstanding_amount) FILTER (WHERE outstanding_amount > 0 AND due_date IS NOT NULL AND $OD > 90), 0) AS d90_plus
  `.replace(/\$OD/g, `FLOOR(EXTRACT(EPOCH FROM (NOW() - ((due_date::text || ' 00:00:00+00')::timestamptz))) / 86400)`);

  /**
   * The billing overview, assembled from SQL aggregates rather than from the table.
   *
   * It previously loaded EVERY billing entry, EVERY invoice and EVERY payable into the process
   * and reduced them in JavaScript — five `Array.filter` passes over the entry list alone. On
   * the scale book that is 85,733 entries hydrated into entity objects to produce fourteen
   * scalars. Every figure below is now one grouped pass in Postgres over an index, and the
   * numbers are unchanged: the same columns, the same state predicates, the same rounding.
   *
   * The scoping asymmetry is preserved deliberately, not overlooked. A client-scoped call has
   * never filtered on `is_active` while the org-wide call always has, so a soft-deleted entry
   * counts towards one dashboard and not the other. That is a real defect, but correcting it
   * here would move numbers finance reads, which this change is explicitly not allowed to do —
   * it is called out in the handover instead.
   */
  async dashboard(clientId?: string): Promise<any> {
    const mgr = this.entryRepository.manager;
    // Client-scoped: filter on the client and nothing else. Org-wide: active rows only.
    const scope = (col = 'client_id') => (clientId ? `${col} = $1` : 'is_active = true');
    const params = clientId ? [clientId] : [];
    const unbilled = UNBILLED_STATES.map((s) => `'${s}'`).join(',');

    const [entryRows, levelRows, payableRows, invoiceRows, ageRows, conflictRows, history] = await Promise.all([
      mgr.query(`
        SELECT COALESCE(SUM(billed_amount), 0)      AS billed,
               COALESCE(SUM(paid_amount), 0)        AS paid,
               COALESCE(SUM(outstanding_amount), 0) AS outstanding,
               COALESCE(SUM(total_amount) FILTER (WHERE state IN (${unbilled})), 0)                     AS pending,
               COALESCE(SUM(disputed_amount) FILTER (WHERE state = '${BillingState.DISPUTED}'), 0)      AS disputed,
               COALESCE(SUM(total_amount) FILTER (WHERE state IN ('${BillingState.CANCELLED}','${BillingState.ADJUSTED}')), 0) AS cancelled_adjusted,
               COALESCE(SUM(taxable_amount), 0)     AS revenue
          FROM billing_entries WHERE ${scope()}`, params),

      mgr.query(`
        SELECT level,
               COALESCE(SUM(billed_amount), 0)      AS billed,
               COALESCE(SUM(paid_amount), 0)        AS paid,
               COALESCE(SUM(outstanding_amount), 0) AS outstanding
          FROM billing_entries WHERE ${scope()} GROUP BY level`, params),

      mgr.query(`
        SELECT COALESCE(SUM(total_amount) FILTER (WHERE status = '${AssayerPayableStatus.PENDING}'), 0)  AS pending,
               COALESCE(SUM(total_amount) FILTER (WHERE status = '${AssayerPayableStatus.APPROVED}'), 0) AS approved,
               COALESCE(SUM(total_amount) FILTER (WHERE status = '${AssayerPayableStatus.PAID}'), 0)     AS paid,
               COALESCE(SUM(total_amount) FILTER (WHERE status = '${AssayerPayableStatus.DISPUTED}'), 0) AS disputed,
               COALESCE(SUM(total_amount) FILTER (WHERE status = '${AssayerPayableStatus.ON_HOLD}'), 0)  AS on_hold,
               COALESCE(SUM(base_amount + travel_amount), 0)                                            AS assayer_cost
          FROM assayer_payables WHERE ${scope()}`, params),

      mgr.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE status IN ('${InvoiceStatus.ISSUED}','${InvoiceStatus.PARTIALLY_PAID}'))::int AS issued,
               COUNT(*) FILTER (WHERE status = '${InvoiceStatus.PAID}')::int                                        AS paid,
               COALESCE(SUM(outstanding_amount), 0) AS outstanding
          FROM billing_invoices WHERE ${scope()}`, params),

      mgr.query(`SELECT ${BillingEngineService.AGEING_SELECT} FROM billing_invoices WHERE ${scope()}`, params),

      mgr.query(`SELECT COUNT(*)::int AS n FROM billing_conflicts WHERE status = '${BillingConflictStatus.OPEN}'`),

      this.historyRepository.find({ where: clientId ? { clientId } : {}, order: { createdAt: 'DESC' }, take: 50 }),
    ]);

    const n = (v: any) => round2(Number(v ?? 0));
    const e = entryRows[0] ?? {};
    const p = payableRows[0] ?? {};
    const inv = invoiceRows[0] ?? {};
    const ag = ageRows[0] ?? {};

    const billed = n(e.billed);
    const paid = n(e.paid);
    const outstanding = n(e.outstanding);
    // The one definition of unbilled — the shared UNBILLED_STATES, which every other finance
    // figure uses. This inlined a 5-state list that omitted APPROVED, so the moment finance
    // approved an entry the Overview KPI dropped it while the Finance tab still counted it: the
    // same rupees, two numbers, on two tabs of one screen.
    const pending = n(e.pending);
    const disputed = n(e.disputed);
    const cancelledAdjusted = n(e.cancelled_adjusted);

    // Every level is present even when it has no rows: the client iterates `Object.keys(byLevel)`
    // to lay out its columns, so a level dropping out because nothing was billed at it would
    // silently remove a column rather than show a zero.
    const levelById = new Map(levelRows.map((r: any) => [r.level, r]));
    const byLevel: Record<string, { billed: number; paid: number; outstanding: number }> = {};
    for (const lvl of Object.values(BillingLevel)) {
      const row: any = levelById.get(lvl) ?? {};
      byLevel[lvl] = { billed: n(row.billed), paid: n(row.paid), outstanding: n(row.outstanding) };
    }

    const payableTotals = {
      pending: n(p.pending),
      approved: n(p.approved),
      paid: n(p.paid),
      disputed: n(p.disputed),
      onHold: n(p.on_hold),
    };

    const invoiceTotals = {
      total: Number(inv.total ?? 0),
      issued: Number(inv.issued ?? 0),
      paid: Number(inv.paid ?? 0),
      outstanding: n(inv.outstanding),
    };

    // Net revenue (taxable value, ex-GST) against gross assayer cost (fee + travel).
    // GST is a pass-through and TDS a withheld tax credit, so neither side is netted.
    const assayerCost = n(p.assayer_cost);
    const revenue = n(e.revenue);

    return {
      currency: 'INR',
      totals: {
        billed, paid, outstanding, pending, disputed, cancelledAdjusted,
        // Revenue earned in the field but not yet on an invoice — the number that
        // shows how much cash is stuck in the billing pipeline.
        unbilledRevenue: pending,
        revenue,
        assayerCost,
        ...margin(revenue, assayerCost),
      },
      aging: {
        current: n(ag.current),
        d1_30: n(ag.d1_30),
        d31_60: n(ag.d31_60),
        d61_90: n(ag.d61_90),
        d90_plus: n(ag.d90_plus),
      },
      byLevel,
      payable: payableTotals,
      invoices: invoiceTotals,
      openConflicts: Number(conflictRows[0]?.n ?? 0),
      recentActivity: history.map((h) => ({
        id: h.id,
        action: h.action,
        entityType: h.entityType,
        entityId: h.entityId,
        fromState: h.fromState,
        toState: h.toState,
        reason: h.reason,
        occurredAt: h.createdAt,
        userName: h.userName,
      })),
    };
  }

  /**
   * Full billing picture for a client, as the business actually reads it:
   * Client → Projects → Assignments, each with its own money and state, plus the
   * assayer cost booked against the same work.
   *
   * The previous version grouped by a bare `projectId` string with no names, so
   * the report was a list of UUIDs and unusable for answering "which project is
   * unbilled?" without cross-referencing another screen.
   */
  async clientReport(clientId: string): Promise<any> {
    await this.ensureClient(clientId);
    const [entries, invoices, history, payables] = await Promise.all([
      this.findEntries({ clientId }),
      this.findInvoices({ clientId }),
      this.getHistory({ clientId }),
      this.findPayables({ clientId }),
    ]);

    const names = await this.resolveNames(entries, payables);

    // Assignment-level rollup, nested under its project.
    const byProject = new Map<string, any>();
    for (const e of entries) {
      const pid = e.projectId ?? 'unassigned';
      if (!byProject.has(pid)) {
        byProject.set(pid, {
          projectId: e.projectId,
          projectName: names.projects.get(pid) ?? (e.projectId ? 'Unknown project' : 'Not project-linked'),
          projectNumber: names.projectNumbers.get(pid) ?? null,
          billed: 0, paid: 0, outstanding: 0, pending: 0, entryCount: 0,
          assignments: new Map<string, any>(),
        });
      }
      const p = byProject.get(pid);
      p.billed = round2(p.billed + Number(e.billedAmount));
      p.paid = round2(p.paid + Number(e.paidAmount));
      p.outstanding = round2(p.outstanding + Number(e.outstandingAmount));
      if (UNBILLED_STATES.includes(e.state)) p.pending = round2(p.pending + Number(e.totalAmount));
      p.entryCount += 1;

      if (e.assignmentId) {
        const cur = p.assignments.get(e.assignmentId) ?? {
          assignmentId: e.assignmentId,
          assignmentNumber: names.assignments.get(e.assignmentId) ?? null,
          branchName: names.branches.get(e.assignmentId) ?? null,
          assayerId: e.assayerId,
          assayerName: e.assayerId ? names.assayers.get(e.assayerId) ?? null : null,
          revenue: 0, billedToClient: 0, cost: 0, margin: 0, state: e.state, entryIds: [] as string[],
        };
        // Margin is measured on net revenue (the taxable value we actually earn).
        // GST is collected on the government's behalf and TDS is a withheld tax
        // credit, so neither belongs in a profitability figure.
        cur.revenue = round2(cur.revenue + entryRevenue(e));
        cur.billedToClient = round2(cur.billedToClient + Number(e.totalAmount));
        cur.entryIds.push(e.id);
        cur.state = e.state;
        p.assignments.set(e.assignmentId, cur);
      }
    }

    // Book the assayer cost against its assignment so per-job margin is visible —
    // the reason this platform exists is cost per audit, which needs both legs.
    for (const py of payables) {
      if (!py.assignmentId) continue;
      for (const p of byProject.values()) {
        const asn = p.assignments.get(py.assignmentId);
        if (asn) {
          // Gross cost: fee + travel. The TDS we withhold is still money owed on
          // the assayer's behalf, so netting it out would understate what the job costs.
          asn.cost = round2(asn.cost + payableCost(py));
          asn.payableStatus = py.status;
        }
      }
    }

    const projects = Array.from(byProject.values()).map((p) => {
      const assignments = Array.from(p.assignments.values()).map((a: any) => ({
        ...a,
        ...margin(a.revenue, a.cost),
      }));
      const cost = round2(assignments.reduce((s: number, a: any) => s + a.cost, 0));
      const revenue = round2(assignments.reduce((s: number, a: any) => s + a.revenue, 0));
      return {
        ...p,
        assignments,
        cost,
        revenue,
        margin: round2(revenue - cost),
        marginPct: revenue > 0 ? round2(((revenue - cost) / revenue) * 100) : null,
      };
    });

    // Net revenue (ex-GST) against gross assayer cost — see the per-assignment note.
    const totalRevenue = totalEntryRevenue(entries);
    const totalCost = totalPayableCost(payables);

    return {
      clientId,
      clientName: names.clients.get(clientId) ?? null,
      totals: {
        billed: round2(entries.reduce((a, e) => a + Number(e.billedAmount), 0)),
        paid: round2(entries.reduce((a, e) => a + Number(e.paidAmount), 0)),
        outstanding: round2(entries.reduce((a, e) => a + Number(e.outstandingAmount), 0)),
        pending: round2(entries.filter((e) => UNBILLED_STATES.includes(e.state)).reduce((a, e) => a + Number(e.totalAmount), 0)),
        revenue: totalRevenue,
        assayerCost: totalCost,
        ...margin(totalRevenue, totalCost),
        entryCount: entries.length,
      },
      projects,
      aging: this.ageInvoices(invoices),
      invoices: invoices.map((i) => ({
        id: i.id,
        invoiceNumber: i.invoiceNumber,
        status: i.status,
        subtotal: Number(i.subtotal),
        taxAmount: Number(i.taxAmount),
        tdsAmount: Number(i.tdsAmount ?? 0),
        total: Number(i.total),
        paidAmount: Number(i.paidAmount),
        outstandingAmount: Number(i.outstandingAmount),
        issueDate: i.issueDate,
        dueDate: i.dueDate,
        daysOverdue: this.daysOverdue(i),
      })),
      recentHistory: history.slice(0, 30).map((h) => ({
        id: h.id,
        action: h.action,
        entityType: h.entityType,
        fromState: h.fromState,
        toState: h.toState,
        reason: h.reason,
        userName: h.userName,
        occurredAt: h.createdAt,
      })),
    };
  }

  /** Days past due for an unpaid invoice; null when not yet due or fully paid. */
  private daysOverdue(i: BillingInvoiceEntity): number | null {
    if (!i.dueDate || Number(i.outstandingAmount) <= 0) return null;
    const diff = Math.floor((Date.now() - new Date(`${i.dueDate}T00:00:00Z`).getTime()) / 86400000);
    return diff > 0 ? diff : null;
  }

  /**
   * Standard receivables ageing. Collections work is driven off these buckets and
   * there was previously no due-date-aware reporting at all.
   */
  private ageInvoices(invoices: BillingInvoiceEntity[]) {
    const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
    for (const i of invoices) {
      const outstanding = Number(i.outstandingAmount);
      if (outstanding <= 0) continue;
      const od = this.daysOverdue(i);
      if (od === null) buckets.current = round2(buckets.current + outstanding);
      else if (od <= 30) buckets.d1_30 = round2(buckets.d1_30 + outstanding);
      else if (od <= 60) buckets.d31_60 = round2(buckets.d31_60 + outstanding);
      else if (od <= 90) buckets.d61_90 = round2(buckets.d61_90 + outstanding);
      else buckets.d90_plus = round2(buckets.d90_plus + outstanding);
    }
    return buckets;
  }

  /**
   * Batch-resolves the human labels the billing screens need. Billing rows carry
   * only foreign keys, so without this the UI can only render UUIDs — which is
   * exactly how the payables and history tables looked.
   */
  private async resolveNames(entries: BillingEntryEntity[], payables: AssayerPayableEntity[] = []) {
    const clientIds = [...new Set(entries.map((e) => e.clientId).filter(Boolean))];
    const projectIds = [...new Set(entries.map((e) => e.projectId).filter(Boolean))] as string[];
    const assignmentIds = [...new Set(entries.map((e) => e.assignmentId).filter(Boolean))] as string[];
    const assayerIds = [...new Set([
      ...entries.map((e) => e.assayerId),
      ...payables.map((p) => p.assayerId),
    ].filter(Boolean))] as string[];

    const q = (sql: string, ids: string[]) => (ids.length ? this.entryRepository.manager.query(sql, [ids]) : Promise.resolve([]));

    const [clients, projects, assignments, assayers] = await Promise.all([
      q(`SELECT id, name FROM clients WHERE id = ANY($1)`, clientIds),
      q(`SELECT id, name, project_number FROM projects WHERE id = ANY($1)`, projectIds),
      q(`SELECT a.id, a.assignment_number, b.name AS branch_name
           FROM assignments a
           LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
           LEFT JOIN branches b ON b.id = pb.branch_id
          WHERE a.id = ANY($1)`, assignmentIds),
      q(`SELECT id, display_name, assayer_code FROM assayers WHERE id = ANY($1)`, assayerIds),
    ]);

    return {
      clients: new Map<string, string>(clients.map((r: any) => [r.id, r.name])),
      projects: new Map<string, string>(projects.map((r: any) => [r.id, r.name])),
      projectNumbers: new Map<string, string>(projects.map((r: any) => [r.id, r.project_number])),
      assignments: new Map<string, string>(assignments.map((r: any) => [r.id, r.assignment_number])),
      branches: new Map<string, string>(assignments.map((r: any) => [r.id, r.branch_name])),
      assayers: new Map<string, string>(assayers.map((r: any) => [r.id, r.display_name])),
      assayerCodes: new Map<string, string>(assayers.map((r: any) => [r.id, r.assayer_code])),
    };
  }

  /**
   * The complete financial record for any entity in the business — one endpoint
   * answering "show me everything about the money for this X", where X is a
   * client, project, branch, assayer or assignment.
   *
   * Finance questions arrive framed around whatever entity is in front of the
   * person asking ("what have we earned at this branch?", "what do we owe this
   * assayer?"), but the money was previously only queryable by client. Each
   * entity resolves to the same shape so one UI can render any of them.
   */
  async entityLedger(
    entityType: 'client' | 'project' | 'branch' | 'assayer' | 'assignment',
    entityId: string,
  ): Promise<any> {
    const mgr = this.entryRepository.manager;

    // Branches and assignments are not columns on billing rows, so they resolve
    // through the assignments that touched them.
    let entryWhere = '';
    let payableWhere = '';
    const params: any[] = [entityId];

    switch (entityType) {
      case 'client':
        entryWhere = 'e.client_id = $1';
        payableWhere = 'p.client_id = $1';
        break;
      case 'project':
        entryWhere = 'e.project_id = $1';
        payableWhere = 'p.project_id = $1';
        break;
      case 'assayer':
        entryWhere = 'e.assayer_id = $1';
        payableWhere = 'p.assayer_id = $1';
        break;
      case 'assignment':
        entryWhere = 'e.assignment_id = $1';
        payableWhere = 'p.assignment_id = $1';
        break;
      case 'branch':
        entryWhere = `e.assignment_id IN (
          SELECT a.id FROM assignments a
            JOIN project_branches pb ON pb.id = a.project_branch_id
           WHERE pb.branch_id = $1)`;
        payableWhere = `p.assignment_id IN (
          SELECT a.id FROM assignments a
            JOIN project_branches pb ON pb.id = a.project_branch_id
           WHERE pb.branch_id = $1)`;
        break;
      default:
        throw new BadRequestException(`Unsupported entity type '${entityType}'.`);
    }

    const [entries, payables, subject] = await Promise.all([
      mgr.query(
        `SELECT e.* FROM billing_entries e WHERE e.is_active = true AND ${entryWhere} ORDER BY e.created_at DESC`,
        params,
      ),
      mgr.query(
        `SELECT p.* FROM assayer_payables p WHERE p.is_active = true AND ${payableWhere} ORDER BY p.created_at DESC`,
        params,
      ),
      this.describeEntity(entityType, entityId),
    ]);

    const entryIds = entries.map((e: any) => e.id);
    const payableIds = payables.map((p: any) => p.id);

    // Everything that has happened to this entity's money, and every rupee that
    // actually moved because of it.
    const [history, payments] = await Promise.all([
      mgr.query(
        `SELECT * FROM billing_history
          WHERE (entity_id = ANY($1) OR entity_id = ANY($2) OR ${entityType === 'branch' ? 'false' : `${entityType}_id = $3`})
          ORDER BY created_at DESC LIMIT 200`,
        entityType === 'branch' ? [entryIds, payableIds, null] : [entryIds, payableIds, entityId],
      ).catch(() => []),
      mgr.query(
        `SELECT * FROM billing_payments
          WHERE is_active = true
            AND (payable_id = ANY($1)
                 OR invoice_id IN (SELECT DISTINCT invoice_id FROM billing_entries WHERE id = ANY($2) AND invoice_id IS NOT NULL))
          ORDER BY created_at DESC`,
        [payableIds, entryIds],
      ).catch(() => []),
    ]);

    const n = (v: any) => Number(v ?? 0);
    const revenue = round2(entries.reduce((a: number, e: any) => a + n(e.taxable_amount), 0));
    const cost = totalPayableCost(payables);
    const inbound = payments.filter((p: any) => p.direction === PaymentDirection.INBOUND);
    const outbound = payments.filter((p: any) => p.direction === PaymentDirection.OUTBOUND);

    return {
      entityType,
      entityId,
      subject,
      totals: {
        revenue,
        billedToClient: round2(entries.reduce((a: number, e: any) => a + n(e.total_amount), 0)),
        collected: round2(entries.reduce((a: number, e: any) => a + n(e.paid_amount), 0)),
        outstanding: round2(entries.reduce((a: number, e: any) => a + n(e.outstanding_amount), 0)),
        unbilled: round2(
          entries.filter((e: any) => UNBILLED_STATES.includes(e.state)).reduce((a: number, e: any) => a + n(e.total_amount), 0),
        ),
        assayerCost: cost,
        assayerPaid: round2(payables.reduce((a: number, p: any) => a + n(p.paid_amount), 0)),
        assayerOwed: round2(payables.reduce((a: number, p: any) => a + (n(p.total_amount) - n(p.paid_amount)), 0)),
        margin: round2(revenue - cost),
        marginPct: revenue > 0 ? round2(((revenue - cost) / revenue) * 100) : null,
        gst: round2(entries.reduce((a: number, e: any) => a + n(e.tax_amount), 0)),
        tds: round2(entries.reduce((a: number, e: any) => a + n(e.tds_amount), 0)),
        cashIn: round2(inbound.reduce((a: number, p: any) => a + n(p.amount), 0)),
        cashOut: round2(outbound.reduce((a: number, p: any) => a + n(p.amount), 0)),
        entryCount: entries.length,
        payableCount: payables.length,
      },
      // Money earned over time, so trends are visible rather than just a total.
      monthly: this.monthlyTrend(entries, payables),
      entries: entries.map((e: any) => ({
        id: e.id, entryNumber: e.entry_number, level: e.level, state: e.state,
        description: e.description, taxableAmount: n(e.taxable_amount), taxAmount: n(e.tax_amount),
        tdsAmount: n(e.tds_amount), totalAmount: n(e.total_amount), paidAmount: n(e.paid_amount),
        outstandingAmount: n(e.outstanding_amount), invoiceId: e.invoice_id, createdAt: e.created_at,
      })),
      payables: payables.map((p: any) => ({
        id: p.id, payableNumber: p.payable_number, status: p.status,
        baseAmount: n(p.base_amount), travelAmount: n(p.travel_amount), tdsAmount: n(p.tds_amount),
        totalAmount: n(p.total_amount), paidAmount: n(p.paid_amount),
        outstanding: round2(n(p.total_amount) - n(p.paid_amount)), createdAt: p.created_at,
      })),
      payments: payments.map((p: any) => ({
        id: p.id, direction: p.direction, reference: p.payment_reference, method: p.method,
        amount: n(p.amount), date: p.received_date, notes: p.notes,
      })),
      history: history.map((h: any) => ({
        id: h.id, action: h.action, entityType: h.entity_type,
        fromState: h.from_state, toState: h.to_state, reason: h.reason,
        userName: h.user_name, occurredAt: h.created_at,
      })),
    };
  }

  /** Human identity of whatever the ledger is being read for. */
  private async describeEntity(entityType: string, entityId: string): Promise<any> {
    const mgr = this.entryRepository.manager;
    const q: Record<string, string> = {
      client: `SELECT name AS label, client_code AS ref FROM clients WHERE id = $1`,
      project: `SELECT name AS label, project_number AS ref FROM projects WHERE id = $1`,
      branch: `SELECT name AS label, branch_code AS ref FROM branches WHERE id = $1`,
      assayer: `SELECT display_name AS label, assayer_code AS ref FROM assayers WHERE id = $1`,
      assignment: `SELECT assignment_number AS label, status AS ref FROM assignments WHERE id = $1`,
    };
    const rows = await mgr.query(q[entityType], [entityId]).catch(() => []);
    return rows?.[0] ?? { label: null, ref: null };
  }

  /** Revenue/cost/margin per calendar month, oldest first. */
  private monthlyTrend(entries: any[], payables: any[]) {
    const buckets = new Map<string, { month: string; revenue: number; cost: number; margin: number }>();
    const key = (d: any) => new Date(d).toISOString().slice(0, 7);
    const bucket = (m: string) => {
      if (!buckets.has(m)) buckets.set(m, { month: m, revenue: 0, cost: 0, margin: 0 });
      return buckets.get(m)!;
    };
    for (const e of entries) {
      const b = bucket(key(e.created_at));
      b.revenue = round2(b.revenue + Number(e.taxable_amount ?? 0));
    }
    for (const p of payables) {
      const b = bucket(key(p.created_at));
      b.cost = round2(b.cost + Number(p.base_amount ?? 0) + Number(p.travel_amount ?? 0));
    }
    return [...buckets.values()]
      .map((b) => ({ ...b, margin: round2(b.revenue - b.cost) }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }

  /**
   * The finance team's single view of the business: what is owed to us, what we
   * owe, what actually moved, and where money is stuck.
   *
   * Built as one call because finance questions cross the receivable/payable
   * boundary ("can we cover this month's assayer run from collections?") and the
   * data previously lived in three unconnected modules.
   */
  async financeDashboard(): Promise<any> {
    const mgr = this.entryRepository.manager;
    const unbilled = UNBILLED_STATES.map((s) => `'${s}'`).join(',');

    /**
     * Five aggregate queries in place of four whole-table reads.
     *
     * This endpoint used to load every entry, every invoice, every payable AND every payment
     * ever recorded — the last of those with no bound at all — purely to produce twenty
     * scalars and a fifteen-row recent-payments strip. Only that strip needs rows, and it now
     * asks for the fifteen it renders instead of sorting the entire payment history in memory.
     */
    const [entryRows, invoiceRows, ageRows, payableRows, cashRows, conflictRows, recent] = await Promise.all([
      mgr.query(`
        SELECT COALESCE(SUM(total_amount) FILTER (WHERE state IN (${unbilled})), 0)                AS unbilled,
               COALESCE(SUM(total_amount) FILTER (WHERE state = '${BillingState.DISPUTED}'), 0)    AS disputed,
               COALESCE(SUM(taxable_amount), 0) AS net_revenue,
               COALESCE(SUM(tax_amount), 0)     AS gst_collected,
               COALESCE(SUM(tds_amount), 0)     AS tds_by_clients
          FROM billing_entries WHERE is_active = true`),

      mgr.query(`
        SELECT COALESCE(SUM(total), 0)              AS invoiced,
               COALESCE(SUM(paid_amount), 0)        AS collected,
               COALESCE(SUM(outstanding_amount), 0) AS outstanding
          FROM billing_invoices WHERE is_active = true`),

      mgr.query(`SELECT ${BillingEngineService.AGEING_SELECT} FROM billing_invoices WHERE is_active = true`),

      mgr.query(`
        SELECT COALESCE(SUM(total_amount) FILTER (WHERE status = '${AssayerPayableStatus.PENDING}'), 0)  AS awaiting_approval,
               COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE status = '${AssayerPayableStatus.APPROVED}'), 0) AS approved_unpaid,
               COALESCE(SUM(paid_amount), 0)                                                            AS paid,
               COALESCE(SUM(total_amount) FILTER (WHERE status = '${AssayerPayableStatus.ON_HOLD}'), 0)  AS on_hold,
               COALESCE(SUM(total_amount) FILTER (WHERE status = '${AssayerPayableStatus.DISPUTED}'), 0) AS disputed,
               COALESCE(SUM(total_amount), 0)                                                           AS total,
               COALESCE(SUM(base_amount + travel_amount), 0)                                            AS gross_cost,
               COALESCE(SUM(tds_amount), 0)                                                             AS tds_from_assayers
          FROM assayer_payables WHERE is_active = true`),

      mgr.query(`
        SELECT COALESCE(SUM(amount) FILTER (WHERE direction = '${PaymentDirection.INBOUND}'), 0)  AS cash_in,
               COALESCE(SUM(amount) FILTER (WHERE direction = '${PaymentDirection.OUTBOUND}'), 0) AS cash_out,
               COUNT(*) FILTER (WHERE direction = '${PaymentDirection.INBOUND}')::int             AS inbound_count,
               COUNT(*) FILTER (WHERE direction = '${PaymentDirection.OUTBOUND}')::int            AS outbound_count
          FROM billing_payments WHERE is_active = true`),

      mgr.query(`SELECT COUNT(*)::int AS n FROM billing_conflicts WHERE status = '${BillingConflictStatus.OPEN}'`),

      // Only the rows the strip actually renders. `.slice(0, 15)` over every payment ever taken
      // was the whole reason this endpoint read the payments table at all.
      this.paymentRepository.find({ where: { isActive: true }, order: { createdAt: 'DESC' }, take: 15 }),
    ]);

    const n = (v: any) => round2(Number(v ?? 0));
    const e = entryRows[0] ?? {};
    const inv = invoiceRows[0] ?? {};
    const ag = ageRows[0] ?? {};
    const p = payableRows[0] ?? {};
    const cash = cashRows[0] ?? {};

    // Accounts receivable — money clients owe us.
    const receivable = {
      unbilled: n(e.unbilled),
      invoiced: n(inv.invoiced),
      collected: n(inv.collected),
      outstanding: n(inv.outstanding),
      disputed: n(e.disputed),
      aging: {
        current: n(ag.current),
        d1_30: n(ag.d1_30),
        d31_60: n(ag.d31_60),
        d61_90: n(ag.d61_90),
        d90_plus: n(ag.d90_plus),
      },
    };

    // Accounts payable — money we owe assayers for completed work.
    const payable = {
      awaitingApproval: n(p.awaiting_approval),
      approvedUnpaid: n(p.approved_unpaid),
      paid: n(p.paid),
      onHold: n(p.on_hold),
      disputed: n(p.disputed),
      total: n(p.total),
    };

    const netRevenue = n(e.net_revenue);
    const grossCost = n(p.gross_cost);

    // Statutory positions finance has to file: GST collected on sales, TDS
    // withheld by clients from us, and TDS we withheld from assayers.
    const taxPosition = {
      gstCollected: n(e.gst_collected),
      tdsWithheldByClients: n(e.tds_by_clients),
      tdsWithheldFromAssayers: n(p.tds_from_assayers),
    };

    return {
      currency: 'INR',
      receivable,
      payable,
      cashflow: {
        // Real movements, not accruals — what actually hit the bank.
        in: n(cash.cash_in),
        out: n(cash.cash_out),
        net: round2(n(cash.cash_in) - n(cash.cash_out)),
        inboundCount: Number(cash.inbound_count ?? 0),
        outboundCount: Number(cash.outbound_count ?? 0),
      },
      profitability: {
        netRevenue,
        assayerCost: grossCost,
        margin: round2(netRevenue - grossCost),
        marginPct: netRevenue > 0 ? round2(((netRevenue - grossCost) / netRevenue) * 100) : null,
      },
      taxPosition,
      // Working capital: collections still to come, less what we must pay out.
      workingCapital: round2(receivable.outstanding - payable.approvedUnpaid),
      openConflicts: Number(conflictRows[0]?.n ?? 0),
      recentPayments: recent.map((pm) => ({
        id: pm.id,
        direction: pm.direction,
        reference: pm.paymentReference,
        method: pm.method,
        amount: Number(pm.amount),
        date: pm.receivedDate,
      })),
    };
  }

  /**
   * Clients that have billing activity, with a headline figure each. Drives the
   * client selector — previously the UI had no way to scope billing to a client
   * at all, even though every backend filter supported it.
   */
  async clientsWithBilling(): Promise<any[]> {
    return this.entryRepository.manager.query(`
      SELECT c.id                                            AS "clientId",
             c.name                                          AS "clientName",
             cb.payment_terms                                AS "paymentTerms",
             cb.gst_rate                                     AS "gstRate",
             cb.tds_rate                                     AS "tdsRate",
             COUNT(e.id)                                     AS "entryCount",
             COALESCE(SUM(e.total_amount), 0)                AS "revenue",
             COALESCE(SUM(e.outstanding_amount), 0)          AS "outstanding"
        FROM clients c
        LEFT JOIN client_billing cb ON cb.client_id = c.id AND cb.is_active = true
        LEFT JOIN billing_entries e ON e.client_id = c.id AND e.is_active = true
       WHERE c.is_active = true
       GROUP BY c.id, c.name, cb.payment_terms, cb.gst_rate, cb.tds_rate
       ORDER BY c.name
    `);
  }

  private async ensureClient(clientId: string): Promise<void> {
    const c = await this.entryRepository.manager.query(
      `SELECT id FROM clients WHERE id = $1 AND is_active = true`,
      [clientId],
    );
    if (!c?.length) throw new NotFoundException(`Client ${clientId} not found.`);
  }
}
