import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull, EntityManager } from 'typeorm';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { isUniqueViolation } from '../../infrastructure/database/unique-violation';
import { BillingEntryEntity } from './billing-entry.entity';
import { BillingInvoiceEntity } from './invoice.entity';
import { BillingPaymentEntity } from './payment.entity';
import { AssayerPayableEntity } from './payable.entity';
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
  BillingState,
  InvoiceStatus,
  PaymentMethod,
  PaymentDirection,
  AssayerPayableStatus,
  BillingEntityType,
  AssignmentStatus,
  BillingAttentionItem,
  BillingOverview,
  AssignmentMoneyLine,
} from '@fapoms/shared';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import {
  assignmentFee,
  assignmentMoney,
  applyTaxes,
  margin,
  round2,
  MONEY_EPSILON,
  MoneyContext,
  AssignmentMoney,
} from './assignment-money';
import type { ProgressCallback } from '../../infrastructure/queue/queued-job';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * One page of a billing list, and the size of the set it was cut from.
 *
 * `total` is the count across ALL pages, not the length of `items` — the client needs it to
 * draw a pager, and it is the only figure that stays right when the window moves.
 */
export interface BillingPage<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

const BILLING_PAGE_DEFAULT = 50;
/** The most rows any single billing list request can return; the caller cannot raise it. */
const BILLING_PAGE_MAX = 100;

function billingPageWindow(page?: number | string, limit?: number | string) {
  const safeLimit = Math.min(BILLING_PAGE_MAX, Math.max(1, Number(limit) || BILLING_PAGE_DEFAULT));
  const safePage = Math.max(1, Math.trunc(Number(page)) || 1);
  return { skip: (safePage - 1) * safeLimit, take: safeLimit, page: safePage, limit: safeLimit };
}

export interface BookingResult {
  booked: boolean;
  entryId?: string;
  payableId?: string;
  reason?: string;
}

export interface PayoutActionResult {
  done: string[];
  refused: Array<{ id: string; reason: string }>;
}

/** A second client line for an assignment was refused by the database. */
export class DuplicateBillingEntryError extends ConflictException {
  constructor() {
    super('This assignment already has a client line.');
  }
}

/** A second fee payable for an assignment was refused by the database. */
export class DuplicateFeePayableError extends ConflictException {
  constructor() {
    super('This assignment already has a fee payable.');
  }
}

/** A second reimbursement for the same expense claim was refused by the database. */
export class DuplicateReimbursementError extends ConflictException {
  constructor() {
    super('This expense claim has already been reimbursed.');
  }
}

/**
 * How often the reconcile reports progress, in assignments. Each report is a Redis round trip.
 */
const RECONCILE_PROGRESS_INTERVAL = 200;

/** How many items the overview's attention list carries per kind before it says "and more". */
const ATTENTION_LIMIT = 25;

/**
 * The most un-invoiced lines the Invoices tab loads at once.
 *
 * Every line comes back with its labels because the operator ticks them individually, so this is
 * a real payload rather than a count. The response reports `truncated` whenever the cap bites —
 * a capped list that does not say so is the "showing the first 200" defect the old Conflicts tab
 * had, applied to money someone is about to bill.
 */
const INVOICEABLE_LIMIT = 2000;

/**
 * The billing engine: the assignment is the ledger line.
 *
 * When an assignment completes, `bookAssignment` creates — in ONE transaction — the assayer's fee
 * payable (what we owe them) and the client's line (what they owe us), both priced by
 * `assignmentMoney`. Finance then approves and pays payouts, and collects completed assignments
 * into invoices. Everything else on this class is a read over those rows.
 *
 * Every method that moves money or changes a billing state runs inside `inTx` with the rows it
 * touches write-locked, and writes its history row on the same transaction, so the ledger can
 * never hold half a change.
 */
