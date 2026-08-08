import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Between } from 'typeorm';
import { BillingEntryEntity } from './billing-entry.entity';
import { BillingInvoiceEntity } from './invoice.entity';
import { BillingPaymentEntity } from './payment.entity';
import { AssayerPayableEntity } from './payable.entity';
import { BillingConflictEntity } from './conflict.entity';
import { BillingHistoryEntity } from './history.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectEntity } from '../project/project.entity';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
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

/** Work that is real revenue but has not reached an invoice yet. */
const UNBILLED_STATES: BillingState[] = [
  BillingState.PENDING_BILLING,
  BillingState.READY_FOR_BILLING,
  BillingState.DRAFT,
  BillingState.SUBMITTED,
  BillingState.UNDER_REVIEW,
  BillingState.APPROVED,
];

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
    @InjectRepository(BillingConflictEntity)
    private readonly conflictRepository: Repository<BillingConflictEntity>,
    @InjectRepository(BillingHistoryEntity)
    private readonly historyRepository: Repository<BillingHistoryEntity>,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    private readonly eventPublisher: DomainEventPublisher,
  ) {}

  /** Auto-sync: when an assignment completes, create its billing entry automatically. */
  onModuleInit() {
    this.eventPublisher.subscribe('assignment:status-changed', async (payload: any) => {
      const newState = payload?.newState;
      if (newState !== AssignmentStatus.COMPLETED && newState !== AssignmentStatus.IN_PROGRESS && newState !== AssignmentStatus.CHECKED_IN) {
        return;
      }
      const assignmentId = payload?.assignmentId;
      if (!assignmentId) return;
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
    const taxAmount = round2(taxable * (Number(entry.taxRate) / 100));
    // Reads the dedicated rate column. This previously read `tdsAmount` — a rupee
    // figure — and divided it by 100 as though it were a percentage, which meant
    // TDS evaluated to 0 on every entry that had not already been given a TDS amount.
    const tdsAmount = round2(taxable * (Number(entry.tdsRate ?? 0) / 100));
    entry.taxableAmount = taxable;
    entry.taxAmount = taxAmount;
    entry.tdsAmount = tdsAmount;
    entry.totalAmount = round2(taxable + taxAmount - tdsAmount);
    return entry;
  }

  /**
   * The client's contracted billing terms. `client_billing` has held these all
   * along (payment terms, GSTIN, cycle) but the engine never read it, so every
   * line was taxed at 0% and every invoice due date had to be typed by hand.
   * Falls back to Indian audit-services defaults when a client has no billing
   * record yet rather than failing the sale.
   */
  private async clientTaxRates(clientId: string): Promise<{ gstRate: number; tdsRate: number; paymentTerms: string | null }> {
    const rows = await this.entryRepository.manager.query(
      `SELECT gst_rate, tds_rate, payment_terms FROM client_billing WHERE client_id = $1 AND is_active = true LIMIT 1`,
      [clientId],
    );
    const row = rows?.[0];
    return {
      gstRate: row ? Number(row.gst_rate) : 18,
      tdsRate: row ? Number(row.tds_rate) : 10,
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

  private async resolveUserName(userId: string): Promise<string> {
    if (!userId || userId === 'system') return 'System (automated)';
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;
    try {
      const rows = await this.entryRepository.manager.query(
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

  private async history(
    userId: string,
    h: Partial<BillingHistoryEntity>,
  ): Promise<BillingHistoryEntity> {
    const rec = this.historyRepository.create({
      ...h,
      // The column existed but nothing ever wrote it, so the audit trail could only
      // ever show a raw user id — useless for "who approved this invoice?".
      userName: h.userName ?? (await this.resolveUserName(userId)),
      createdBy: userId,
      updatedBy: userId,
    } as BillingHistoryEntity);
    return this.historyRepository.save(rec);
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

    // Tax treatment falls back to the client's contracted rates when the caller
    // does not state them, so auto-generated lines are taxed the same as manual
    // ones instead of silently going out at 0%.
    const contract = await this.clientTaxRates(dto.clientId);

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
    const saved = await this.entryRepository.save(entry);

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
    });
    await this.publish('billing:entry-created', { entryId: saved.id, level: saved.level, clientId: saved.clientId });

    // Duplicate detection fires at creation (spec §7) — never silently.
    const duplicates = await this.findDuplicates(saved);
    for (const dup of duplicates) {
      await this.raiseDuplicateConflict(saved, dup, userId);
    }

    return saved;
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
  async syncFromAssignments(userId: string): Promise<{
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

    for (const a of assignments) {
      // Backfills the cost leg for work completed before payables were automated,
      // independently of whether the receivable already exists.
      try {
        const payable = await this.syncPayableForAssignment(a.id, userId);
        if (payable.created) payablesCreated += 1;
      } catch (err) {
        errors.push({ assignmentId: a.id, reason: `payable: ${(err as Error).message}` });
      }

      if (existingIds.has(a.id)) { skipped += 1; continue; }
      const clientId = projectClient.get(a.projectId);
      if (!clientId) { errors.push({ assignmentId: a.id, reason: 'no project/client mapping' }); continue; }
      const fee = Number(a.agreedFee ?? 0);
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

    const fee = Number(a.agreedFee ?? 0);
    if (fee <= 0) return { created: false, reason: 'no agreed fee' };

    const entry = await this.createEntryFromAssignment(a, clientId, 'system');
    return { created: true, entryId: entry.id };
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

    const existing = await this.payableRepository.findOne({ where: { assignmentId } });
    if (existing) return { created: false, reason: 'payable already exists', payableId: existing.id };

    // The agreed fee is what the assayer negotiated and accepted for this job.
    const fee = Number(a.agreedFee ?? a.proposedFee ?? 0);
    if (fee <= 0) return { created: false, reason: 'no agreed fee' };

    const clientId = a.projectId
      ? (await this.projectRepository.findOne({ where: { id: a.projectId }, select: ['id', 'clientId'] }))?.clientId
      : undefined;

    // Travel reimbursement comes from the assayer's active commercial profile, and
    // the whole rate card is snapshotted so a later rate change never silently
    // restates a historical payable.
    const profile = await this.payableRepository.manager.query(
      `SELECT base_fee, travel_reimbursement, daily_rate, currency
         FROM assayer_commercial_profiles
        WHERE assayer_id = $1 AND is_active = true
          AND (effective_end_date IS NULL OR effective_end_date >= NOW())
        ORDER BY effective_start_date DESC LIMIT 1`,
      [a.assayerId],
    );
    const rateCard = profile?.[0] ?? null;
    const travel = rateCard ? Number(rateCard.travel_reimbursement ?? 0) : 0;

    const payable = await this.createPayable({
      assayerId: a.assayerId,
      clientId: clientId ?? undefined,
      projectId: a.projectId ?? undefined,
      assignmentId: a.id,
      baseAmount: fee,
      travelAmount: travel,
      // Assayers are professional-service vendors: TDS is withheld from what we pay
      // them, and no GST is added on our side unless they are registered.
      taxRate: 0,
      tdsRate: 10,
      // The snapshot must justify the amount actually booked. The payable is booked at the
      // assignment's agreed fee, so `baseFee` here is that fee — not the assayer's standard
      // profile rate, which was recorded before and disagreed with every payable (base_amount
      // 2000 against a snapshot claiming 3406). The standard profile rate is kept alongside as
      // context, clearly labelled, so "why did we pay this?" resolves to the agreed fee and the
      // profile it was compared against, both immutable on the payable.
      rateSnapshot: {
        source: 'assignment.agreedFee',
        baseFee: fee,
        travelReimbursement: travel,
        agreedFee: fee,
        proposedFee: a.proposedFee != null ? Number(a.proposedFee) : null,
        profileStandardBaseFee: rateCard ? Number(rateCard.base_fee) : null,
        profileDailyRate: rateCard ? Number(rateCard.daily_rate) : null,
        capturedAt: new Date().toISOString(),
      },
      remarks: `Auto-generated on completion of ${a.assignmentNumber}.`,
    }, userId);

    return { created: true, payableId: payable.id };
  }

  private async createEntryFromAssignment(a: AssignmentEntity, clientId: string, userId: string): Promise<BillingEntryEntity> {
    const assayerFee = Number(a.agreedFee ?? 0);
    // What the CLIENT is billed comes from the client's own contracted rate card, not from
    // what the assayer was paid. Billing the client the assayer's fee made revenue equal cost
    // on every audit — margin was structurally zero. The spread between this rate and the
    // assayer's fee is the margin the business earns.
    //
    // Falls back to the assayer fee only when the client has set no rate, so an unconfigured
    // client keeps the old pass-through behaviour rather than being billed a platform default
    // that might sit below cost. The Client Billing Settings page is where this rate is set.
    const clientBase = await this.clientContractedBaseFor(clientId);
    const fee = clientBase ?? assayerFee;
    // Travel paid to the assayer is recovered from the client when their contract
    // says it is rechargeable. Without this the assayer's travel was a pure cost
    // absorbed on every job — the reason completed audits showed a negative margin
    // exactly equal to the travel reimbursement.
    const travel = await this.rechargeableTravelFor(a, clientId);
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

    // Mirrors what the assayer is actually reimbursed, so the recharge and the
    // cost cannot drift apart.
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

  async transitionEntry(entryId: string, targetState: BillingState, userId: string, reason?: string): Promise<BillingEntryEntity> {
    const entry = await this.entryRepository.findOne({ where: { id: entryId } });
    if (!entry) throw new NotFoundException(`Billing entry ${entryId} not found.`);

    if (entry.state === targetState) throw new ConflictException(`Entry is already ${targetState}.`);

    // An unresolved blocking conflict freezes the entries it names (spec §8).
    // This used to count every open blocking conflict in the system regardless of
    // which entries it referenced, so a single disputed line halted billing for
    // every client in the database. Only conflicts naming *this* entry may stop it.
    if (![BillingState.ON_HOLD, BillingState.DISPUTED].includes(targetState)) {
      const blocking = await this.conflictRepository
        .createQueryBuilder('c')
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

    const saved = await this.entryRepository.save(entry);
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
    });
    await this.publish('billing:entry-state-changed', { entryId: saved.id, fromState, toState: targetState });
    return saved;
  }

  /**
   * Move a batch of billing entries to a target state as one operation. Each row
   * runs through the normal transition rules (conflict freeze, valid transition)
   * and is history-logged individually. Per-row errors are isolated so one bad
   * entry never aborts the rest; rows already in the target state are skipped.
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
      const entry = await this.entryRepository.findOne({ where: { id: entryId } });
      if (!entry) {
        failed.push({ id: entryId, reason: `Billing entry ${entryId} not found.` });
        continue;
      }
      if (entry.state === targetState) {
        skipped.push({ id: entryId, current: entry.state, reason: `Already ${targetState}` });
        continue;
      }
      try {
        const from = entry.state;
        await this.transitionEntry(entryId, targetState, userId, reason);
        succeeded.push({ id: entryId, from, to: targetState });
      } catch (e) {
        failed.push({ id: entryId, reason: (e as Error).message });
      }
    }

    return { succeeded, skipped, failed };
  }

  async adjustEntry(entryId: string, delta: number, reason: string, userId: string): Promise<BillingEntryEntity> {
    const entry = await this.entryRepository.findOne({ where: { id: entryId } });
    if (!entry) throw new NotFoundException(`Billing entry ${entryId} not found.`);

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
    const saved = await this.entryRepository.save(entry);

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
    });
    await this.publish('billing:entry-adjusted', { entryId: saved.id, delta, totalAmount: Number(saved.totalAmount) });
    return saved;
  }

  async findEntries(filters: {
    clientId?: string;
    projectId?: string;
    assignmentId?: string;
    assayerId?: string;
    level?: BillingLevel;
    state?: BillingState;
  } = {}): Promise<BillingEntryEntity[]> {
    const where: Record<string, unknown> = {};
    if (filters.clientId) where.clientId = filters.clientId;
    if (filters.projectId) where.projectId = filters.projectId;
    if (filters.assignmentId) where.assignmentId = filters.assignmentId;
    if (filters.assayerId) where.assayerId = filters.assayerId;
    if (filters.level) where.level = filters.level;
    if (filters.state) where.state = filters.state;
    return this.entryRepository.find({ where, order: { createdAt: 'DESC' } });
  }

  /**
   * Entries with their client/project/assignment/assayer labels attached. The raw
   * rows only carry foreign keys, so the entries table could not show which client
   * or project a line belonged to — the first thing anyone needs to know about a
   * billing line.
   */
  async findEntriesEnriched(filters: Parameters<BillingEngineService['findEntries']>[0] = {}) {
    const entries = await this.findEntries(filters);
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
    const payables = await this.findPayables(filters);
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
  private async findDuplicates(entry: BillingEntryEntity): Promise<BillingEntryEntity[]> {
    const q = this.entryRepository
      .createQueryBuilder('e')
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

  private async raiseDuplicateConflict(entry: BillingEntryEntity, duplicateOf: BillingEntryEntity, userId: string): Promise<void> {
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
    const saved = await this.conflictRepository.save(conflict);
    await this.history(userId, {
      clientId: entry.clientId,
      projectId: entry.projectId,
      assignmentId: entry.assignmentId,
      entityType: BillingEntityType.CONFLICT,
      entityId: saved.id,
      action: 'DUPLICATE_FLAGGED',
      newValue: { entryIds: [entry.id, duplicateOf.id] },
      reason: conflict.description,
    });
    await this.publish('billing:duplicate-detected', { conflictId: saved.id, entryIds: conflict.entryIds });
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
    const saved = await this.conflictRepository.save(conflict);
    await this.history(userId, {
      entityType: BillingEntityType.CONFLICT,
      entityId: saved.id,
      action: 'CONFLICT_RAISED',
      toState: BillingConflictStatus.OPEN,
      newValue: { entryIds: dto.entryIds, severity: dto.severity },
      reason: dto.description,
    });
    return saved;
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
    const conflict = await this.conflictRepository.findOne({ where: { id: conflictId } });
    if (!conflict) throw new NotFoundException(`Conflict ${conflictId} not found.`);

    const fromStatus = conflict.status;
    conflict.status = dto.status;
    conflict.resolutionAction = dto.action as any;
    conflict.resolutionNote = dto.note;
    conflict.resolvedById = userId;
    conflict.resolvedAt = new Date();
    conflict.updatedBy = userId;
    const saved = await this.conflictRepository.save(conflict);

    await this.history(userId, {
      entityType: BillingEntityType.CONFLICT,
      entityId: saved.id,
      action: 'CONFLICT_RESOLVED',
      fromState: fromStatus,
      toState: saved.status,
      newValue: { action: dto.action },
      reason: dto.note,
    });
    await this.publish('billing:conflict-resolved', { conflictId: saved.id, status: saved.status });
    return saved;
  }

  async findConflicts(status?: BillingConflictStatus): Promise<any[]> {
    const conflicts = await this.conflictRepository.find({
      where: status ? { status } : {},
      order: { createdAt: 'DESC' },
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

    return conflicts.map((c) => ({
      ...c,
      createdByName: c.createdById ? userNameById.get(c.createdById) ?? null : null,
      resolvedByName: c.resolvedById ? userNameById.get(c.resolvedById) ?? null : null,
    }));
  }

  // -----------------------------------------------------------------------
  // Split / Merge (spec §9)
  // -----------------------------------------------------------------------

  async splitEntry(entryId: string, dto: SplitEntryDto, userId: string): Promise<BillingEntryEntity[]> {
    const entry = await this.getEntry(entryId);
    if (entry.parentEntryId) throw new BadRequestException('Cannot split an entry that is itself a split/merge child.');
    if (!dto.amounts?.length || dto.amounts.some((a) => a <= 0)) {
      throw new BadRequestException('Split requires a non-empty list of positive amounts.');
    }
    const total = round2(dto.amounts.reduce((a, b) => a + b, 0));
    if (Math.abs(total - entry.totalAmount) > 0.01) {
      throw new BadRequestException(`Split amounts (${total}) must sum to the entry total (${entry.totalAmount}).`);
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
      const saved = await this.entryRepository.save(child);
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
      });
    }

    // Preserve traceability on the parent: it is superseded by its children.
    entry.state = BillingState.ADJUSTED;
    entry.updatedBy = userId;
    await this.entryRepository.save(entry);

    return savedChildren;
  }

  async mergeEntries(entryIds: string[], userId: string, note?: string): Promise<BillingEntryEntity> {
    if (!entryIds?.length || entryIds.length < 2) {
      throw new BadRequestException('Merge requires at least two entries.');
    }
    const entries = await this.entryRepository.find({ where: { id: In(entryIds) } });
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

    const first = entries[0];
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
    const saved = await this.entryRepository.save(merged);

    // Source entries become children of the merge (traceable, not separately billable).
    for (const e of entries) {
      // Captured before mutating: this was read after the assignment below, so every
      // merge logged "ADJUSTED → ADJUSTED" and the real prior state was lost.
      const fromState = e.state;
      e.parentEntryId = saved.id;
      e.state = BillingState.ADJUSTED;
      e.updatedBy = userId;
      await this.entryRepository.save(e);
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
      });
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
    });
    return saved;
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
    const entries = await this.entryRepository.find({ where: { id: In(dto.entryIds) } });
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
    const subtotal = round2(entries.reduce((a, e) => a + Number(e.taxableAmount ?? e.baseAmount), 0));
    const tax = round2(entries.reduce((a, e) => a + Number(e.taxAmount), 0));
    const tds = round2(entries.reduce((a, e) => a + Number(e.tdsAmount), 0));
    const discount = round2(entries.reduce((a, e) => a + Number(e.discountAmount), 0));
    const total = round2(entries.reduce((a, e) => a + Number(e.totalAmount), 0));

    const contract = await this.clientTaxRates(dto.clientId);
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
    const saved = await this.invoiceRepository.save(invoice);

    for (const e of entries) {
      e.invoiceId = saved.id;
      e.state = BillingState.INVOICED;
      e.billedAmount = Number(e.totalAmount);
      e.outstandingAmount = Number(e.totalAmount);
      e.updatedBy = userId;
      await this.entryRepository.save(e);
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
      });
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
    });
    await this.publish('billing:invoice-created', { invoiceId: saved.id, clientId: saved.clientId });
    return saved;
  }

  async transitionInvoice(invoiceId: string, target: InvoiceStatus, userId: string, reason?: string): Promise<BillingInvoiceEntity> {
    const invoice = await this.invoiceRepository.findOne({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundException(`Invoice ${invoiceId} not found.`);
    if (invoice.status === target) throw new ConflictException(`Invoice is already ${target}.`);
    if (!isValidTransition(INVOICE_TRANSITIONS, invoice.status, target)) {
      throw new BadRequestException(`Cannot transition invoice from ${invoice.status} to ${target}.`);
    }
    const fromState = invoice.status;
    invoice.status = target;
    if (target === InvoiceStatus.ISSUED && !invoice.issueDate) invoice.issueDate = new Date().toISOString().slice(0, 10);
    invoice.updatedBy = userId;
    const saved = await this.invoiceRepository.save(invoice);
    await this.history(userId, {
      clientId: saved.clientId,
      projectId: saved.projectId,
      entityType: BillingEntityType.INVOICE,
      entityId: saved.id,
      action: 'INVOICE_STATUS_CHANGED',
      fromState,
      toState: target,
      reason: reason ?? null,
    });
    await this.publish('billing:invoice-status-changed', { invoiceId: saved.id, fromState, toState: target });
    return saved;
  }

  async findInvoices(filters: { clientId?: string; projectId?: string; status?: InvoiceStatus } = {}): Promise<BillingInvoiceEntity[]> {
    const where: Record<string, unknown> = {};
    if (filters.clientId) where.clientId = filters.clientId;
    if (filters.projectId) where.projectId = filters.projectId;
    if (filters.status) where.status = filters.status;
    return this.invoiceRepository.find({ where, relations: ['entries'], order: { createdAt: 'DESC' } });
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

  async recordPayment(dto: {
    invoiceId: string;
    paymentReference: string;
    method: PaymentMethod;
    amount: number;
    receivedDate?: string;
    allocatedToEntryIds?: string[];
    notes?: string;
  }, userId: string): Promise<BillingPaymentEntity> {
    const invoice = await this.getInvoice(dto.invoiceId);
    if (dto.amount <= 0) throw new BadRequestException('Payment amount must be positive.');
    const remaining = round2(Number(invoice.outstandingAmount) - dto.amount);
    if (remaining < -0.01) {
      throw new BadRequestException(`Payment exceeds outstanding (${invoice.outstandingAmount}).`);
    }

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
    const saved = await this.paymentRepository.save(payment);

    // Update invoice money and status.
    invoice.paidAmount = round2(Number(invoice.paidAmount) + dto.amount);
    invoice.outstandingAmount = round2(Number(invoice.outstandingAmount) - dto.amount);
    if (Math.abs(invoice.outstandingAmount) < 0.01) invoice.outstandingAmount = 0;
    invoice.status = invoice.outstandingAmount <= 0 ? InvoiceStatus.PAID : InvoiceStatus.PARTIALLY_PAID;
    invoice.updatedBy = userId;
    await this.invoiceRepository.save(invoice);

    // Reflect payment across the invoice's entries (pro-rata unless allocated).
    const entries = invoice.entries || [];
    if (entries.length) {
      const totalOutstanding = entries.reduce((a, e) => a + Number(e.outstandingAmount), 0) || 1;
      for (const e of entries) {
        const share = dto.allocatedToEntryIds?.includes(e.id)
          ? (dto.amount / (dto.allocatedToEntryIds.length || 1))
          : round2(Number(e.outstandingAmount) * (dto.amount / totalOutstanding));
        const applied = Math.min(share, Number(e.outstandingAmount));
        e.paidAmount = round2(Number(e.paidAmount) + applied);
        e.outstandingAmount = round2(Number(e.outstandingAmount) - applied);
        if (e.outstandingAmount < 0.01) e.outstandingAmount = 0;
        e.paymentState = e.outstandingAmount <= 0 ? PaymentState.PAID : PaymentState.PARTIALLY_PAID;
        e.updatedBy = userId;
        await this.entryRepository.save(e);
      }
    }

    await this.history(userId, {
      clientId: invoice.clientId,
      projectId: invoice.projectId,
      entityType: BillingEntityType.PAYMENT,
      entityId: saved.id,
      action: 'PAYMENT_RECEIVED',
      fromState: invoice.status === InvoiceStatus.PAID ? 'PARTIALLY_PAID' : 'ISSUED',
      toState: invoice.status,
      newValue: { amount: dto.amount, paymentReference: dto.paymentReference, invoiceId: invoice.id },
      reason: dto.notes ?? null,
    });
    await this.publish('billing:payment-received', { paymentId: saved.id, invoiceId: invoice.id, amount: dto.amount });
    return saved;
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
    const gross = round2(fee + travel);
    const tax = round2(gross * (Number(dto.taxRate || 0) / 100));
    const tds = round2(gross * (Number(dto.tdsRate || 0) / 100));
    const total = round2(gross + tax - tds);

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
    const saved = await this.payableRepository.save(payable);
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
    });
    return saved;
  }

  async transitionPayable(payableId: string, target: AssayerPayableStatus, userId: string, reason?: string): Promise<AssayerPayableEntity> {
    const payable = await this.payableRepository.findOne({ where: { id: payableId } });
    if (!payable) throw new NotFoundException(`Payable ${payableId} not found.`);
    if (payable.status === target) throw new ConflictException(`Payable is already ${target}.`);
    if (!isValidTransition(PAYABLE_TRANSITIONS, payable.status, target)) {
      throw new BadRequestException(`Cannot transition payable from ${payable.status} to ${target}.`);
    }
    const fromState = payable.status;
    payable.status = target;
    if (target === AssayerPayableStatus.APPROVED) { payable.approvedAt = new Date(); payable.approvedBy = userId; }
    if (target === AssayerPayableStatus.PAID) { payable.paidAt = new Date(); payable.paidBy = userId; payable.paidAmount = payable.totalAmount; }
    payable.updatedBy = userId;
    const saved = await this.payableRepository.save(payable);
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
    });
    await this.publish('billing:payable-status-changed', { payableId: saved.id, fromState, toState: target });
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
    const payable = await this.payableRepository.findOne({ where: { id: dto.payableId } });
    if (!payable) throw new NotFoundException(`Payable ${dto.payableId} not found.`);

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
    if (amount - outstanding > 0.01) {
      throw new BadRequestException(`Disbursement ₹${amount} exceeds the ₹${outstanding} still owed on this payable.`);
    }

    payable.paidAmount = round2(Number(payable.paidAmount) + amount);
    const fullyPaid = Number(payable.totalAmount) - payable.paidAmount <= 0.01;
    if (fullyPaid) {
      payable.status = AssayerPayableStatus.PAID;
      payable.paidAt = new Date();
      payable.paidBy = userId;
    }
    payable.updatedBy = userId;
    await this.payableRepository.save(payable);

    // Balance still owed to this assayer across all their payables, after this
    // payment — the running statement the old ledger tried to maintain, now
    // derived from real obligations instead of a free-floating counter.
    const balance = await this.assayerOutstanding(payable.assayerId);

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
    const saved = await this.paymentRepository.save(payment);

    await this.history(userId, {
      clientId: payable.clientId,
      projectId: payable.projectId,
      assignmentId: payable.assignmentId,
      assayerId: payable.assayerId,
      entityType: BillingEntityType.PAYMENT,
      entityId: saved.id,
      action: 'DISBURSEMENT_PAID',
      fromState: AssayerPayableStatus.APPROVED,
      toState: payable.status,
      newValue: { amount, paymentReference: dto.paymentReference, payableId: payable.id, balanceAfter: balance },
      reason: dto.notes ?? null,
    });
    await this.publish('billing:disbursement-paid', {
      paymentId: saved.id, payableId: payable.id, assayerId: payable.assayerId, amount,
    });
    return saved;
  }

  /** Total still owed to an assayer across every payable not yet fully paid. */
  private async assayerOutstanding(assayerId: string): Promise<number> {
    const rows = await this.payableRepository.manager.query(
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
    const where: Record<string, unknown> = {};
    if (filters.clientId) where.clientId = filters.clientId;
    if (filters.projectId) where.projectId = filters.projectId;
    if (filters.assignmentId) where.assignmentId = filters.assignmentId;
    if (filters.assayerId) where.assayerId = filters.assayerId;
    if (filters.entityType) where.entityType = filters.entityType;
    return this.historyRepository.find({ where, order: { createdAt: 'DESC' }, take: 200 });
  }

  // -----------------------------------------------------------------------
  // Dashboard & reports (spec §11)
  // -----------------------------------------------------------------------

  async dashboard(clientId?: string): Promise<any> {
    const [entries, invoices, payables, conflicts, history] = await Promise.all([
      clientId ? this.findEntries({ clientId }) : this.entryRepository.find({ where: { isActive: true } }),
      clientId ? this.findInvoices({ clientId }) : this.invoiceRepository.find({ where: { isActive: true } }),
      this.payableRepository.find({ where: clientId ? { clientId } : { isActive: true } }),
      this.conflictRepository.find({ where: { status: BillingConflictStatus.OPEN } }),
      this.historyRepository.find({ where: clientId ? { clientId } : {}, order: { createdAt: 'DESC' }, take: 50 }),
    ]);

    const sum = <T, K extends keyof T>(arr: T[], k: K) =>
      round2(arr.reduce((a, item) => a + Number((item as any)[k] ?? 0), 0));

    const billed = sum(entries, 'billedAmount');
    const paid = sum(entries, 'paidAmount');
    const outstanding = sum(entries, 'outstandingAmount');
    const pending = sum(
      entries.filter((e) => [BillingState.PENDING_BILLING, BillingState.READY_FOR_BILLING, BillingState.DRAFT, BillingState.SUBMITTED, BillingState.UNDER_REVIEW].includes(e.state)),
      'totalAmount',
    );
    const disputed = sum(entries.filter((e) => e.state === BillingState.DISPUTED), 'disputedAmount');
    const cancelledAdjusted = sum(
      entries.filter((e) => e.state === BillingState.CANCELLED || e.state === BillingState.ADJUSTED),
      'totalAmount',
    );

    const byLevel: Record<string, { billed: number; paid: number; outstanding: number }> = {};
    for (const lvl of Object.values(BillingLevel)) {
      const levelEntries = entries.filter((e) => e.level === lvl);
      byLevel[lvl] = {
        billed: sum(levelEntries, 'billedAmount'),
        paid: sum(levelEntries, 'paidAmount'),
        outstanding: sum(levelEntries, 'outstandingAmount'),
      };
    }

    const payableTotals = {
      pending: sum(payables.filter((p) => p.status === AssayerPayableStatus.PENDING), 'totalAmount'),
      approved: sum(payables.filter((p) => p.status === AssayerPayableStatus.APPROVED), 'totalAmount'),
      paid: sum(payables.filter((p) => p.status === AssayerPayableStatus.PAID), 'totalAmount'),
      disputed: sum(payables.filter((p) => p.status === AssayerPayableStatus.DISPUTED), 'totalAmount'),
      onHold: sum(payables.filter((p) => p.status === AssayerPayableStatus.ON_HOLD), 'totalAmount'),
    };

    const invoiceTotals = {
      total: invoices.length,
      issued: invoices.filter((i) => i.status === InvoiceStatus.ISSUED || i.status === InvoiceStatus.PARTIALLY_PAID).length,
      paid: invoices.filter((i) => i.status === InvoiceStatus.PAID).length,
      outstanding: round2(invoices.reduce((a, i) => a + Number(i.outstandingAmount ?? 0), 0)),
    };

    // Net revenue (taxable value, ex-GST) against gross assayer cost (fee + travel).
    // GST is a pass-through and TDS a withheld tax credit, so neither side is netted.
    const assayerCost = round2(payables.reduce((a, p) => a + Number(p.baseAmount) + Number(p.travelAmount), 0));
    const revenue = round2(entries.reduce((a, e) => a + Number(e.taxableAmount ?? e.baseAmount), 0));

    return {
      currency: 'INR',
      totals: {
        billed, paid, outstanding, pending, disputed, cancelledAdjusted,
        // Revenue earned in the field but not yet on an invoice — the number that
        // shows how much cash is stuck in the billing pipeline.
        unbilledRevenue: pending,
        revenue,
        assayerCost,
        margin: round2(revenue - assayerCost),
        marginPct: revenue > 0 ? round2(((revenue - assayerCost) / revenue) * 100) : null,
      },
      aging: this.ageInvoices(invoices),
      byLevel,
      payable: payableTotals,
      invoices: invoiceTotals,
      openConflicts: conflicts.length,
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
        cur.revenue = round2(cur.revenue + Number(e.taxableAmount ?? e.baseAmount));
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
          asn.cost = round2(asn.cost + Number(py.baseAmount) + Number(py.travelAmount));
          asn.payableStatus = py.status;
        }
      }
    }

    const projects = Array.from(byProject.values()).map((p) => {
      const assignments = Array.from(p.assignments.values()).map((a: any) => ({
        ...a,
        margin: round2(a.revenue - a.cost),
        marginPct: a.revenue > 0 ? round2(((a.revenue - a.cost) / a.revenue) * 100) : null,
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
    const totalRevenue = round2(entries.reduce((a, e) => a + Number(e.taxableAmount ?? e.baseAmount), 0));
    const totalCost = round2(payables.reduce((a, p) => a + Number(p.baseAmount) + Number(p.travelAmount), 0));

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
        margin: round2(totalRevenue - totalCost),
        marginPct: totalRevenue > 0 ? round2(((totalRevenue - totalCost) / totalRevenue) * 100) : null,
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
    const cost = round2(payables.reduce((a: number, p: any) => a + n(p.base_amount) + n(p.travel_amount), 0));
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
    const [entries, invoices, payables, payments, conflicts] = await Promise.all([
      this.entryRepository.find({ where: { isActive: true } }),
      this.invoiceRepository.find({ where: { isActive: true } }),
      this.payableRepository.find({ where: { isActive: true } }),
      this.paymentRepository.find({ where: { isActive: true }, order: { createdAt: 'DESC' } }),
      this.conflictRepository.find({ where: { status: BillingConflictStatus.OPEN } }),
    ]);

    const sum = (arr: any[], k: string) => round2(arr.reduce((a, x) => a + Number(x[k] ?? 0), 0));
    const inbound = payments.filter((p) => p.direction === PaymentDirection.INBOUND);
    const outbound = payments.filter((p) => p.direction === PaymentDirection.OUTBOUND);

    // Accounts receivable — money clients owe us.
    const receivable = {
      unbilled: sum(entries.filter((e) => UNBILLED_STATES.includes(e.state)), 'totalAmount'),
      invoiced: sum(invoices, 'total'),
      collected: sum(invoices, 'paidAmount'),
      outstanding: sum(invoices, 'outstandingAmount'),
      disputed: sum(entries.filter((e) => e.state === BillingState.DISPUTED), 'totalAmount'),
      aging: this.ageInvoices(invoices),
    };

    // Accounts payable — money we owe assayers for completed work.
    const byStatus = (s: AssayerPayableStatus) => payables.filter((p) => p.status === s);
    const payable = {
      awaitingApproval: sum(byStatus(AssayerPayableStatus.PENDING), 'totalAmount'),
      approvedUnpaid: round2(
        byStatus(AssayerPayableStatus.APPROVED).reduce((a, p) => a + (Number(p.totalAmount) - Number(p.paidAmount)), 0),
      ),
      paid: sum(payables, 'paidAmount'),
      onHold: sum(byStatus(AssayerPayableStatus.ON_HOLD), 'totalAmount'),
      disputed: sum(byStatus(AssayerPayableStatus.DISPUTED), 'totalAmount'),
      total: sum(payables, 'totalAmount'),
    };

    const netRevenue = sum(entries, 'taxableAmount');
    const grossCost = round2(payables.reduce((a, p) => a + Number(p.baseAmount) + Number(p.travelAmount), 0));

    // Statutory positions finance has to file: GST collected on sales, TDS
    // withheld by clients from us, and TDS we withheld from assayers.
    const taxPosition = {
      gstCollected: sum(entries, 'taxAmount'),
      tdsWithheldByClients: sum(entries, 'tdsAmount'),
      tdsWithheldFromAssayers: sum(payables, 'tdsAmount'),
    };

    return {
      currency: 'INR',
      receivable,
      payable,
      cashflow: {
        // Real movements, not accruals — what actually hit the bank.
        in: sum(inbound, 'amount'),
        out: sum(outbound, 'amount'),
        net: round2(sum(inbound, 'amount') - sum(outbound, 'amount')),
        inboundCount: inbound.length,
        outboundCount: outbound.length,
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
      openConflicts: conflicts.length,
      recentPayments: payments.slice(0, 15).map((p) => ({
        id: p.id,
        direction: p.direction,
        reference: p.paymentReference,
        method: p.method,
        amount: Number(p.amount),
        date: p.receivedDate,
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