@Injectable()
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

  // -----------------------------------------------------------------------
  // The automatic path: completion books; a fee edit re-prices
  // -----------------------------------------------------------------------

  onModuleInit() {
    this.eventPublisher.subscribe('assignment:status-changed', async (payload: any) => {
      if (payload?.newState !== AssignmentStatus.COMPLETED) return;
      const assignmentId = payload?.assignmentId;
      if (!assignmentId) return;
      // Serialise concurrent bookings of the SAME assignment across replicas. Fail-open: if
      // Redis is unavailable the two unique indexes are the backstop — the loser re-reads the
      // winner's rows and reports them.
      await this.cache.withLock(`lock:billing:book:${assignmentId}`, 30, async () => {
        try {
          const result = await this.bookAssignment(assignmentId);
          if (result.booked) {
            this.logger.log(`Booked assignment ${assignmentId}: entry ${result.entryId}, payable ${result.payableId}.`);
          } else if (result.reason && result.reason !== 'already booked') {
            this.logger.warn(`Assignment ${assignmentId} completed but was not booked: ${result.reason}.`);
          }
        } catch (err) {
          this.logger.error(`Booking failed for assignment ${assignmentId}: ${(err as Error).message}`);
        }
      });
    });

    this.eventPublisher.subscribe('assignment:fee-updated', async (payload: any) => {
      const assignmentId = payload?.assignmentId;
      if (!assignmentId) return;
      try {
        await this.repriceAssignment(assignmentId, payload?.userId ?? 'system');
      } catch (err) {
        this.logger.error(`Re-pricing failed for assignment ${assignmentId}: ${(err as Error).message}`);
      }
    });
  }

  /**
   * Book one completed assignment: its fee payable and its client line, in one transaction.
   *
   * Idempotent. A leg that already exists is left alone and the missing one is written, so the
   * reconcile can repair a half-booked assignment with the same call the event path uses. The
   * at-least-once event bus and the fail-open lock mean two bookings can race between the read
   * and the insert; the unique indexes decide, and the loser reports the winner's rows.
   */
  async bookAssignment(assignmentId: string, userId = 'system'): Promise<BookingResult> {
    try {
      return await this.inTx(async (m, emit) => {
        const a = await m.findOne(AssignmentEntity, { where: { id: assignmentId } });
        if (!a) return { booked: false, reason: 'assignment not found' };
        if (a.status !== AssignmentStatus.COMPLETED) return { booked: false, reason: 'assignment not completed' };
        if (!a.assayerId) return { booked: false, reason: 'no assayer on assignment' };

        const project = a.projectId
          ? await m.findOne(ProjectEntity, { where: { id: a.projectId }, select: ['id', 'clientId'] })
          : null;
        const clientId = project?.clientId;
        if (!clientId) return { booked: false, reason: 'no client for assignment' };

        const [existingEntry, existingPayable] = await Promise.all([
          m.findOne(BillingEntryEntity, { where: { assignmentId } }),
          m.findOne(AssayerPayableEntity, { where: { assignmentId, expenseId: IsNull() } }),
        ]);
        if (existingEntry && existingPayable) {
          return { booked: false, reason: 'already booked', entryId: existingEntry.id, payableId: existingPayable.id };
        }

        const ctx = await this.moneyContextFor(clientId, a.assayerId, a.quotedTravelFee, m);
        const money = assignmentMoney(a, ctx);
        if (money.fee.source === 'NONE') return { booked: false, reason: 'NO_FEE' };

        const payable = existingPayable ?? await this.insertFeePayable(m, a, clientId, money, ctx, userId);
        const entry = existingEntry ?? await this.insertClientLine(m, a, clientId, money, ctx, userId);

        emit('billing:booked', {
          assignmentId: a.id,
          assignmentNumber: a.assignmentNumber,
          assayerId: a.assayerId,
          clientId,
          entryId: entry.id,
          payableId: payable.id,
          settled: money.fee.settled,
        });
        return { booked: true, entryId: entry.id, payableId: payable.id };
      });
    } catch (err) {
      if (
        isUniqueViolation(err, 'UQ_billing_entries_root_per_assignment') ||
        isUniqueViolation(err, 'UQ_assayer_payables_fee_per_assignment')
      ) {
        const [entry, payable] = await Promise.all([
          this.entryRepository.findOne({ where: { assignmentId } }),
          this.payableRepository.findOne({ where: { assignmentId, expenseId: IsNull() } }),
        ]);
        return { booked: false, reason: 'already booked (concurrent)', entryId: entry?.id, payableId: payable?.id };
      }
      throw err;
    }
  }

  /**
   * Re-price a booked assignment after its fee moved.
   *
   * Fee edits are refused once an assignment leaves PENDING and booking happens at COMPLETED,
   * so this is a safety net rather than a workflow. It re-prices what can still be re-priced —
   * an UNBILLED line, an unpaid payable — and leaves the rest alone, because an invoiced line
   * or a paid payable is a record of what was actually billed or paid. The attention list shows
   * "fee changed after booking" for anything this could not touch.
   */
  async repriceAssignment(assignmentId: string, userId = 'system'): Promise<{ repriced: boolean; reason?: string }> {
    return this.inTx(async (m, emit) => {
      const a = await m.findOne(AssignmentEntity, { where: { id: assignmentId } });
      if (!a) return { repriced: false, reason: 'assignment not found' };
      const [entry, payable] = await Promise.all([
        m.findOne(BillingEntryEntity, { where: { assignmentId }, lock: { mode: 'pessimistic_write' } }),
        m.findOne(AssayerPayableEntity, { where: { assignmentId, expenseId: IsNull() }, lock: { mode: 'pessimistic_write' } }),
      ]);
      if (!entry && !payable) return { repriced: false, reason: 'not booked' };

      const clientId = entry?.clientId ?? payable?.clientId ?? null;
      if (!clientId || !a.assayerId) return { repriced: false, reason: 'no client/assayer' };
      const ctx = await this.moneyContextFor(clientId, a.assayerId, a.quotedTravelFee, m, Number(entry?.adjustmentAmount ?? 0));
      const money = assignmentMoney(a, ctx);
      if (money.fee.source === 'NONE') return { repriced: false, reason: 'NO_FEE' };

      let touched = false;
      if (payable && payable.status !== AssayerPayableStatus.PAID && Number(payable.paidAmount) === 0) {
        const before = { baseAmount: Number(payable.baseAmount), travelAmount: Number(payable.travelAmount), tdsAmount: Number(payable.tdsAmount), totalAmount: Number(payable.totalAmount) };
        payable.baseAmount = money.assayer.base;
        payable.travelAmount = money.assayer.travel;
        payable.taxAmount = 0;
        payable.tdsAmount = money.assayer.tds;
        payable.totalAmount = money.assayer.net;
        payable.rateSnapshot = this.payableSnapshot(a, money, ctx);
        payable.updatedBy = userId;
        await m.save(payable);
        await this.history(userId, {
          clientId, projectId: a.projectId, assignmentId, assayerId: a.assayerId,
          entityType: BillingEntityType.PAYABLE, entityId: payable.id, action: 'PAYABLE_REPRICED',
          previousValue: before, newValue: { baseAmount: money.assayer.base, travelAmount: money.assayer.travel, tdsAmount: money.assayer.tds, totalAmount: money.assayer.net },
          reason: 'Assignment fee changed',
        }, m);
        touched = true;
      }
      if (entry && entry.state === BillingState.UNBILLED) {
        const before = this.moneyOf(entry);
        entry.baseAmount = money.client.base;
        entry.travelAmount = money.client.travel;
        entry.taxableAmount = money.client.taxable;
        entry.taxAmount = money.client.gst;
        entry.tdsAmount = money.client.tds;
        entry.totalAmount = money.client.total;
        entry.updatedBy = userId;
        await m.save(entry);
        await this.history(userId, {
          clientId, projectId: a.projectId, assignmentId, assayerId: a.assayerId,
          entityType: BillingEntityType.ENTRY, entityId: entry.id, action: 'ENTRY_REPRICED',
          previousValue: before, newValue: this.moneyOf(entry), reason: 'Assignment fee changed',
        }, m);
        touched = true;
      }
      if (touched) {
        emit('billing:booked', { assignmentId, assayerId: a.assayerId, clientId, entryId: entry?.id, payableId: payable?.id, change: 'REPRICED' });
      }
      return { repriced: touched, reason: touched ? undefined : 'nothing re-priceable' };
    });
  }

  /**
   * The admin repair button: book every COMPLETED assignment that is missing a leg.
   *
   * The automatic path is the event; this exists for the day the event was lost, the lock failed
   * open twice, or a database was restored. `since` limits it to assignments completed on or
   * after a date, so a fresh deployment over an old assignment book does not book years of
   * history nobody asked for.
   */
  async reconcile(
    userId: string,
    opts: { since?: string | null } = {},
    onProgress?: ProgressCallback,
  ): Promise<{ scanned: number; booked: number; skipped: number; errors: Array<{ assignmentId: string; reason: string }> }> {
    const ids = await this.unbookedAssignmentIds(opts.since ?? null);
    let booked = 0;
    let skipped = 0;
    const errors: Array<{ assignmentId: string; reason: string }> = [];
    let scanned = 0;
    for (const id of ids) {
      scanned += 1;
      if (onProgress && scanned % RECONCILE_PROGRESS_INTERVAL === 0) {
        await onProgress(scanned, ids.length, `Booked ${booked} of ${scanned} scanned`);
      }
      try {
        const r = await this.bookAssignment(id, userId);
        if (r.booked) booked += 1;
        else if (r.reason?.startsWith('already booked')) skipped += 1;
        else errors.push({ assignmentId: id, reason: r.reason ?? 'not booked' });
      } catch (err) {
        errors.push({ assignmentId: id, reason: (err as Error).message });
      }
    }
    if (onProgress) await onProgress(ids.length, ids.length, 'Complete');
    if (booked > 0) this.logger.log(`Reconcile: booked ${booked} assignment(s), ${errors.length} error(s).`);
    return { scanned: ids.length, booked, skipped, errors };
  }

  /** What a reconcile would touch — shown to the operator before they press the button. */
  async reconcilePreview(opts: { since?: string | null } = {}): Promise<{ count: number; since: string | null }> {
    const ids = await this.unbookedAssignmentIds(opts.since ?? null);
    return { count: ids.length, since: opts.since ?? null };
  }

  private async unbookedAssignmentIds(since: string | null): Promise<string[]> {
    const rows: Array<{ id: string }> = await this.assignmentRepository.manager.query(
      `SELECT a.id
         FROM assignments a
         LEFT JOIN billing_entries e ON e.assignment_id = a.id
         LEFT JOIN assayer_payables p ON p.assignment_id = a.id AND p.expense_id IS NULL
        WHERE a.status = 'COMPLETED' AND a.is_active = true
          AND (e.id IS NULL OR p.id IS NULL)
          AND ($1::date IS NULL OR a.completion_date >= $1::date)
        ORDER BY a.completion_date ASC NULLS LAST, a.created_at ASC`,
      [since],
    );
    return rows.map((r) => r.id);
  }

  // -----------------------------------------------------------------------
  // Pricing context and the two inserts
  // -----------------------------------------------------------------------

  /**
   * Everything `assignmentMoney` needs that is not on the assignment: the client's rate card and
   * travel policy, both sides' tax rates, and the legacy reimbursement for pre-quote offers.
   */
  private async moneyContextFor(
    clientId: string,
    assayerId: string,
    quotedTravelFee: unknown,
    m: EntityManager,
    adjustmentAmount = 0,
  ): Promise<MoneyContext & { paymentTerms: string | null }> {
    const needsLegacyTravel = quotedTravelFee === null || quotedTravelFee === undefined;
    const [cfgRows, clientRows, billingRows, assayerTds, gstDefault, tdsDefault, profileRows] = await Promise.all([
      m.query(
        `SELECT default_base_fee FROM client_configurations
          WHERE client_id = $1 AND is_active = true
          ORDER BY effective_from DESC NULLS LAST LIMIT 1`,
        [clientId],
      ).catch(() => []),
      m.query(`SELECT planning_preferences FROM clients WHERE id = $1 LIMIT 1`, [clientId]).catch(() => []),
      m.query(`SELECT gst_rate, tds_rate, payment_terms FROM client_billing WHERE client_id = $1 AND is_active = true LIMIT 1`, [clientId]).catch(() => []),
      this.settings.getNumber('billing.tdsRate', 10).catch(() => 10),
      this.settings.getNumber('billing.defaultClientGstRate', 18).catch(() => 18),
      this.settings.getNumber('billing.defaultClientTdsRate', 10).catch(() => 10),
      needsLegacyTravel
        ? m.query(
            `SELECT travel_reimbursement FROM assayer_commercial_profiles
              WHERE assayer_id = $1 AND is_active = true
                AND (effective_end_date IS NULL OR effective_end_date >= NOW())
              ORDER BY effective_start_date DESC LIMIT 1`,
            [assayerId],
          ).catch(() => [])
        : Promise.resolve([]),
    ]);
    const rate = cfgRows?.[0]?.default_base_fee;
    const prefs = clientRows?.[0]?.planning_preferences ?? {};
    const billing = billingRows?.[0];
    return {
      clientRate: rate != null && Number(rate) > 0 ? Number(rate) : null,
      rechargeTravel: prefs?.rechargeTravel !== false,
      gstRate: billing ? Number(billing.gst_rate) : gstDefault,
      clientTdsRate: billing ? Number(billing.tds_rate) : tdsDefault,
      assayerTdsRate: assayerTds,
      legacyTravelReimbursement: needsLegacyTravel && profileRows?.[0]
        ? Number(profileRows[0].travel_reimbursement ?? 0)
        : null,
      adjustmentAmount,
      paymentTerms: billing?.payment_terms ?? null,
    };
  }

  /** The snapshot must justify the amount booked — from the payable alone, forever. */
  private payableSnapshot(a: AssignmentEntity, money: AssignmentMoney, ctx: MoneyContext): Record<string, unknown> {
    return {
      source: 'assignmentMoney',
      feeAmount: money.fee.amount,
      feeSource: money.fee.source,
      settled: money.fee.settled,
      agreedFee: a.agreedFee != null ? Number(a.agreedFee) : null,
      proposedFee: a.proposedFee != null ? Number(a.proposedFee) : null,
      quotedTravelFee: a.quotedTravelFee != null ? Number(a.quotedTravelFee) : null,
      quotedTransportMode: a.quotedTransportMode ?? null,
      quotedDistanceKm: a.quotedDistanceKm != null ? Number(a.quotedDistanceKm) : null,
      quotedDistanceSource: a.quotedDistanceSource ?? null,
      baseAmount: money.assayer.base,
      travelAmount: money.assayer.travel,
      tdsRate: ctx.assayerTdsRate,
      legacyTravelReimbursement: ctx.legacyTravelReimbursement ?? null,
      capturedAt: new Date().toISOString(),
    };
  }

  private async insertFeePayable(
    m: EntityManager,
    a: AssignmentEntity,
    clientId: string,
    money: AssignmentMoney,
    ctx: MoneyContext,
    userId: string,
  ): Promise<AssayerPayableEntity> {
    return this.insertPayable(m, {
      assayerId: a.assayerId as string,
      clientId,
      projectId: a.projectId ?? null,
      assignmentId: a.id,
      expenseId: null,
      baseAmount: money.assayer.base,
      travelAmount: money.assayer.travel,
      tdsAmount: money.assayer.tds,
      totalAmount: money.assayer.net,
      rateSnapshot: this.payableSnapshot(a, money, ctx),
      remarks: money.fee.settled
        ? `Fee for ${a.assignmentNumber}`
        : `Fee for ${a.assignmentNumber} — booked from the PROPOSED fee; no fee was agreed`,
    }, userId);
  }

  private async insertPayable(
    m: EntityManager,
    p: {
      assayerId: string; clientId: string | null; projectId: string | null; assignmentId: string;
      expenseId: string | null; baseAmount: number; travelAmount: number; tdsAmount: number;
      totalAmount: number; rateSnapshot: Record<string, unknown> | null; remarks: string | null;
    },
    userId: string,
  ): Promise<AssayerPayableEntity> {
    const payable = this.payableRepository.create({
      payableNumber: `PY-${Date.now().toString(36).toUpperCase()}-${this.seq()}`,
      assayerId: p.assayerId,
      clientId: p.clientId,
      projectId: p.projectId,
      assignmentId: p.assignmentId,
      expenseId: p.expenseId,
      status: AssayerPayableStatus.PENDING,
      onHold: false,
      holdReason: null,
      baseAmount: p.baseAmount,
      travelAmount: p.travelAmount,
      taxAmount: 0,
      tdsAmount: p.tdsAmount,
      totalAmount: p.totalAmount,
      currency: 'INR',
      paidAmount: 0,
      rateSnapshot: p.rateSnapshot,
      remarks: p.remarks,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await m.save(payable);
    await this.history(userId, {
      clientId: p.clientId,
      projectId: p.projectId,
      assignmentId: p.assignmentId,
      assayerId: p.assayerId,
      entityType: BillingEntityType.PAYABLE,
      entityId: saved.id,
      action: 'PAYABLE_CREATED',
      fromState: null,
      toState: AssayerPayableStatus.PENDING,
      newValue: { baseAmount: p.baseAmount, travelAmount: p.travelAmount, tdsAmount: p.tdsAmount, totalAmount: p.totalAmount, expenseId: p.expenseId },
      reason: p.remarks,
    }, m);
    return saved;
  }

  private async insertClientLine(
    m: EntityManager,
    a: AssignmentEntity,
    clientId: string,
    money: AssignmentMoney,
    ctx: MoneyContext,
    userId: string,
  ): Promise<BillingEntryEntity> {
    const entry = this.entryRepository.create({
      entryNumber: `BE-${Date.now().toString(36).toUpperCase()}-${this.seq()}`,
      clientId,
      projectId: a.projectId ?? null,
      assignmentId: a.id,
      assayerId: a.assayerId ?? null,
      state: BillingState.UNBILLED,
      onHold: false,
      holdReason: null,
      serviceDate: a.completionDate ? this.toISO(a.completionDate) : null,
      description: money.client.pricedFrom === 'CLIENT_RATE'
        ? `${a.assignmentNumber} — billed at the client rate`
        : `${a.assignmentNumber} — no client rate set, billed at the assayer fee`,
      baseAmount: money.client.base,
      travelAmount: money.client.travel,
      adjustmentAmount: 0,
      adjustmentReason: null,
      taxRate: ctx.gstRate,
      taxableAmount: money.client.taxable,
      taxAmount: money.client.gst,
      tdsRate: ctx.clientTdsRate,
      tdsAmount: money.client.tds,
      totalAmount: money.client.total,
      currency: 'INR',
      paidAmount: 0,
      outstandingAmount: 0,
      invoiceId: null,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await m.save(entry);
    await this.history(userId, {
      clientId,
      projectId: a.projectId ?? null,
      assignmentId: a.id,
      assayerId: a.assayerId ?? null,
      entityType: BillingEntityType.ENTRY,
      entityId: saved.id,
      action: 'ENTRY_CREATED',
      fromState: null,
      toState: BillingState.UNBILLED,
      newValue: this.moneyOf(saved),
      reason: saved.description,
    }, m);
    return saved;
  }

  /**
   * Turn an approved expense claim into money the assayer is owed.
   *
   * Takes the caller's manager: `ExpenseService.review` runs the approval and this insert in one
   * transaction, so an approval can never exist without its payable. `expenseId` is a real column
   * with a unique index, so a retried approval is refused by the database rather than paid twice.
   * No TDS on a reimbursement — this is the assayer's own money being returned, not income.
   */
  async createReimbursementPayable(
    expense: { id: string; assayerId: string; assignmentId: string; amount: number | string; category: string; description?: string | null },
    m: EntityManager,
    userId: string,
  ): Promise<AssayerPayableEntity> {
    const a = await m.findOne(AssignmentEntity, { where: { id: expense.assignmentId }, select: ['id', 'projectId', 'assignmentNumber'] });
    const project = a?.projectId
      ? await m.findOne(ProjectEntity, { where: { id: a.projectId }, select: ['id', 'clientId'] })
      : null;
    const amount = round2(Number(expense.amount));
    try {
      return await this.insertPayable(m, {
        assayerId: expense.assayerId,
        clientId: project?.clientId ?? null,
        projectId: a?.projectId ?? null,
        assignmentId: expense.assignmentId,
        expenseId: expense.id,
        baseAmount: amount,
        travelAmount: 0,
        tdsAmount: 0,
        totalAmount: amount,
        rateSnapshot: { source: 'EXPENSE_CLAIM', expenseId: expense.id, category: expense.category },
        remarks: `Expense reimbursement — ${expense.category}${expense.description ? `: ${expense.description}` : ''}`,
      }, userId);
    } catch (err) {
      if (isUniqueViolation(err, 'UQ_assayer_payables_expense')) throw new DuplicateReimbursementError();
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // The client line: adjust and hold, while unbilled
  // -----------------------------------------------------------------------

  async editClientLine(
    assignmentId: string,
    patch: { adjustmentAmount?: number; adjustmentReason?: string; onHold?: boolean; holdReason?: string },
    userId: string,
  ): Promise<BillingEntryEntity> {
    return this.inTx(async (m, emit) => {
      const entry = await m.findOne(BillingEntryEntity, { where: { assignmentId }, lock: { mode: 'pessimistic_write' } });
      if (!entry) throw new NotFoundException('This assignment has no client line yet.');
      if (entry.state !== BillingState.UNBILLED) {
        throw new BadRequestException(
          `This line is ${entry.state.toLowerCase()}. Adjustments and holds apply only before invoicing — cancel the invoice first.`,
        );
      }
      const before = { ...this.moneyOf(entry), onHold: entry.onHold, holdReason: entry.holdReason, adjustmentReason: entry.adjustmentReason };
      const actions: string[] = [];

      if (patch.adjustmentAmount !== undefined) {
        const amount = round2(Number(patch.adjustmentAmount));
        if (!Number.isFinite(amount)) throw new BadRequestException('Adjustment must be a number.');
        if (amount !== 0 && !patch.adjustmentReason?.trim()) {
          throw new BadRequestException('Say why the line is being adjusted.');
        }
        entry.adjustmentAmount = amount;
        entry.adjustmentReason = amount === 0 ? null : patch.adjustmentReason!.trim();
        entry.taxableAmount = round2(Number(entry.baseAmount) + Number(entry.travelAmount) + amount);
        const t = applyTaxes(entry.taxableAmount, { taxRate: entry.taxRate, tdsRate: entry.tdsRate });
        entry.taxAmount = t.taxAmount;
        entry.tdsAmount = t.tdsAmount;
        entry.totalAmount = t.totalAmount;
        actions.push('ENTRY_ADJUSTED');
      }
      if (patch.onHold !== undefined) {
        if (patch.onHold && !patch.holdReason?.trim()) throw new BadRequestException('Say why the line is on hold.');
        entry.onHold = patch.onHold;
        entry.holdReason = patch.onHold ? patch.holdReason!.trim() : null;
        actions.push('ENTRY_HOLD_CHANGED');
      }
      if (!actions.length) return entry;

      entry.updatedBy = userId;
      const saved = await m.save(entry);
      for (const action of actions) {
        await this.history(userId, {
          clientId: saved.clientId, projectId: saved.projectId, assignmentId: saved.assignmentId, assayerId: saved.assayerId,
          entityType: BillingEntityType.ENTRY, entityId: saved.id, action,
          previousValue: before,
          newValue: { ...this.moneyOf(saved), onHold: saved.onHold, holdReason: saved.holdReason, adjustmentReason: saved.adjustmentReason },
          reason: action === 'ENTRY_ADJUSTED' ? saved.adjustmentReason : saved.holdReason,
        }, m);
      }
      emit('billing:booked', { assignmentId, clientId: saved.clientId, assayerId: saved.assayerId, entryId: saved.id, change: 'LINE_EDITED' });
      return saved;
    });
  }

  // -----------------------------------------------------------------------
  // Payouts: approve → pay, and hold
  // -----------------------------------------------------------------------

  /**
   * The one approval gate. Each id gets its own transaction, so one refused payable does not
   * undo the others; the result says exactly which were approved and which were refused, and why.
   * An already-approved payable is a no-op, not an error — the bulk button may be pressed twice.
   */
  async approvePayouts(payableIds: string[], userId: string): Promise<PayoutActionResult> {
    const done: string[] = [];
    const refused: Array<{ id: string; reason: string }> = [];
    for (const id of [...new Set(payableIds)]) {
      try {
        const approved = await this.inTx(async (m, emit) => {
          const p = await this.lockPayable(m, id);
          if (p.status === AssayerPayableStatus.APPROVED) return null;
          if (p.status === AssayerPayableStatus.PAID) throw new ConflictException(`${p.payableNumber} is already paid.`);
          if (p.onHold) throw new ConflictException(`${p.payableNumber} is on hold: ${p.holdReason ?? 'no reason given'}.`);
          p.status = AssayerPayableStatus.APPROVED;
          p.approvedAt = new Date();
          p.approvedBy = userId;
          p.updatedBy = userId;
          const saved = await m.save(p);
          await this.history(userId, {
            clientId: p.clientId, projectId: p.projectId, assignmentId: p.assignmentId, assayerId: p.assayerId,
            entityType: BillingEntityType.PAYABLE, entityId: saved.id, action: 'PAYABLE_STATUS_CHANGED',
            fromState: AssayerPayableStatus.PENDING, toState: AssayerPayableStatus.APPROVED,
          }, m);
          emit('billing:payout-changed', { payableId: saved.id, assayerId: saved.assayerId, status: saved.status, onHold: saved.onHold });
          return saved;
        });
        done.push(id);
        if (approved) {
          this.notifyWithBranch(approved.assignmentId, (branchName) => ({
            type: 'PAYABLE_APPROVED',
            entityType: 'PAYABLE',
            entityId: approved.id,
            actorUserId: userId,
            assayerId: approved.assayerId,
            dedupeKey: `PAYABLE_APPROVED:${approved.id}`,
            payload: { payableId: approved.id, amount: Number(approved.totalAmount), branchName },
          }));
        }
      } catch (err) {
        refused.push({ id, reason: (err as Error).message });
      }
    }
    return { done, refused };
  }

  /**
   * Pay approved payouts, each in full, each as a real disbursement row. The only path to PAID.
   *
   * One bank reference may settle many payables (a batch transfer), so the same reference is
   * allowed across payables; per payable it is the idempotency key.
   */
  async payPayouts(
    payableIds: string[],
    dto: { paymentReference: string; method: PaymentMethod; paidDate?: string; notes?: string },
    userId: string,
  ): Promise<{ done: Array<{ payableId: string; paymentId: string }>; refused: Array<{ id: string; reason: string }> }> {
    const done: Array<{ payableId: string; paymentId: string }> = [];
    const refused: Array<{ id: string; reason: string }> = [];
    for (const id of [...new Set(payableIds)]) {
      try {
        const payment = await this.recordDisbursement({ payableId: id, ...dto }, userId);
        done.push({ payableId: id, paymentId: payment.id });
      } catch (err) {
        refused.push({ id, reason: (err as Error).message });
      }
    }
    return { done, refused };
  }

  async holdPayout(payableId: string, onHold: boolean, reason: string | undefined, userId: string): Promise<AssayerPayableEntity> {
    if (onHold && !reason?.trim()) throw new BadRequestException('Say why the payout is on hold.');
    return this.inTx(async (m, emit) => {
      const p = await this.lockPayable(m, payableId);
      if (p.status === AssayerPayableStatus.PAID) throw new ConflictException(`${p.payableNumber} is already paid.`);
      if (p.onHold === onHold) return p;
      const before = { onHold: p.onHold, holdReason: p.holdReason };
      p.onHold = onHold;
      p.holdReason = onHold ? reason!.trim() : null;
      p.updatedBy = userId;
      const saved = await m.save(p);
      await this.history(userId, {
        clientId: p.clientId, projectId: p.projectId, assignmentId: p.assignmentId, assayerId: p.assayerId,
        entityType: BillingEntityType.PAYABLE, entityId: saved.id, action: 'PAYABLE_HOLD_CHANGED',
        previousValue: before, newValue: { onHold: saved.onHold, holdReason: saved.holdReason }, reason: saved.holdReason,
      }, m);
      emit('billing:payout-changed', { payableId: saved.id, assayerId: saved.assayerId, status: saved.status, onHold: saved.onHold });
      return saved;
    });
  }

  /**
   * Disburse money against an approved payable — the outbound half of the engine, and the only
   * way a payable becomes PAID.
   *
   * Write-locked before the balance guard so two operators cannot both pay the same obligation;
   * idempotent by `paymentReference` so a retried POST returns the original payment rather than
   * paying a second time (`UQ_billing_payments_outbound_ref` backstops any unlocked path).
   */
  async recordDisbursement(dto: {
    payableId: string;
    paymentReference: string;
    method: PaymentMethod;
    amount?: number;
    paidDate?: string;
    notes?: string;
  }, userId: string): Promise<BillingPaymentEntity> {
    let notify: { assignmentId: string | null; assayerId: string; amount: number } | null = null;

    const result = await this.inTx(async (m, emit) => {
      const payable = await this.lockPayable(m, dto.payableId);

      const existing = await m.findOne(BillingPaymentEntity, {
        where: { payableId: payable.id, paymentReference: dto.paymentReference, direction: PaymentDirection.OUTBOUND, isActive: true },
      });
      if (existing) return existing;

      if (payable.onHold) {
        throw new ConflictException(`${payable.payableNumber} is on hold: ${payable.holdReason ?? 'no reason given'}.`);
      }
      if (payable.status !== AssayerPayableStatus.APPROVED) {
        throw new BadRequestException(
          payable.status === AssayerPayableStatus.PAID
            ? `${payable.payableNumber} is already paid.`
            : `${payable.payableNumber} has not been approved yet.`,
        );
      }
      const outstanding = round2(Number(payable.totalAmount) - Number(payable.paidAmount));
      if (outstanding <= 0) throw new ConflictException(`${payable.payableNumber} is already fully paid.`);
      const amount = round2(dto.amount ?? outstanding);
      if (amount <= 0) throw new BadRequestException('Disbursement amount must be positive.');
      if (amount - outstanding > MONEY_EPSILON) {
        throw new BadRequestException(`₹${amount} exceeds the ₹${outstanding} still owed on ${payable.payableNumber}.`);
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

      // Computed on the transaction's own connection so it sees the `paidAmount` just written.
      const balance = (await this.assayerTotals(payable.assayerId, m)).outstanding;

      const payment = this.paymentRepository.create({
        paymentReference: dto.paymentReference,
        direction: PaymentDirection.OUTBOUND,
        method: dto.method,
        amount,
        currency: payable.currency,
        receivedDate: dto.paidDate ?? new Date().toISOString().slice(0, 10),
        payableId: payable.id,
        assayerId: payable.assayerId,
        runningBalance: balance,
        invoiceId: null,
        notes: dto.notes ?? null,
        createdBy: userId,
        updatedBy: userId,
      });
      const saved = await m.save(payment);

      await this.history(userId, {
        clientId: payable.clientId, projectId: payable.projectId, assignmentId: payable.assignmentId, assayerId: payable.assayerId,
        entityType: BillingEntityType.PAYMENT, entityId: saved.id, action: 'DISBURSEMENT_PAID',
        fromState: fromStatus, toState: payable.status,
        newValue: { amount, paymentReference: dto.paymentReference, payableId: payable.id, balanceAfter: balance },
        reason: dto.notes ?? null,
      }, m);
      emit('billing:payout-changed', { payableId: payable.id, assayerId: payable.assayerId, status: payable.status, onHold: payable.onHold, paymentId: saved.id, amount });
      if (fullyPaid) notify = { assignmentId: payable.assignmentId, assayerId: payable.assayerId, amount: Number(payable.paidAmount) };
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
        dedupeKey: `PAYABLE_PAID:${dto.payableId}:${dto.paymentReference}`,
        payload: { paymentId: result.id, payableId: dto.payableId, amount, branchName, paymentReference: dto.paymentReference },
      }));
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Invoices: create → send → collect, and cancel
  // -----------------------------------------------------------------------

  /**
   * Invoice a set of completed assignments for one client.
   *
   * The lines are write-locked by assignment so two operators invoicing overlapping selections
   * cannot both bill the same work; every guard runs against what actually committed.
   */
  async createInvoice(dto: {
    clientId: string;
    assignmentIds: string[];
    issueDate?: string;
    dueDate?: string;
    notes?: string;
  }, userId: string): Promise<BillingInvoiceEntity> {
    const assignmentIds = [...new Set(dto.assignmentIds ?? [])];
    if (!assignmentIds.length) throw new BadRequestException('Pick at least one assignment to invoice.');

    return this.inTx(async (m, emit) => {
      const entries = await m
        .createQueryBuilder(BillingEntryEntity, 'e')
        .setLock('pessimistic_write')
        .where('e.assignment_id IN (:...assignmentIds)', { assignmentIds })
        .orderBy('e.id', 'ASC')
        .getMany();
      if (entries.length !== assignmentIds.length) {
        const found = new Set(entries.map((e) => e.assignmentId));
        const missing = assignmentIds.filter((id) => !found.has(id));
        throw new NotFoundException(`${missing.length} assignment(s) have no client line yet: ${missing.join(', ')}.`);
      }
      const foreign = entries.filter((e) => e.clientId !== dto.clientId);
      if (foreign.length) throw new BadRequestException(`${foreign.length} line(s) belong to a different client.`);
      const held = entries.filter((e) => e.onHold);
      if (held.length) throw new ConflictException(`${held.map((e) => e.entryNumber).join(', ')} on hold — release before invoicing.`);
      const notUnbilled = entries.filter((e) => e.state !== BillingState.UNBILLED || e.invoiceId);
      if (notUnbilled.length) {
        throw new ConflictException(`${notUnbilled.map((e) => e.entryNumber).join(', ')} already invoiced.`);
      }

      const subtotal = round2(entries.reduce((s, e) => s + Number(e.taxableAmount), 0));
      const tax = round2(entries.reduce((s, e) => s + Number(e.taxAmount), 0));
      const tds = round2(entries.reduce((s, e) => s + Number(e.tdsAmount), 0));
      const total = round2(entries.reduce((s, e) => s + Number(e.totalAmount), 0));
      const projectIds = new Set(entries.map((e) => e.projectId).filter(Boolean));

      const terms = await this.clientPaymentTerms(dto.clientId, m);
      const issueDate = dto.issueDate ?? new Date().toISOString().slice(0, 10);

      const invoice = this.invoiceRepository.create({
        invoiceNumber: `INV-${Date.now().toString(36).toUpperCase()}-${this.seq()}`,
        clientId: dto.clientId,
        projectId: projectIds.size === 1 ? ([...projectIds][0] as string) : null,
        status: InvoiceStatus.DRAFT,
        issueDate,
        dueDate: dto.dueDate ?? this.dueDateFromTerms(issueDate, terms),
        currency: entries[0].currency,
        subtotal,
        taxAmount: tax,
        tdsAmount: tds,
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
        e.outstandingAmount = Number(e.totalAmount);
        e.updatedBy = userId;
        await m.save(e);
        await this.history(userId, {
          clientId: e.clientId, projectId: e.projectId, assignmentId: e.assignmentId, assayerId: e.assayerId,
          entityType: BillingEntityType.ENTRY, entityId: e.id, action: 'ENTRY_INVOICED',
          fromState: BillingState.UNBILLED, toState: BillingState.INVOICED,
          newValue: { invoiceId: saved.id, invoiceNumber: saved.invoiceNumber, totalAmount: Number(e.totalAmount) },
        }, m);
      }
      await this.history(userId, {
        clientId: saved.clientId, projectId: saved.projectId,
        entityType: BillingEntityType.INVOICE, entityId: saved.id, action: 'INVOICE_CREATED',
        fromState: null, toState: InvoiceStatus.DRAFT,
        newValue: { total: saved.total, assignmentIds },
      }, m);
      emit('billing:invoice-changed', { invoiceId: saved.id, clientId: saved.clientId, status: saved.status });
      return saved;
    });
  }

  async sendInvoice(invoiceId: string, userId: string): Promise<BillingInvoiceEntity> {
    return this.inTx(async (m, emit) => {
      const invoice = await this.lockInvoice(m, invoiceId);
      if (invoice.status === InvoiceStatus.ISSUED) return invoice;
      if (invoice.status !== InvoiceStatus.DRAFT) {
        throw new ConflictException(`${invoice.invoiceNumber} is ${invoice.status.toLowerCase()} and cannot be sent.`);
      }
      invoice.status = InvoiceStatus.ISSUED;
      if (!invoice.issueDate) invoice.issueDate = new Date().toISOString().slice(0, 10);
      if (!invoice.dueDate) {
        invoice.dueDate = this.dueDateFromTerms(invoice.issueDate, await this.clientPaymentTerms(invoice.clientId, m));
      }
      invoice.updatedBy = userId;
      const saved = await m.save(invoice);
      await this.history(userId, {
        clientId: saved.clientId, projectId: saved.projectId,
        entityType: BillingEntityType.INVOICE, entityId: saved.id, action: 'INVOICE_STATUS_CHANGED',
        fromState: InvoiceStatus.DRAFT, toState: InvoiceStatus.ISSUED,
      }, m);
      emit('billing:invoice-changed', { invoiceId: saved.id, clientId: saved.clientId, status: saved.status });
      return saved;
    });
  }

  /** Cancel an unpaid invoice. Its lines go back to UNBILLED — the work is still billable. */
  async cancelInvoice(invoiceId: string, reason: string, userId: string): Promise<BillingInvoiceEntity> {
    if (!reason?.trim()) throw new BadRequestException('Say why the invoice is being cancelled.');
    return this.inTx(async (m, emit) => {
      const invoice = await this.lockInvoice(m, invoiceId);
      if (invoice.status === InvoiceStatus.CANCELLED) return invoice;
      if (invoice.status === InvoiceStatus.PAID || Number(invoice.paidAmount) > 0) {
        throw new ConflictException(
          `${invoice.invoiceNumber} has ₹${Number(invoice.paidAmount)} collected against it. Reverse the payment(s) first.`,
        );
      }
      const entries = await this.lockEntriesByInvoice(m, invoice.id);
      const fromStatus = invoice.status;
      invoice.status = InvoiceStatus.CANCELLED;
      invoice.outstandingAmount = 0;
      invoice.updatedBy = userId;
      const saved = await m.save(invoice);
      for (const e of entries) {
        e.invoiceId = null;
        e.state = BillingState.UNBILLED;
        e.paidAmount = 0;
        e.outstandingAmount = 0;
        e.updatedBy = userId;
        await m.save(e);
        await this.history(userId, {
          clientId: e.clientId, projectId: e.projectId, assignmentId: e.assignmentId, assayerId: e.assayerId,
          entityType: BillingEntityType.ENTRY, entityId: e.id, action: 'ENTRY_UNINVOICED',
          fromState: BillingState.INVOICED, toState: BillingState.UNBILLED,
          newValue: { invoiceId: saved.id, invoiceNumber: saved.invoiceNumber }, reason: reason.trim(),
        }, m);
      }
      await this.history(userId, {
        clientId: saved.clientId, projectId: saved.projectId,
        entityType: BillingEntityType.INVOICE, entityId: saved.id, action: 'INVOICE_STATUS_CHANGED',
        fromState: fromStatus, toState: InvoiceStatus.CANCELLED, reason: reason.trim(),
      }, m);
      emit('billing:invoice-changed', { invoiceId: saved.id, clientId: saved.clientId, status: saved.status });
      return saved;
    });
  }

  /**
   * Record money received against a sent invoice.
   *
   * The invoice is write-locked before the overpayment guard; idempotent by `paymentReference`.
   * Collection is spread across the invoice's lines in proportion to their totals (see
   * `applyInvoiceCollection`) — there is no per-line allocation to get wrong.
   */
  async recordPayment(dto: {
    invoiceId: string;
    paymentReference: string;
    method: PaymentMethod;
    amount: number;
    receivedDate?: string;
    notes?: string;
  }, userId: string): Promise<BillingPaymentEntity> {
    if (!(Number(dto.amount) > 0)) throw new BadRequestException('Payment amount must be positive.');
    const amount = round2(Number(dto.amount));

    return this.inTx(async (m, emit) => {
      const invoice = await this.lockInvoice(m, dto.invoiceId);

      const existing = await m.findOne(BillingPaymentEntity, {
        where: { invoiceId: invoice.id, paymentReference: dto.paymentReference, direction: PaymentDirection.INBOUND, isActive: true },
      });
      if (existing) return existing;

      if (invoice.status !== InvoiceStatus.ISSUED) {
        throw new BadRequestException(
          invoice.status === InvoiceStatus.DRAFT
            ? `${invoice.invoiceNumber} has not been sent yet.`
            : `${invoice.invoiceNumber} is ${invoice.status.toLowerCase()}.`,
        );
      }
      const remaining = round2(Number(invoice.outstandingAmount) - amount);
      if (remaining < -MONEY_EPSILON) {
        throw new BadRequestException(`₹${amount} exceeds the ₹${Number(invoice.outstandingAmount)} outstanding on ${invoice.invoiceNumber}.`);
      }

      const entries = await this.lockEntriesByInvoice(m, invoice.id);

      const payment = this.paymentRepository.create({
        invoiceId: invoice.id,
        paymentReference: dto.paymentReference,
        direction: PaymentDirection.INBOUND,
        method: dto.method,
        amount,
        currency: invoice.currency,
        receivedDate: dto.receivedDate ?? new Date().toISOString().slice(0, 10),
        notes: dto.notes ?? null,
        createdBy: userId,
        updatedBy: userId,
      });
      const saved = await m.save(payment);

      const fromStatus = invoice.status;
      invoice.paidAmount = round2(Number(invoice.paidAmount) + amount);
      await this.applyInvoiceCollection(m, invoice, entries, userId);

      await this.history(userId, {
        clientId: invoice.clientId, projectId: invoice.projectId,
        entityType: BillingEntityType.PAYMENT, entityId: saved.id, action: 'PAYMENT_RECEIVED',
        fromState: fromStatus, toState: invoice.status,
        newValue: { amount, paymentReference: dto.paymentReference, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
        reason: dto.notes ?? null,
      }, m);
      emit('billing:invoice-changed', { invoiceId: invoice.id, clientId: invoice.clientId, status: invoice.status, paymentId: saved.id, amount });
      return saved;
    });
  }

  /**
   * Reverse a payment: the row is retired (`isActive = false`), and the invoice or payable it
   * settled has its paid total recomputed from the payments that remain. Nothing is deleted and
   * nothing goes negative — the trail shows the payment, the reversal, and the reason.
   */
  async reversePayment(paymentId: string, reason: string, userId: string): Promise<BillingPaymentEntity> {
    if (!reason?.trim()) throw new BadRequestException('Say why the payment is being reversed.');
    return this.inTx(async (m, emit) => {
      // The parent (invoice or payable) is the lock that serialises reversal against recording;
      // the payment itself is re-read under that lock so two concurrent reversals cannot both
      // find it active.
      const probe = await m.findOne(BillingPaymentEntity, { where: { id: paymentId } });
      if (!probe) throw new NotFoundException(`Payment ${paymentId} not found.`);

      if (probe.direction === PaymentDirection.INBOUND && probe.invoiceId) {
        const invoice = await this.lockInvoice(m, probe.invoiceId);
        const payment = await m.findOne(BillingPaymentEntity, { where: { id: paymentId } });
        if (!payment?.isActive) throw new ConflictException('This payment has already been reversed.');
        payment.isActive = false;
        payment.updatedBy = userId;
        await m.save(payment);

        const entries = await this.lockEntriesByInvoice(m, invoice.id);
        const sumRows = await m.query(
          `SELECT COALESCE(SUM(amount), 0) AS paid FROM billing_payments
            WHERE invoice_id = $1 AND direction = 'INBOUND' AND is_active = true`,
          [invoice.id],
        );
        const fromStatus = invoice.status;
        invoice.paidAmount = round2(Number(sumRows?.[0]?.paid ?? 0));
        if (invoice.status === InvoiceStatus.PAID) invoice.status = InvoiceStatus.ISSUED;
        await this.applyInvoiceCollection(m, invoice, entries, userId);
        await this.history(userId, {
          clientId: invoice.clientId, projectId: invoice.projectId,
          entityType: BillingEntityType.PAYMENT, entityId: payment.id, action: 'PAYMENT_REVERSED',
          fromState: fromStatus, toState: invoice.status,
          newValue: { amount: Number(payment.amount), paymentReference: payment.paymentReference, invoiceId: invoice.id },
          reason: reason.trim(),
        }, m);
        emit('billing:invoice-changed', { invoiceId: invoice.id, clientId: invoice.clientId, status: invoice.status, reversedPaymentId: payment.id });
        return payment;
      }

      if (probe.direction === PaymentDirection.OUTBOUND && probe.payableId) {
        const payable = await this.lockPayable(m, probe.payableId);
        const payment = await m.findOne(BillingPaymentEntity, { where: { id: paymentId } });
        if (!payment?.isActive) throw new ConflictException('This payment has already been reversed.');
        payment.isActive = false;
        payment.updatedBy = userId;
        await m.save(payment);

        const sumRows = await m.query(
          `SELECT COALESCE(SUM(amount), 0) AS paid FROM billing_payments
            WHERE payable_id = $1 AND direction = 'OUTBOUND' AND is_active = true`,
          [payable.id],
        );
        const fromStatus = payable.status;
        payable.paidAmount = round2(Number(sumRows?.[0]?.paid ?? 0));
        if (payable.status === AssayerPayableStatus.PAID && Number(payable.totalAmount) - payable.paidAmount > MONEY_EPSILON) {
          payable.status = AssayerPayableStatus.APPROVED;
          payable.paidAt = null;
          payable.paidBy = null;
        }
        payable.updatedBy = userId;
        await m.save(payable);
        await this.history(userId, {
          clientId: payable.clientId, projectId: payable.projectId, assignmentId: payable.assignmentId, assayerId: payable.assayerId,
          entityType: BillingEntityType.PAYMENT, entityId: payment.id, action: 'PAYMENT_REVERSED',
          fromState: fromStatus, toState: payable.status,
          newValue: { amount: Number(payment.amount), paymentReference: payment.paymentReference, payableId: payable.id },
          reason: reason.trim(),
        }, m);
        emit('billing:payout-changed', { payableId: payable.id, assayerId: payable.assayerId, status: payable.status, onHold: payable.onHold, reversedPaymentId: payment.id });
        return payment;
      }

      throw new ConflictException('This payment is not attached to an invoice or a payable and cannot be reversed.');
    });
  }

  /**
   * Spread what an invoice has collected across its lines, in proportion to each line's total,
   * and settle the states. Used after every payment and every reversal, so the lines are always
   * a pure function of the invoice's paid total — never the residue of a sequence of allocations.
   */
  private async applyInvoiceCollection(
    m: EntityManager,
    invoice: BillingInvoiceEntity,
    entries: BillingEntryEntity[],
    userId: string,
  ): Promise<void> {
    const total = Number(invoice.total);
    const paid = round2(Number(invoice.paidAmount));
    invoice.outstandingAmount = round2(total - paid);
    if (Math.abs(invoice.outstandingAmount) < MONEY_EPSILON) invoice.outstandingAmount = 0;
    if (invoice.outstandingAmount <= 0 && invoice.status === InvoiceStatus.ISSUED) invoice.status = InvoiceStatus.PAID;
    invoice.updatedBy = userId;
    await m.save(invoice);

    let allocated = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      const lineTotal = Number(e.totalAmount);
      const share = i === entries.length - 1
        ? round2(paid - allocated)
        : (total > 0 ? round2((lineTotal / total) * paid) : 0);
      const linePaid = Math.min(Math.max(0, share), lineTotal);
      allocated = round2(allocated + linePaid);
      e.paidAmount = linePaid;
      e.outstandingAmount = round2(lineTotal - linePaid);
      if (e.outstandingAmount < MONEY_EPSILON) e.outstandingAmount = 0;
      e.state = e.outstandingAmount <= 0 && lineTotal > 0 ? BillingState.PAID : BillingState.INVOICED;
      e.updatedBy = userId;
      await m.save(e);
    }
  }

  // -----------------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------------

  /** The one predicate for "what is owed to this assayer", used by every screen that says so. */
  async assayerTotals(assayerId: string, manager?: EntityManager): Promise<{
    earned: number; paid: number; outstanding: number; awaitingApproval: number; onHoldOrDisputed: number; payableCount: number;
  }> {
    const rows = await (manager ?? this.payableRepository.manager).query(
      `SELECT COALESCE(SUM(total_amount), 0)                                                         AS earned,
              COALESCE(SUM(paid_amount), 0)                                                          AS paid,
              COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE on_hold = false), 0)            AS outstanding,
              COALESCE(SUM(total_amount) FILTER (WHERE status = 'PENDING' AND on_hold = false), 0)   AS awaiting_approval,
              COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE on_hold = true), 0)             AS on_hold,
              COUNT(*)::int                                                                          AS payable_count
         FROM assayer_payables
        WHERE assayer_id = $1 AND is_active = true`,
      [assayerId],
    );
    const r = rows?.[0] ?? {};
    return {
      earned: round2(Number(r.earned ?? 0)),
      paid: round2(Number(r.paid ?? 0)),
      outstanding: round2(Number(r.outstanding ?? 0)),
      awaitingApproval: round2(Number(r.awaiting_approval ?? 0)),
      onHoldOrDisputed: round2(Number(r.on_hold ?? 0)),
      payableCount: Number(r.payable_count ?? 0),
    };
  }

  /**
   * An assayer's financial statement: what they earned, what we have paid, what is still owed,
   * and the rows behind it. The mobile app's Earnings screen is this, verbatim — it never
   * computes money of its own.
   */
  async assayerStatement(assayerId: string): Promise<any> {
    const [totals, payables, payments, assayer] = await Promise.all([
      this.assayerTotals(assayerId),
      this.payableRepository.find({ where: { assayerId, isActive: true }, order: { createdAt: 'DESC' } }),
      this.paymentRepository.find({ where: { assayerId, direction: PaymentDirection.OUTBOUND, isActive: true }, order: { createdAt: 'DESC' } }),
      this.payableRepository.manager.query(`SELECT display_name, assayer_code FROM assayers WHERE id = $1 LIMIT 1`, [assayerId]),
    ]);
    return {
      assayerId,
      assayerName: assayer?.[0]?.display_name ?? null,
      assayerCode: assayer?.[0]?.assayer_code ?? null,
      totals,
      payables: payables.map((p) => ({
        id: p.id,
        payableNumber: p.payableNumber,
        status: p.status,
        onHold: p.onHold,
        holdReason: p.holdReason,
        assignmentId: p.assignmentId,
        expenseId: p.expenseId,
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

  /** A page of payouts with their labels — what the Payouts tab renders. */
  async listPayouts(filters: {
    assayerId?: string; clientId?: string; status?: AssayerPayableStatus; onHold?: boolean;
    page?: number | string; limit?: number | string;
  } = {}): Promise<BillingPage<any>> {
    const w = billingPageWindow(filters.page, filters.limit);
    const where: Record<string, unknown> = { isActive: true };
    if (filters.assayerId) where.assayerId = filters.assayerId;
    if (filters.clientId) where.clientId = filters.clientId;
    if (filters.status) where.status = filters.status;
    if (filters.onHold !== undefined) where.onHold = filters.onHold;
    const [payables, total] = await this.payableRepository.findAndCount({
      where, order: { createdAt: 'DESC' }, skip: w.skip, take: w.take,
    });
    return { items: await this.attachPayableNames(payables), total, page: w.page, limit: w.limit };
  }

  /**
   * Completed work not yet on an invoice, grouped by client — the left-hand side of the Invoices
   * tab. Held lines are listed too (greyed by the UI) so finance can see why a client's total is
   * short; the create call refuses them.
   *
   * Bounded, and it SAYS so when the bound bites: `truncated` is what stops a capped list from
   * reading as "this is everything you have to invoice". A client past the cap is invoiced a
   * screenful at a time — scope to that client and the cap stops applying.
   */
  async listInvoiceable(filters: { clientId?: string } = {}): Promise<{
    clients: Array<{ clientId: string; clientName: string; total: number; count: number; lines: any[] }>;
    total: number;
    truncated: boolean;
  }> {
    const rows = await this.entryRepository.manager.query(
      `SELECT e.id, e.entry_number, e.client_id, c.name AS client_name, e.project_id, p.name AS project_name,
              e.assignment_id, a.assignment_number, b.name AS branch_name, e.assayer_id, s.display_name AS assayer_name,
              e.service_date, e.on_hold, e.hold_reason, e.base_amount, e.travel_amount, e.adjustment_amount,
              e.taxable_amount, e.tax_amount, e.tds_amount, e.total_amount
         FROM billing_entries e
         JOIN clients c ON c.id = e.client_id
         LEFT JOIN projects p ON p.id = e.project_id
         LEFT JOIN assignments a ON a.id = e.assignment_id
         LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
         LEFT JOIN branches b ON b.id = pb.branch_id
         LEFT JOIN assayers s ON s.id = e.assayer_id
        WHERE e.is_active = true AND e.state = 'UNBILLED'
          AND ($1::uuid IS NULL OR e.client_id = $1::uuid)
        ORDER BY c.name ASC, e.service_date DESC NULLS LAST, e.created_at DESC
        LIMIT ${INVOICEABLE_LIMIT}`,
      [filters.clientId ?? null],
    );
    const byClient = new Map<string, { clientId: string; clientName: string; total: number; count: number; lines: any[] }>();
    for (const r of rows) {
      const g = byClient.get(r.client_id) ?? { clientId: r.client_id, clientName: r.client_name, total: 0, count: 0, lines: [] as any[] };
      const line = {
        entryId: r.id,
        entryNumber: r.entry_number,
        assignmentId: r.assignment_id,
        assignmentNumber: r.assignment_number,
        projectId: r.project_id,
        projectName: r.project_name,
        branchName: r.branch_name,
        assayerId: r.assayer_id,
        assayerName: r.assayer_name,
        serviceDate: r.service_date,
        onHold: !!r.on_hold,
        holdReason: r.hold_reason,
        baseAmount: Number(r.base_amount),
        travelAmount: Number(r.travel_amount),
        adjustmentAmount: Number(r.adjustment_amount),
        taxableAmount: Number(r.taxable_amount),
        taxAmount: Number(r.tax_amount),
        tdsAmount: Number(r.tds_amount),
        totalAmount: Number(r.total_amount),
      };
      g.lines.push(line);
      if (!line.onHold) { g.total = round2(g.total + line.totalAmount); g.count += 1; }
      byClient.set(r.client_id, g);
    }
    return { clients: [...byClient.values()], total: rows.length, truncated: rows.length >= INVOICEABLE_LIMIT };
  }

  /** Client lines with their labels — the export and the assignment filter read this. */
  async listClientLines(filters: {
    clientId?: string; projectId?: string; assignmentId?: string; assayerId?: string; state?: BillingState; onHold?: boolean;
  } = {}): Promise<any[]> {
    const where: Record<string, unknown> = {};
    if (filters.clientId) where.clientId = filters.clientId;
    if (filters.projectId) where.projectId = filters.projectId;
    if (filters.assignmentId) where.assignmentId = filters.assignmentId;
    if (filters.assayerId) where.assayerId = filters.assayerId;
    if (filters.state) where.state = filters.state;
    if (filters.onHold !== undefined) where.onHold = filters.onHold;
    const entries = await this.entryRepository.find({ where, order: { createdAt: 'DESC' } });
    return this.attachEntryNames(entries);
  }

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

  /** One page of invoices, with a line count and the client's name, and never the lines. */
  async findInvoicesPage(
    filters: { clientId?: string; projectId?: string; status?: InvoiceStatus; page?: number | string; limit?: number | string } = {},
  ): Promise<BillingPage<BillingInvoiceEntity & { entryCount: number; clientName: string | null }>> {
    const w = billingPageWindow(filters.page, filters.limit);
    const [invoices, total] = await this.invoiceRepository.findAndCount({
      where: this.invoiceWhere(filters), order: { createdAt: 'DESC' }, skip: w.skip, take: w.take,
    });
    const ids = invoices.map((i) => i.id);
    const clientIds = [...new Set(invoices.map((i) => i.clientId))];
    const [countRows, clientRows] = await Promise.all([
      ids.length
        ? this.invoiceRepository.manager.query(`SELECT invoice_id, COUNT(*) AS n FROM billing_entries WHERE invoice_id = ANY($1) GROUP BY invoice_id`, [ids])
        : [],
      clientIds.length
        ? this.invoiceRepository.manager.query(`SELECT id, name FROM clients WHERE id = ANY($1)`, [clientIds])
        : [],
    ]);
    const countById = new Map<string, number>(countRows.map((r: any) => [r.invoice_id, Number(r.n)]));
    const clientName = new Map<string, string>(clientRows.map((r: any) => [r.id, r.name]));
    return {
      items: invoices.map((i) => Object.assign(i, { entryCount: countById.get(i.id) ?? 0, clientName: clientName.get(i.clientId) ?? null })),
      total, page: w.page, limit: w.limit,
    };
  }

  async getInvoice(invoiceId: string): Promise<any> {
    const invoice = await this.invoiceRepository.findOne({ where: { id: invoiceId }, relations: ['entries', 'payments'] });
    if (!invoice) throw new NotFoundException(`Invoice ${invoiceId} not found.`);
    const [entries, clientRows] = await Promise.all([
      this.attachEntryNames(invoice.entries ?? []),
      this.invoiceRepository.manager.query(`SELECT name FROM clients WHERE id = $1`, [invoice.clientId]),
    ]);
    return { ...invoice, entries, clientName: clientRows?.[0]?.name ?? null, payments: (invoice.payments ?? []).filter((p) => p.isActive) };
  }

  /** Everything money-related about one assignment — the one line the assignment detail shows. */
  async assignmentMoneyLine(assignmentId: string): Promise<AssignmentMoneyLine> {
    const a = await this.assignmentRepository.findOne({ where: { id: assignmentId } });
    if (!a) throw new NotFoundException(`Assignment ${assignmentId} not found.`);
    const [entry, payables, history] = await Promise.all([
      this.entryRepository.findOne({ where: { assignmentId } }),
      this.payableRepository.find({ where: { assignmentId, isActive: true }, order: { createdAt: 'ASC' } }),
      this.historyRepository.find({ where: { assignmentId }, order: { createdAt: 'DESC' }, take: 50 }),
    ]);
    const payable = payables.find((p) => !p.expenseId) ?? null;
    const reimbursements = payables.filter((p) => !!p.expenseId);
    const payableIds = payables.map((p) => p.id);
    const [invoice, outbound, inbound] = await Promise.all([
      entry?.invoiceId ? this.invoiceRepository.findOne({ where: { id: entry.invoiceId } }) : null,
      payableIds.length ? this.paymentRepository.find({ where: { payableId: In(payableIds), isActive: true }, order: { createdAt: 'DESC' } }) : [],
      entry?.invoiceId ? this.paymentRepository.find({ where: { invoiceId: entry.invoiceId, isActive: true }, order: { createdAt: 'DESC' } }) : [],
    ]);
    const fee = assignmentFee(a);
    return {
      assignmentId,
      assignmentNumber: a.assignmentNumber ?? null,
      assignmentStatus: a.status ?? null,
      booked: !!(entry && payable),
      fee: fee.source === 'NONE' ? null : fee,
      payable: payable as any,
      reimbursements: reimbursements as any,
      entry: entry as any,
      invoice: invoice
        ? { id: invoice.id, invoiceNumber: invoice.invoiceNumber, status: invoice.status, issueDate: invoice.issueDate, dueDate: invoice.dueDate, total: Number(invoice.total), paidAmount: Number(invoice.paidAmount), outstandingAmount: Number(invoice.outstandingAmount) }
        : null,
      payments: [...outbound, ...inbound] as any,
      history: history as any,
    };
  }

  /**
   * The finance overview — every headline figure, from one endpoint, off one set of rows. Each
   * figure is one grouped pass in Postgres; the attention list is derived, never stored.
   */
  async overview(): Promise<BillingOverview> {
    const mgr = this.entryRepository.manager;
    const n = (v: any) => round2(Number(v ?? 0));
    const [payRows, entryRows, invRows, ageRows, cashRows, clientRows, history, attention] = await Promise.all([
      mgr.query(`
        SELECT COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE status = 'PENDING'  AND on_hold = false), 0) AS due,
               COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE status = 'APPROVED' AND on_hold = false), 0) AS approved,
               COALESCE(SUM(paid_amount), 0)                                                                    AS paid,
               COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE on_hold = true), 0)                        AS held,
               COUNT(*) FILTER (WHERE status = 'PENDING'  AND on_hold = false)::int                              AS due_count,
               COUNT(*) FILTER (WHERE status = 'APPROVED' AND on_hold = false)::int                              AS approved_count,
               COUNT(*) FILTER (WHERE on_hold = true)::int                                                       AS held_count,
               COALESCE(SUM(base_amount + travel_amount), 0)                                                     AS gross_cost,
               COALESCE(SUM(tds_amount), 0)                                                                      AS tds_from_assayers
          FROM assayer_payables WHERE is_active = true`),
      mgr.query(`
        SELECT COALESCE(SUM(total_amount) FILTER (WHERE state = 'UNBILLED' AND on_hold = false), 0) AS unbilled,
               COALESCE(SUM(total_amount) FILTER (WHERE on_hold = true AND state <> 'CANCELLED'), 0) AS held,
               COALESCE(SUM(taxable_amount) FILTER (WHERE state <> 'CANCELLED'), 0)                AS revenue,
               COALESCE(SUM(tax_amount) FILTER (WHERE state <> 'CANCELLED'), 0)                    AS gst,
               COALESCE(SUM(tds_amount) FILTER (WHERE state <> 'CANCELLED'), 0)                    AS tds_by_clients
          FROM billing_entries WHERE is_active = true`),
      mgr.query(`
        SELECT COALESCE(SUM(total) FILTER (WHERE status IN ('ISSUED','PAID')), 0)            AS invoiced,
               COALESCE(SUM(paid_amount) FILTER (WHERE status <> 'CANCELLED'), 0)            AS collected,
               COALESCE(SUM(outstanding_amount) FILTER (WHERE status = 'ISSUED'), 0)         AS outstanding
          FROM billing_invoices WHERE is_active = true`),
      mgr.query(`SELECT ${BillingEngineService.AGEING_SELECT} FROM billing_invoices WHERE is_active = true AND status = 'ISSUED'`),
      mgr.query(`
        SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'INBOUND'), 0)  AS cash_in,
               COALESCE(SUM(amount) FILTER (WHERE direction = 'OUTBOUND'), 0) AS cash_out
          FROM billing_payments WHERE is_active = true`),
      mgr.query(`
        SELECT c.id AS client_id, c.name AS client_name,
               (SELECT cc.default_base_fee FROM client_configurations cc
                 WHERE cc.client_id = c.id AND cc.is_active = true
                 ORDER BY cc.effective_from DESC NULLS LAST LIMIT 1) AS client_rate,
               COALESCE(e.unbilled, 0) AS unbilled, COALESCE(e.revenue, 0) AS revenue, COALESCE(e.assignment_count, 0) AS assignment_count,
               COALESCE(i.invoiced, 0) AS invoiced, COALESCE(i.outstanding, 0) AS outstanding,
               COALESCE(p.cost, 0) AS cost
          FROM clients c
          LEFT JOIN (SELECT client_id,
                            SUM(total_amount) FILTER (WHERE state = 'UNBILLED' AND on_hold = false) AS unbilled,
                            SUM(taxable_amount) FILTER (WHERE state <> 'CANCELLED') AS revenue,
                            COUNT(*) AS assignment_count
                       FROM billing_entries WHERE is_active = true GROUP BY client_id) e ON e.client_id = c.id
          LEFT JOIN (SELECT client_id,
                            SUM(total) FILTER (WHERE status IN ('ISSUED','PAID')) AS invoiced,
                            SUM(outstanding_amount) FILTER (WHERE status = 'ISSUED') AS outstanding
                       FROM billing_invoices WHERE is_active = true GROUP BY client_id) i ON i.client_id = c.id
          LEFT JOIN (SELECT client_id, SUM(base_amount + travel_amount) AS cost
                       FROM assayer_payables WHERE is_active = true GROUP BY client_id) p ON p.client_id = c.id
         WHERE c.is_active = true AND (e.client_id IS NOT NULL OR i.client_id IS NOT NULL OR p.client_id IS NOT NULL)
         ORDER BY c.name`),
      this.historyRepository.find({ order: { createdAt: 'DESC' }, take: 30 }),
      this.attentionItems(),
    ]);
    const p = payRows[0] ?? {};
    const e = entryRows[0] ?? {};
    const inv = invRows[0] ?? {};
    const ag = ageRows[0] ?? {};
    const cash = cashRows[0] ?? {};
    const revenue = n(e.revenue);
    const cost = n(p.gross_cost);
    return {
      currency: 'INR',
      payouts: {
        due: n(p.due), approved: n(p.approved), paid: n(p.paid), held: n(p.held),
        dueCount: Number(p.due_count ?? 0), approvedCount: Number(p.approved_count ?? 0), heldCount: Number(p.held_count ?? 0),
      },
      receivables: {
        unbilled: n(e.unbilled), invoiced: n(inv.invoiced), collected: n(inv.collected), outstanding: n(inv.outstanding), held: n(e.held),
        aging: { current: n(ag.current), d1_30: n(ag.d1_30), d31_60: n(ag.d31_60), d61_90: n(ag.d61_90), d90_plus: n(ag.d90_plus) },
      },
      margin: { revenue, cost, ...margin(revenue, cost) },
      tax: { gstCollected: n(e.gst), tdsWithheldByClients: n(e.tds_by_clients), tdsWithheldFromAssayers: n(p.tds_from_assayers) },
      cashflow: { in: n(cash.cash_in), out: n(cash.cash_out), net: round2(n(cash.cash_in) - n(cash.cash_out)) },
      attention,
      byClient: clientRows.map((r: any) => ({
        clientId: r.client_id,
        clientName: r.client_name,
        clientRate: r.client_rate != null && Number(r.client_rate) > 0 ? Number(r.client_rate) : null,
        unbilled: n(r.unbilled), invoiced: n(r.invoiced), outstanding: n(r.outstanding),
        revenue: n(r.revenue), cost: n(r.cost), margin: round2(n(r.revenue) - n(r.cost)),
        assignmentCount: Number(r.assignment_count ?? 0),
      })),
      recentActivity: history.map((h) => ({
        id: h.id, action: h.action, entityType: h.entityType, entityId: h.entityId,
        fromState: h.fromState, toState: h.toState, reason: h.reason,
        occurredAt: h.createdAt as unknown as string, userName: h.userName,
      })),
    };
  }

  /**
   * What finance should look at. Each kind is a query over the live rows — there is no
   * "conflict" object to raise, resolve, or forget. Fix the cause and the item disappears.
   */
  private async attentionItems(): Promise<BillingAttentionItem[]> {
    const mgr = this.entryRepository.manager;
    const [unbooked, unsettled, feeChanged, heldPayables, heldLines, overdue] = await Promise.all([
      mgr.query(`
        SELECT a.id, a.assignment_number, c.name AS client_name, s.display_name AS assayer_name,
               (e.id IS NULL) AS no_entry, (p.id IS NULL) AS no_payable,
               CASE WHEN a.agreed_fee > 0 THEN a.agreed_fee WHEN a.proposed_fee > 0 THEN a.proposed_fee ELSE 0 END AS fee
          FROM assignments a
          LEFT JOIN billing_entries e ON e.assignment_id = a.id
          LEFT JOIN assayer_payables p ON p.assignment_id = a.id AND p.expense_id IS NULL
          LEFT JOIN projects pr ON pr.id = a.project_id
          LEFT JOIN clients c ON c.id = pr.client_id
          LEFT JOIN assayers s ON s.id = a.assayer_id
         WHERE a.status = 'COMPLETED' AND a.is_active = true AND (e.id IS NULL OR p.id IS NULL)
         ORDER BY a.completion_date DESC NULLS LAST LIMIT ${ATTENTION_LIMIT}`).catch(() => []),
      mgr.query(`
        SELECT p.id, p.assignment_id, a.assignment_number, s.display_name AS assayer_name, p.total_amount
          FROM assayer_payables p
          JOIN assignments a ON a.id = p.assignment_id
          LEFT JOIN assayers s ON s.id = p.assayer_id
         WHERE p.is_active = true AND p.expense_id IS NULL AND (p.rate_snapshot->>'settled') = 'false'
         ORDER BY p.created_at DESC LIMIT ${ATTENTION_LIMIT}`).catch(() => []),
      mgr.query(`
        SELECT p.id, p.assignment_id, a.assignment_number, s.display_name AS assayer_name,
               (p.rate_snapshot->>'feeAmount')::numeric AS booked_fee,
               CASE WHEN a.agreed_fee > 0 THEN a.agreed_fee WHEN a.proposed_fee > 0 THEN a.proposed_fee ELSE 0 END AS current_fee
          FROM assayer_payables p
          JOIN assignments a ON a.id = p.assignment_id
          LEFT JOIN assayers s ON s.id = p.assayer_id
         WHERE p.is_active = true AND p.expense_id IS NULL
           AND (p.rate_snapshot->>'feeAmount') IS NOT NULL
           AND (p.rate_snapshot->>'feeAmount')::numeric <>
               CASE WHEN a.agreed_fee > 0 THEN a.agreed_fee WHEN a.proposed_fee > 0 THEN a.proposed_fee ELSE 0 END
         ORDER BY p.created_at DESC LIMIT ${ATTENTION_LIMIT}`).catch(() => []),
      mgr.query(`
        SELECT p.id, p.assignment_id, a.assignment_number, s.display_name AS assayer_name, p.total_amount - p.paid_amount AS amount, p.hold_reason
          FROM assayer_payables p
          LEFT JOIN assignments a ON a.id = p.assignment_id
          LEFT JOIN assayers s ON s.id = p.assayer_id
         WHERE p.is_active = true AND p.on_hold = true
         ORDER BY p.updated_at DESC LIMIT ${ATTENTION_LIMIT}`).catch(() => []),
      mgr.query(`
        SELECT e.id, e.assignment_id, a.assignment_number, c.name AS client_name, e.total_amount, e.hold_reason
          FROM billing_entries e
          LEFT JOIN assignments a ON a.id = e.assignment_id
          LEFT JOIN clients c ON c.id = e.client_id
         WHERE e.is_active = true AND e.on_hold = true
         ORDER BY e.updated_at DESC LIMIT ${ATTENTION_LIMIT}`).catch(() => []),
      mgr.query(`
        SELECT i.id, i.invoice_number, c.name AS client_name, i.outstanding_amount, i.due_date,
               (CURRENT_DATE - i.due_date) AS days_overdue
          FROM billing_invoices i
          LEFT JOIN clients c ON c.id = i.client_id
         WHERE i.is_active = true AND i.status = 'ISSUED' AND i.due_date < CURRENT_DATE AND i.outstanding_amount > 0
         ORDER BY i.due_date ASC LIMIT ${ATTENTION_LIMIT}`).catch(() => []),
    ]);
    const items: BillingAttentionItem[] = [];
    for (const r of unbooked) {
      const missing = r.no_entry && r.no_payable ? 'no payout and no client line' : r.no_entry ? 'no client line' : 'no payout';
      items.push({
        kind: 'UNBOOKED', assignmentId: r.id, assignmentNumber: r.assignment_number, clientName: r.client_name, assayerName: r.assayer_name,
        amount: Number(r.fee ?? 0) || null,
        detail: Number(r.fee ?? 0) > 0 ? `Completed but ${missing} — run Reconcile.` : 'Completed with no fee on the assignment — nothing to book.',
      });
    }
    for (const r of unsettled) {
      items.push({
        kind: 'UNSETTLED_FEE', payableId: r.id, assignmentId: r.assignment_id, assignmentNumber: r.assignment_number, assayerName: r.assayer_name,
        amount: Number(r.total_amount), detail: 'Booked from the proposed fee — no fee was ever agreed.',
      });
    }
    for (const r of feeChanged) {
      items.push({
        kind: 'FEE_CHANGED', payableId: r.id, assignmentId: r.assignment_id, assignmentNumber: r.assignment_number, assayerName: r.assayer_name,
        amount: Number(r.current_fee), detail: `Booked at ₹${Number(r.booked_fee)}, the assignment now says ₹${Number(r.current_fee)}.`,
      });
    }
    for (const r of heldPayables) {
      items.push({
        kind: 'HELD', payableId: r.id, assignmentId: r.assignment_id, assignmentNumber: r.assignment_number, assayerName: r.assayer_name,
        amount: Number(r.amount), detail: `Payout on hold: ${r.hold_reason ?? 'no reason given'}`,
      });
    }
    for (const r of heldLines) {
      items.push({
        kind: 'HELD', entryId: r.id, assignmentId: r.assignment_id, assignmentNumber: r.assignment_number, clientName: r.client_name,
        amount: Number(r.total_amount), detail: `Client line on hold: ${r.hold_reason ?? 'no reason given'}`,
      });
    }
    for (const r of overdue) {
      items.push({
        kind: 'OVERDUE_INVOICE', invoiceId: r.id, invoiceNumber: r.invoice_number, clientName: r.client_name,
        amount: Number(r.outstanding_amount), detail: `${Number(r.days_overdue)} day(s) overdue (due ${r.due_date}).`,
      });
    }
    return items;
  }

  // -----------------------------------------------------------------------
  // Labels
  // -----------------------------------------------------------------------

  private async resolveNames(entries: BillingEntryEntity[], payables: AssayerPayableEntity[] = []) {
    const clientIds = [...new Set([...entries.map((e) => e.clientId), ...payables.map((p) => p.clientId)].filter(Boolean))] as string[];
    const projectIds = [...new Set([...entries.map((e) => e.projectId), ...payables.map((p) => p.projectId)].filter(Boolean))] as string[];
    const assignmentIds = [...new Set([...entries.map((e) => e.assignmentId), ...payables.map((p) => p.assignmentId)].filter(Boolean))] as string[];
    const assayerIds = [...new Set([...entries.map((e) => e.assayerId), ...payables.map((p) => p.assayerId)].filter(Boolean))] as string[];
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

  private async attachEntryNames(entries: BillingEntryEntity[]) {
    const names = await this.resolveNames(entries);
    return entries.map((e) => ({
      ...e,
      clientName: names.clients.get(e.clientId) ?? null,
      projectName: e.projectId ? names.projects.get(e.projectId) ?? null : null,
      projectNumber: e.projectId ? names.projectNumbers.get(e.projectId) ?? null : null,
      assignmentNumber: names.assignments.get(e.assignmentId) ?? null,
      branchName: names.branches.get(e.assignmentId) ?? null,
      assayerName: e.assayerId ? names.assayers.get(e.assayerId) ?? null : null,
    }));
  }

  private async attachPayableNames(payables: AssayerPayableEntity[]) {
    const names = await this.resolveNames([], payables);
    return payables.map((p) => ({
      ...p,
      assayerName: names.assayers.get(p.assayerId) ?? null,
      assayerCode: names.assayerCodes.get(p.assayerId) ?? null,
      clientName: p.clientId ? names.clients.get(p.clientId) ?? null : null,
      projectName: p.projectId ? names.projects.get(p.projectId) ?? null : null,
      assignmentNumber: names.assignments.get(p.assignmentId) ?? null,
      branchName: names.branches.get(p.assignmentId) ?? null,
    }));
  }

  // -----------------------------------------------------------------------
  // Primitives
  // -----------------------------------------------------------------------

  /**
   * Run `work` in one database transaction, releasing its domain events only after commit.
   * A name for `uow.run`, kept because the call sites read better as `inTx`.
   */
  private inTx<T>(
    work: (manager: EntityManager, emit: (event: string, payload: Record<string, unknown>) => void) => Promise<T>,
  ): Promise<T> {
    return this.uow.run(work);
  }

  /** Write-lock every line attached to an invoice, in a stable order (deadlock-free with peers). */
  private async lockEntriesByInvoice(manager: EntityManager, invoiceId: string): Promise<BillingEntryEntity[]> {
    return manager
      .createQueryBuilder(BillingEntryEntity, 'e')
      .setLock('pessimistic_write')
      .where('e.invoice_id = :invoiceId', { invoiceId })
      .orderBy('e.id', 'ASC')
      .getMany();
  }

  /**
   * Write-lock one invoice, without its relations. Postgres refuses `FOR UPDATE` on the nullable
   * side of an outer join, so locking and loading are two steps.
   */
  private async lockInvoice(manager: EntityManager, invoiceId: string): Promise<BillingInvoiceEntity> {
    const invoice = await manager.findOne(BillingInvoiceEntity, { where: { id: invoiceId }, lock: { mode: 'pessimistic_write' } });
    if (!invoice) throw new NotFoundException(`Invoice ${invoiceId} not found.`);
    return invoice;
  }

  private async lockPayable(manager: EntityManager, payableId: string): Promise<AssayerPayableEntity> {
    const payable = await manager.findOne(AssayerPayableEntity, { where: { id: payableId }, lock: { mode: 'pessimistic_write' } });
    if (!payable) throw new NotFoundException(`Payable ${payableId} not found.`);
    return payable;
  }

  private seq(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private toISO(d: Date | string): string {
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    return String(d).slice(0, 10);
  }

  private moneyOf(entry: BillingEntryEntity) {
    return {
      baseAmount: Number(entry.baseAmount),
      travelAmount: Number(entry.travelAmount),
      adjustmentAmount: Number(entry.adjustmentAmount),
      taxRate: Number(entry.taxRate),
      taxableAmount: Number(entry.taxableAmount),
      taxAmount: Number(entry.taxAmount),
      tdsRate: Number(entry.tdsRate),
      tdsAmount: Number(entry.tdsAmount),
      totalAmount: Number(entry.totalAmount),
      currency: entry.currency,
    };
  }

  private async clientPaymentTerms(clientId: string, m: EntityManager): Promise<string | null> {
    const rows = await m.query(`SELECT payment_terms FROM client_billing WHERE client_id = $1 AND is_active = true LIMIT 1`, [clientId]).catch(() => []);
    return rows?.[0]?.payment_terms ?? null;
  }

  /** "NET30" → issue date + 30 days; anything else → the issue date. */
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
      const rows = await (manager ?? this.entryRepository.manager).query(`SELECT display_name FROM users WHERE id = $1 LIMIT 1`, [userId]);
      const name = rows?.[0]?.display_name ?? userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  /**
   * Append one immutable row to the money trail, on the caller's transaction so it commits or
   * rolls back with the change it describes.
   */
  private async history(userId: string, h: Partial<BillingHistoryEntity>, manager?: EntityManager): Promise<BillingHistoryEntity> {
    const rec = this.historyRepository.create({
      ...h,
      userName: h.userName ?? (await this.resolveUserName(userId, manager)),
      createdBy: userId,
      updatedBy: userId,
    } as BillingHistoryEntity);
    return manager ? manager.save(rec) : this.historyRepository.save(rec);
  }

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
   * Fire-and-forget a notification whose body needs a branch label. Detached on purpose: neither
   * the label query nor the dispatch may fail a payment that has already committed.
   */
  private notifyWithBranch(assignmentId: string | null | undefined, build: (branchName: string) => EmitOptions): void {
    void this.billingBranchName(assignmentId)
      .then((branchName) => this.notificationDispatch.emitSafe(build(branchName)))
      .catch((err) => this.logger.error(`Billing notification skipped: ${(err as Error).message}`));
  }

  /**
   * Receivables ageing, computed in SQL over sent invoices. Days past due, measured from UTC
   * midnight on the due date; anything not yet due is `current`.
   */
  private static readonly AGEING_SELECT = `
    COALESCE(SUM(outstanding_amount) FILTER (WHERE outstanding_amount > 0 AND (due_date IS NULL OR $OD <= 0)), 0) AS current,
    COALESCE(SUM(outstanding_amount) FILTER (WHERE outstanding_amount > 0 AND due_date IS NOT NULL AND $OD > 0  AND $OD <= 30), 0) AS d1_30,
    COALESCE(SUM(outstanding_amount) FILTER (WHERE outstanding_amount > 0 AND due_date IS NOT NULL AND $OD > 30 AND $OD <= 60), 0) AS d31_60,
    COALESCE(SUM(outstanding_amount) FILTER (WHERE outstanding_amount > 0 AND due_date IS NOT NULL AND $OD > 60 AND $OD <= 90), 0) AS d61_90,
    COALESCE(SUM(outstanding_amount) FILTER (WHERE outstanding_amount > 0 AND due_date IS NOT NULL AND $OD > 90), 0) AS d90_plus
  `.replace(/\$OD/g, `FLOOR(EXTRACT(EPOCH FROM (NOW() - ((due_date::text || ' 00:00:00+00')::timestamptz))) / 86400)`);
}
