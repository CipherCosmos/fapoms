import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull, Not, EntityManager } from 'typeorm';
import { BillingJobsService } from './billing-jobs.service';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { isUniqueViolation } from '../../infrastructure/database/unique-violation';
import { BillingEntryEntity } from './billing-entry.entity';
import { BillingInvoiceEntity } from './invoice.entity';
import { BillingPaymentEntity } from './payment.entity';
import { AssayerPayableEntity } from './payable.entity';
import { AssayerInvoiceEntity } from './assayer-invoice.entity';
import { ASSAYER_INVOICE_ELIGIBLE_SQL } from './assayer-invoice-eligibility';
import {
  BillingRegionFilters,
  billingRegionFilters,
  BILLING_OUT_OF_SCOPE_COUNTS_SQL,
} from './billing-region-scope';
import { resolvePayoutDestination } from './payout-destination';
import { BillingHistoryEntity } from './history.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { COMMITTED_ASSIGNMENT_STATUSES, sqlStatusList } from '../assignment/assignment-workload';
import {
  HELD_RECEIVABLE_SQL,
  REVENUE_TAXABLE_SQL,
  UNBILLED_RECEIVABLE_SQL,
  revenueTaxableSql,
  unbilledReceivableSql,
} from './billing-metrics';
import { ProjectEntity } from '../project/project.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssayerDocumentEntity } from '../assayer/assayer-document.entity';
import { AuditService } from '../../core/audit/audit.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { PROFILE_IN_FORCE_SQL, PROFILE_IN_FORCE_ORDER } from '../pricing/profile-in-force';
import { CacheService } from '../../infrastructure/cache/cache.service';
import {
  NotificationDispatchService,
  EmitOptions,
} from '../notifications/notification-dispatch.service';
import {
  BillingState,
  DEAD_BILLING_STATES,
  DEAD_PAYABLE_STATUSES,
  isLiveBillingEntry,
  isLivePayable,
  liveBillingEntrySql,
  livePayableSql,
  andLivePayableSql,
  InvoiceStatus,
  PaymentMethod,
  PaymentDirection,
  AssayerPayableStatus,
  AssayerInvoiceStatus,
  BillingEntityType,
  AssignmentStatus,
  BillingAttentionItem,
  BillingOverview,
  AssignmentMoneyLine,
  EventCategory,
  businessTodayDateKey,
  BUSINESS_TODAY_SQL,
  gstinStateCode,
  gstStateCodeToName,
  resolveGstStateCode,
  numberToIndianWords,
  OnboardingDocument,
  maskTail,
  SystemRole,
} from '@fapoms/shared';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { SETTING_BY_KEY, SEGREGATION_OF_DUTIES_SETTING_KEY } from '../../infrastructure/settings/settings.registry';
import { NOT_A_RECORD_ENTITY_ID } from '../../core/audit/audit-event';
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
/** See the comment on `findInvoices` — a backstop for its one unpaginated caller, not a page size. */
const FINDINVOICES_HARD_CAP = 5000;

/** Exported for the sibling `AssayerInvoiceService` — one clamp for every billing list. */
export function billingPageWindow(page?: number | string, limit?: number | string) {
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
    // Read-only. Loaded through the repository (not raw SQL) so the encrypted PAN and bank
    // account number are decrypted by the column transformer for the bank file and TDS report.
    @InjectRepository(AssayerEntity)
    private readonly assayerRepository: Repository<AssayerEntity>,
    private readonly auditService: AuditService,
    private readonly regionGuard: RegionGuardService,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly cache: CacheService,
    private readonly uow: UnitOfWork,
    private readonly notificationDispatch: NotificationDispatchService,
    private readonly settings: PlatformSettingsService,
    @Optional() private readonly billingJobs?: BillingJobsService,
  ) {}

  // -----------------------------------------------------------------------
  // The automatic path: completion books; a fee edit re-prices
  // -----------------------------------------------------------------------

  onModuleInit() {
    this.eventPublisher.subscribe('assignment:status-changed', async (payload: any) => {
      if (payload?.newState !== AssignmentStatus.COMPLETED) return;
      const assignmentId = payload?.assignmentId;
      if (!assignmentId) return;

      // Authoritative durable path: enqueue to Bull queue so billing processing is asynchronous,
      // retried with exponential backoff on transient failures, visible in DLQ, and
      // completely decouples assignment completion from transient billing failures.
      if (!this.billingJobs) {
        const msg = `BillingJobsService not available to enqueue billing job for assignment ${assignmentId}`;
        this.logger.error(msg);
        throw new Error(msg);
      }

      try {
        await this.billingJobs.enqueueBookAssignment(assignmentId, payload?.userId, payload?.outboxEventId);
      } catch (err) {
        this.logger.error(
          `Failed to enqueue billing job for assignment ${assignmentId}: ${(err as Error).message}`,
        );
        throw err;
      }
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

        /**
         * LIVE rows only — a voided payable and a cancelled line are history, not a booking.
         *
         * This read used to ask whether a row existed at all, which is true forever once an
         * assignment has ever been billed. So a reopened audit, redone and completed again,
         * found its own voided payable here, concluded "already booked", and wrote nothing: the
         * assayer was never paid for the work they redid and the client was never billed for it,
         * while the money view beside this reported `booked: true`. See `billing-liveness.ts`.
         */
        const [liveEntry, livePayable] = await Promise.all([
          m.findOne(BillingEntryEntity, { where: { assignmentId, state: Not(In(DEAD_BILLING_STATES)) } }),
          m.findOne(AssayerPayableEntity, {
            where: { assignmentId, expenseId: IsNull(), status: Not(In(DEAD_PAYABLE_STATUSES)) },
          }),
        ]);
        if (liveEntry && livePayable) {
          return { booked: false, reason: 'already booked', entryId: liveEntry.id, payableId: livePayable.id };
        }

        const ctx = await this.moneyContextFor(clientId, a.assayerId, a.quotedTravelFee, m);
        const money = assignmentMoney(a, ctx);
        if (money.fee.source === 'NONE') return { booked: false, reason: 'NO_FEE' };

        // Reuse only a LIVE leg. Where the only row is voided or cancelled, this inserts a new
        // one alongside it — which the partial unique indexes permit precisely because they
        // exclude the dead states. The history stays; the new completion gets its own effect.
        const payable = livePayable ?? await this.insertFeePayable(m, a, clientId, money, ctx, userId);
        const entry = liveEntry ?? await this.insertClientLine(m, a, clientId, money, ctx, userId);

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
        // The same liveness rule as the read above. Since the indexes became partial, a unique
        // violation can only mean a LIVE row got there first, so that is what to look for —
        // finding a voided one here and reporting "already booked" would recreate the defect
        // inside the race handler.
        const [entry, payable] = await Promise.all([
          this.entryRepository.findOne({ where: { assignmentId, state: Not(In(DEAD_BILLING_STATES)) } }),
          this.payableRepository.findOne({
            where: { assignmentId, expenseId: IsNull(), status: Not(In(DEAD_PAYABLE_STATUSES)) },
          }),
        ]);
        // CRITICAL INVARIANT: Only treat as 'already booked' if BOTH legs exist in the database.
        // If one leg is missing, this is an inconsistent partial state that MUST NOT be acknowledged
        // cleanly — re-throw so the job/reconcile retries and finishes repairing the missing leg.
        if (entry && payable) {
          return { booked: false, reason: 'already booked (concurrent)', entryId: entry.id, payableId: payable.id };
        }
        this.logger.warn(
          `Unique violation on ${assignmentId} caught during booking, but database is in partial state (entry=${Boolean(entry)}, payable=${Boolean(payable)}). Re-throwing for repair.`,
        );
        throw err;
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
      /**
       * The LIVE legs. A fee correction applies to the money that is owed now, never to the
       * money a reopen already withdrew.
       *
       * Without the status filter this picked whichever row Postgres reached first — heap order,
       * so in practice the older one, which after a redo is the voided one. The guard further
       * down (`status !== PAID && paidAmount === 0`) admits a VOIDED row happily, so the new
       * price and a fresh rate snapshot would be written onto the dead payable, a
       * `PAYABLE_REPRICED` history row would record that the correction was applied, and the
       * live payable would keep the old price. The assayer would be paid the uncorrected fee
       * while the trail said otherwise.
       */
      const [entry, payable] = await Promise.all([
        m.findOne(BillingEntryEntity, {
          where: { assignmentId, state: Not(In(DEAD_BILLING_STATES)) },
          lock: { mode: 'pessimistic_write' },
        }),
        m.findOne(AssayerPayableEntity, {
          where: { assignmentId, expenseId: IsNull(), status: Not(In(DEAD_PAYABLE_STATUSES)) },
          lock: { mode: 'pessimistic_write' },
        }),
      ]);
      if (!entry && !payable) return { repriced: false, reason: 'not booked' };

      const clientId = entry?.clientId ?? payable?.clientId ?? null;
      if (!clientId || !a.assayerId) return { repriced: false, reason: 'no client/assayer' };
      const ctx = await this.moneyContextFor(clientId, a.assayerId, a.quotedTravelFee, m, Number(entry?.adjustmentAmount ?? 0));
      const money = assignmentMoney(a, ctx);
      if (money.fee.source === 'NONE') return { repriced: false, reason: 'NO_FEE' };

      let touched = false;
      let payableFrozenReason: string | null = null;
      /**
       * A payable on an assayer invoice is not freely re-priceable any more:
       *
       *  - SUBMITTED — the assayer consented to the on-screen figures. Changing a line under a
       *    submission would make their confirmation cover numbers they never saw; the invoice
       *    must be cancelled (releasing the lines) before the fee edit can land.
       *  - APPROVED — a record of what was accepted for payment, same reasoning as a paid row.
       *  - INVITED — nobody has seen anything yet, so the reprice proceeds and the invoice's
       *    stored SUMs are recomputed on the SAME transaction below, keeping the totals nothing
       *    but a sum of their lines.
       *
       * A frozen payable is left untouched and noted (result reason + warn log) — the attention
       * list's FEE_CHANGED item already surfaces booked-vs-current drift to finance.
       */
      let payableInvitedInvoice: AssayerInvoiceEntity | null = null;
      if (payable?.assayerInvoiceId) {
        const inv = await m.findOne(AssayerInvoiceEntity, {
          where: { id: payable.assayerInvoiceId },
          lock: { mode: 'pessimistic_write' },
        });
        if (inv && (inv.status === AssayerInvoiceStatus.SUBMITTED || inv.status === AssayerInvoiceStatus.APPROVED)) {
          payableFrozenReason = `payout on ${inv.status.toLowerCase()} assayer invoice ${inv.invoiceNumber} — left untouched`;
          this.logger.warn(
            `Re-price of assignment ${assignmentId}: ${payableFrozenReason} (cancel the invoice first if the fee edit must reach it).`,
          );
        } else if (inv && inv.status === AssayerInvoiceStatus.INVITED) {
          payableInvitedInvoice = inv;
        }
      }
      if (payable && !payableFrozenReason && payable.status !== AssayerPayableStatus.PAID && Number(payable.paidAmount) === 0) {
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
        // The invoice's totals are SUMs of its lines and one line just moved.
        if (payableInvitedInvoice) {
          await this.recomputeAssayerInvoiceInTx(m, emit, payableInvitedInvoice, userId, `Line ${payable.payableNumber} re-priced`);
        }
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
      // The frozen-line note rides the reason either way, so a caller (or a log reader) can see
      // that PART of the money did not move even when the client line did.
      return { repriced: touched, reason: payableFrozenReason ?? (touched ? undefined : 'nothing re-priceable') };
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
    // No `a.is_active = true` filter: an assayer's delete cascade deactivates their assignments,
    // and a COMPLETED audit that happened does not stop having happened because the assayer who
    // did it was later removed. Filtering on is_active hid exactly the work most likely to still
    // need billing — a deleted assayer's outstanding payable is not deleted with them.
    /**
     * The joins match LIVE rows only, so a completion whose money was voided and never re-booked
     * is visible here. They previously matched any row, which made this blind to exactly the
     * damage it exists to repair: a reopened-and-redone assignment kept its cancelled line and
     * voided payable, the LEFT JOINs found them, and `count` came back 0 while the assayer went
     * unpaid. Detection and repair share this query, so a blind detector is also a blind repair.
     */
    const rows: Array<{ id: string }> = await this.assignmentRepository.manager.query(
      `SELECT a.id
         FROM assignments a
         LEFT JOIN billing_entries e ON e.assignment_id = a.id AND ${liveBillingEntrySql('e')}
         LEFT JOIN assayer_payables p ON p.assignment_id = a.id AND p.expense_id IS NULL AND ${livePayableSql('p')}
        WHERE a.status = 'COMPLETED'
          AND (e.id IS NULL OR p.id IS NULL)
          AND ($1::date IS NULL OR a.completion_date >= $1::date)
        ORDER BY a.completion_date ASC NULLS LAST, a.created_at ASC`,
      [since],
    );
    return rows.map((r) => r.id);
  }

  /**
   * Find completed assignments that are in an inconsistent PARTIAL financial state:
   * exactly one LIVE leg exists (entry without payable, or payable without entry).
   *
   * Used by operations and monitoring to pinpoint data inconsistencies caused by
   * historical bugs, partial migrations, or legacy records.
   *
   * Liveness matters here for the same reason it does in `unbookedAssignmentIds`: a voided
   * payable beside a live client line is a half-booked assignment, and counting the voided row
   * as a leg would report it as healthy.
   */
  async partialFinancialStates(since: string | null = null): Promise<Array<{
    assignmentId: string;
    hasEntry: boolean;
    hasPayable: boolean;
  }>> {
    const rows: Array<{ id: string; has_entry: boolean; has_payable: boolean }> =
      await this.assignmentRepository.manager.query(
        `SELECT a.id,
                (e.id IS NOT NULL) AS has_entry,
                (p.id IS NOT NULL) AS has_payable
           FROM assignments a
           LEFT JOIN billing_entries e ON e.assignment_id = a.id AND ${liveBillingEntrySql('e')}
           LEFT JOIN assayer_payables p ON p.assignment_id = a.id AND p.expense_id IS NULL AND ${livePayableSql('p')}
          WHERE a.status = 'COMPLETED'
            AND (
              (e.id IS NULL AND p.id IS NOT NULL)
              OR
              (e.id IS NOT NULL AND p.id IS NULL)
            )
            AND ($1::date IS NULL OR a.completion_date >= $1::date)
          ORDER BY a.completion_date ASC NULLS LAST, a.created_at ASC`,
        [since],
      );
    return rows.map((r) => ({
      assignmentId: r.id,
      hasEntry: r.has_entry,
      hasPayable: r.has_payable,
    }));
  }

  /**
   * Payouts that have been sitting unapproved, and the work that never reached a payout at all.
   *
   * Both exist because the chain from "audit done" to "assayer paid" is one automatic hop
   * (completion books the payable) followed by several manual ones, and nothing anywhere noticed
   * when a manual hop simply did not happen. A payable could rest in PENDING for weeks with the
   * assayer's own screen calling it owed; an attended audit nobody closed produced no payable at
   * all. Neither state raised anything — they were visible only as figures on a finance page
   * somebody had to open, which is not a control.
   *
   * Read-only and cheap: two indexed aggregates, run from the SLA scanner.
   */
  async payoutsAwaitingApproval(minDays: number): Promise<{
    count: number; totalAmount: number; oldestDays: number;
  }> {
    const rows: Array<{ count: string; total: string; oldest_days: string }> =
      await this.assignmentRepository.manager.query(
        `SELECT COUNT(*)::text AS count,
                COALESCE(SUM(total_amount), 0)::text AS total,
                COALESCE(MAX(EXTRACT(DAY FROM (now() - created_at))), 0)::text AS oldest_days
           FROM assayer_payables
          WHERE status = 'PENDING' AND is_active = true AND on_hold = false
            AND created_at < now() - ($1 || ' days')::interval`,
        [String(minDays)],
      );
    const r = rows?.[0];
    return {
      count: Number(r?.count ?? 0),
      totalAmount: Number(r?.total ?? 0),
      oldestDays: Math.floor(Number(r?.oldest_days ?? 0)),
    };
  }

  /**
   * Audits somebody actually attended that were never completed, so nothing was ever booked.
   *
   * Keyed on check-IN rather than check-out: a visit with no departure recorded is exactly as
   * unclosed as one with it, and waiting for a check-out that the assayer may never tap would
   * hide the worst cases. Cancelled and rejected work is excluded — those were closed, deliberately.
   */
  async attendedButNotClosed(minDays: number): Promise<{
    count: number; oldestDate: string | null;
  }> {
    const rows: Array<{ count: string; oldest: string | null }> =
      await this.assignmentRepository.manager.query(
        `SELECT COUNT(*)::text AS count,
                MIN(checked_in_at)::date::text AS oldest
           FROM assignments
          WHERE is_active = true
            AND checked_in_at IS NOT NULL
            AND status IN (${sqlStatusList(COMMITTED_ASSIGNMENT_STATUSES)})
            AND checked_in_at < now() - ($1 || ' days')::interval`,
        [String(minDays)],
      );
    const r = rows?.[0];
    return { count: Number(r?.count ?? 0), oldestDate: r?.oldest ?? null };
  }

  // -----------------------------------------------------------------------
  // Pricing context and the two inserts
  // -----------------------------------------------------------------------

  /**
   * Everything `assignmentMoney` needs that is not on the assignment: the client's rate card and
   * travel policy, both sides' tax rates, and the legacy reimbursement for pre-quote offers.
   *
   * The four PRICING reads below deliberately carry no `.catch`. They used to fall back to `[]`,
   * which is indistinguishable from "this client has no rate card": a transient database error
   * therefore booked the audit at the PLATFORM DEFAULT fee, with default GST and TDS, and said
   * nothing — a wrong invoice with no trace of why. A failed read must fail the booking, which
   * the billing engine already survives (its idempotent guards let the retry re-enter cleanly).
   *
   * The reads that DO keep a fallback are the ones whose fallback is a documented default
   * rather than a guess: the platform settings (the registry owns those defaults) and the
   * PAN-presence probe (see s.206AA below — a read error must not spike someone's withholding).
   */
  private async moneyContextFor(
    clientId: string,
    assayerId: string,
    quotedTravelFee: unknown,
    m: EntityManager,
    adjustmentAmount = 0,
  ): Promise<MoneyContext & { paymentTerms: string | null }> {
    const needsLegacyTravel = quotedTravelFee === null || quotedTravelFee === undefined;
    const [cfgRows, clientRows, billingRows, assayerTds, gstDefault, tdsDefault, profileRows, panRows, tdsNoPan] = await Promise.all([
      m.query(
        `SELECT default_base_fee FROM client_configurations
          WHERE client_id = $1 AND is_active = true
            -- only a rate in force now may price the booking; an expired or future-dated
            -- contract row must not (see FeePolicyService.ratesFor for the same rule)
            AND (effective_from IS NULL OR effective_from <= NOW())
            AND (effective_to IS NULL OR effective_to >= NOW())
          ORDER BY effective_from DESC NULLS LAST LIMIT 1`,
        [clientId],
      ),
      m.query(`SELECT planning_preferences FROM clients WHERE id = $1 LIMIT 1`, [clientId]),
      m.query(`SELECT gst_rate, tds_rate, payment_terms FROM client_billing WHERE client_id = $1 AND is_active = true LIMIT 1`, [clientId]),
      this.settings.getNumber('billing.tdsRate', 10).catch(() => 10),
      this.settings.getNumber('billing.defaultClientGstRate', 18).catch(() => 18),
      this.settings.getNumber('billing.defaultClientTdsRate', 10).catch(() => 10),
      needsLegacyTravel
        ? m.query(
            // In force NOW — both bounds. This once checked only the end date, so a rate card
            // dated for next quarter already governed today's travel reimbursement. The predicate
            // is imported rather than written here: a copy that merely *matches* the shared rule
            // is one edit away from disagreeing with it again, which is how the four readers
            // drifted apart the first time.
            `SELECT travel_reimbursement FROM assayer_commercial_profiles
              WHERE ${PROFILE_IN_FORCE_SQL('$1', 'NOW()')}
              ORDER BY ${PROFILE_IN_FORCE_ORDER} LIMIT 1`,
            [assayerId],
          )
        : Promise.resolve([]),
      // Only presence is read, never the value — the column is encrypted at rest and a
      // ciphertext is as non-null as a PAN.
      m.query(
        `SELECT (pan_number IS NOT NULL AND pan_number <> '') AS has_pan FROM assayers WHERE id = $1 LIMIT 1`,
        [assayerId],
      ).catch(() => []),
      this.settings.getNumber('billing.tdsRateNoPan', 20).catch(() => 20),
    ]);
    const rate = cfgRows?.[0]?.default_base_fee;
    const prefs = clientRows?.[0]?.planning_preferences ?? {};
    const billing = billingRows?.[0];
    /**
     * s.206AA: a deductee who has not furnished a PAN is withheld at the higher rate (20%), not
     * the normal professional-fee rate. Booked-rate discipline is unchanged — existing payables
     * keep whatever they were booked at; this decides new bookings only. `has_pan` defaulting to
     * true on a query failure is deliberate: a transient read error must not spike someone's
     * withholding.
     */
    const hasPan = panRows?.length ? panRows[0].has_pan === true : true;
    const effectiveAssayerTds = hasPan ? assayerTds : Math.max(Number(assayerTds) || 0, Number(tdsNoPan) || 20);
    return {
      clientRate: rate != null && Number(rate) > 0 ? Number(rate) : null,
      rechargeTravel: prefs?.rechargeTravel !== false,
      gstRate: billing ? Number(billing.gst_rate) : gstDefault,
      clientTdsRate: billing ? Number(billing.tds_rate) : tdsDefault,
      assayerTdsRate: effectiveAssayerTds,
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
      /**
       * The LIVE line. A cancelled one from an earlier completion is history and must not stand
       * in for the current one: finding it here answers every adjustment and every hold with
       * "This line is cancelled — cancel the invoice first", on an assignment that has no invoice
       * to cancel and a perfectly good live line sitting beside it. There is no way through that
       * from the interface, so a credit the client was promised could never be applied.
       */
      const entry = await m.findOne(BillingEntryEntity, {
        where: { assignmentId, state: Not(In(DEAD_BILLING_STATES)) },
        lock: { mode: 'pessimistic_write' },
      });
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
        // A credit may zero the line, never push it below zero: a negative taxable amount stores
        // negative GST and TDS and corrupts the payment allocator's proportional split. A larger
        // credit than the line belongs on the next invoice as its own line, not as a negative one.
        const adjustmentFloor = -round2(Number(entry.baseAmount) + Number(entry.travelAmount));
        if (amount < adjustmentFloor) {
          throw new BadRequestException(
            `This credit exceeds the line. The most this line can be reduced by is ₹${Math.abs(adjustmentFloor).toFixed(2)} (to zero).`,
          );
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
   * Approve ONE payable on the caller's transaction — the extracted body of `approvePayouts`,
   * shared with `AssayerInvoiceService.approve` so invoice approval and per-payable approval
   * are the SAME act (segregation-of-duties assert, history row, audit row, payout-changed
   * event) rather than two implementations that drift.
   *
   * Returns the saved payable, or `null` when it was already APPROVED (a no-op, not an error).
   *
   * `opts.suppressNotification` names the notification contract at the call site — this method
   * itself NEVER dispatches the push, because a push must not fire for a transaction that may
   * still roll back. `false` (approvePayouts) means the caller sends the per-payable
   * `PAYABLE_APPROVED` push after ITS transaction commits; `true` (the invoice path) means one
   * `ASSAYER_INVOICE_APPROVED` notification replaces the N per-payable pushes.
   *
   * `opts.bypassInvoiceGuard` is for the invoice-approval path only: ITS invoice is the active
   * one these lines ride, so refusing "awaiting assayer invoice" there would deadlock the
   * feature against itself. Every other caller keeps the guard.
   */
  async approvePayableInTx(
    m: EntityManager,
    emit: (event: string, payload: Record<string, unknown>) => void,
    payableId: string,
    userId: string,
    opts: { suppressNotification: boolean; bypassInvoiceGuard?: boolean },
  ): Promise<AssayerPayableEntity | null> {
    const p = await this.lockPayable(m, payableId);
    if (p.status === AssayerPayableStatus.APPROVED) return null;
    if (p.status === AssayerPayableStatus.PAID) throw new ConflictException(`${p.payableNumber} is already paid.`);
    if (p.status === AssayerPayableStatus.VOIDED) throw new ConflictException(`${p.payableNumber} is voided.`);
    if (p.onHold) throw new ConflictException(`${p.payableNumber} is on hold: ${p.holdReason ?? 'no reason given'}.`);
    /**
     * A payable riding an active (INVITED/SUBMITTED) assayer invoice is approved by approving
     * THE INVOICE — one gesture for the whole consented set, never a side-door per line. An
     * APPROVED invoice's lines are already APPROVED payables (the no-op branch above), so only
     * the two active states refuse here.
     */
    if (!opts.bypassInvoiceGuard && p.assayerInvoiceId) {
      const inv = await m.findOne(AssayerInvoiceEntity, { where: { id: p.assayerInvoiceId } });
      if (inv && (inv.status === AssayerInvoiceStatus.INVITED || inv.status === AssayerInvoiceStatus.SUBMITTED)) {
        throw new ConflictException(
          `${p.payableNumber} is awaiting assayer invoice ${inv.invoiceNumber} — approve the invoice instead.`,
        );
      }
    }
    // Expense-driven payables have no "booking" actor to compare against — only an
    // assignment-completion payable does. Check the mode before the lookup, not inside
    // assertSegregationOfDuties, so a deployment that has deliberately turned the control Off
    // never pays for an extra query on every single approval. Off is no longer the shipped
    // default — see security.segregationOfDuties.mode — so this branch is now the common path.
    if (p.assignmentId && !p.expenseId && (await this.sodMode()) !== 'off') {
      const assignment = await m.findOne(AssignmentEntity, { where: { id: p.assignmentId } });
      await this.assertSegregationOfDuties(
        userId,
        assignment?.createdBy,
        `book assignment ${p.assignmentId} and also approve its payout`,
        { entityType: 'PAYABLE', entityId: p.id, payableNumber: p.payableNumber },
      );
    }

    // Freeze immutable payout banking destination snapshot BEFORE approval commits
    if (p.assayerId) {
      const assayer = await m.findOne(AssayerEntity, {
        where: { id: p.assayerId },
        lock: { mode: 'pessimistic_read' },
      });

      if (!assayer || !assayer.bankAccountNumber?.trim() || !assayer.ifscCode?.trim()) {
        throw new BadRequestException(
          `Cannot approve payout ${p.payableNumber}: Assayer ${assayer?.assayerCode || p.assayerId} is missing bank account or IFSC details. Banking destination is mandatory for payout approval.`,
        );
      }
      if (!assayer.panNumber?.trim()) {
        throw new BadRequestException(
          `Cannot approve payout ${p.payableNumber}: Assayer ${assayer?.assayerCode || p.assayerId} is missing PAN. Statutory compliance requires PAN before payout approval.`,
        );
      }

      // Check for verified bank passbook document version
      const bankDoc = await m.findOne(AssayerDocumentEntity, {
        where: {
          assayerId: p.assayerId,
          requirement: OnboardingDocument.BANK_PASSBOOK,
          isActive: true,
        },
      });

      // ONE definition of what may be claimed here — see payout-destination.ts. This used to end
      // `?? new Date()` on both branches, so an assayer with no passbook and no established
      // identity was stamped "verified, just now" at the moment of approval.
      const snapshot = resolvePayoutDestination(assayer, bankDoc);
      p.destinationBankAccountNumber = snapshot.destinationBankAccountNumber;
      p.destinationIfsc = snapshot.destinationIfsc;
      p.destinationBankName = snapshot.destinationBankName;
      p.destinationAccountHolderName = snapshot.destinationAccountHolderName;
      p.payoutEvidenceVersionId = snapshot.payoutEvidenceVersionId;
      p.destinationVerifiedAt = snapshot.destinationVerifiedAt;
      p.destinationVerifiedSource = snapshot.destinationVerifiedSource;
    }

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
    // Compliance trail, alongside — not instead of — the reconciliation history row above.
    // On the same manager so the audit event commits or rolls back with the approval itself.
    const manager = m;
    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: 'PAYABLE_APPROVED',
      entityType: 'PAYABLE',
      entityId: saved.id,
      previousState: AssayerPayableStatus.PENDING,
      newState: AssayerPayableStatus.APPROVED,
      userId,
      remarks: `Approved payout ${saved.payableNumber} (₹${Number(saved.totalAmount)}) for assayer ${saved.assayerId}`,
      metadata: {
        payableId: saved.id,
        payableNumber: saved.payableNumber,
        assayerId: saved.assayerId,
        clientId: saved.clientId,
        projectId: saved.projectId,
        assignmentId: saved.assignmentId,
        amount: Number(saved.totalAmount),
      },
    }, { manager });
    emit('billing:payout-changed', { payableId: saved.id, assayerId: saved.assayerId, status: saved.status, onHold: saved.onHold });
    return saved;
  }

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
        const approved = await this.inTx((m, emit) =>
          this.approvePayableInTx(m, emit, id, userId, { suppressNotification: false }),
        );
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
      // A held line must not ride an invoice: invoice approval refuses held lines, so leaving it
      // attached would jam the whole invoice on a problem ops already knows about. Placing the
      // hold DETACHES the line from a merely-INVITED invoice (recomputing its totals) and
      // REFUSES on a SUBMITTED one — the assayer consented to that exact set. Releasing a hold
      // changes nothing invoice-wise; the payable is simply eligible again.
      if (onHold) await this.releaseFromAssayerInvoice(m, emit, p, userId, 'held');
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
   * The owner decision: a payable that should never be paid, voided with a reason and an audit
   * trail — never deleted, because a deleted row cannot explain to a later reviewer why money
   * that looked owed never went out.
   *
   * Refuses a payable already PAID: that money already left, and the ledger must keep saying so.
   * Voids the matching client line in the same transaction if it has not been invoiced yet —
   * invoicing already froze it onto a document a client has seen, and unwinding that is a credit
   * note, not a void.
   *
   * Takes an optional external `ctx` (manager + emit) so a caller already inside its own
   * transaction (the assignment `reopen` path) can run this on that same connection/transaction
   * instead of opening a second, independent one — two transactions each taking `FOR UPDATE` on
   * rows the other touches would deadlock, and even without that, voiding money and reopening
   * the assignment must commit or roll back as one unit, not two. The event is staged through
   * the caller's own `emit` in that case, so it still only reaches subscribers after the
   * caller's transaction (not this method's, since there isn't one) actually commits.
   */
  async voidPayable(
    payableId: string,
    reason: string,
    userId: string,
    ctx?: { manager: EntityManager; emit: (event: string, payload: Record<string, unknown>) => void },
  ): Promise<AssayerPayableEntity> {
    if (!reason?.trim()) throw new BadRequestException('Say why this payout is being voided.');
    const work = async (m: EntityManager, emit: (event: string, payload: Record<string, unknown>) => void) => {
      const p = await this.lockPayable(m, payableId);
      if (p.status === AssayerPayableStatus.PAID) {
        throw new ConflictException(`${p.payableNumber} is already paid — it cannot be voided, only reversed by finance.`);
      }
      if (p.status === AssayerPayableStatus.VOIDED) return p;

      // Same rule as the hold above: detach from an INVITED invoice (recompute; auto-cancel if
      // this was its last line), refuse on a SUBMITTED one, leave an APPROVED invoice's history
      // alone. Runs before the status flip so a refusal leaves the payable exactly as it was.
      await this.releaseFromAssayerInvoice(m, emit, p, userId, 'voided');

      const fromStatus = p.status;
      p.status = AssayerPayableStatus.VOIDED;
      p.onHold = false;
      p.holdReason = null;
      p.updatedBy = userId;
      const saved = await m.save(p);

      await this.history(userId, {
        clientId: p.clientId, projectId: p.projectId, assignmentId: p.assignmentId, assayerId: p.assayerId,
        entityType: BillingEntityType.PAYABLE, entityId: saved.id, action: 'PAYABLE_STATUS_CHANGED',
        fromState: fromStatus, toState: AssayerPayableStatus.VOIDED, reason: reason.trim(),
      }, m);
      await this.auditService.recordEvent({
        category: EventCategory.WORKFLOW,
        eventType: 'PAYABLE_VOIDED',
        entityType: 'PAYABLE',
        entityId: saved.id,
        previousState: fromStatus,
        newState: AssayerPayableStatus.VOIDED,
        userId,
        remarks: reason.trim(),
        metadata: { payableId: saved.id, payableNumber: saved.payableNumber, assayerId: saved.assayerId, assignmentId: saved.assignmentId },
      }, { manager: m });

      // Same transaction, same reason: the client line this payable was booked alongside must
      // not stand alone as the only surviving half of a job that has been un-billed on the
      // assayer side.
      if (saved.assignmentId && !saved.expenseId) {
        /**
         * The LIVE line, or this does nothing at all.
         *
         * Looking one up by assignment alone could return the cancelled line from an earlier
         * completion, and the `!== CANCELLED` guard below would then short-circuit — leaving the
         * *current* client line UNBILLED while the assayer's payout for the same work was voided.
         * The client is then invoiced for work the business has decided it will not pay for,
         * which is exactly what the comment above this block forbids. Reopen cancels the live
         * line itself, but `voidPayable` is also reachable straight from finance, where nothing
         * else does.
         */
        const entry = await m.findOne(BillingEntryEntity, {
          where: { assignmentId: saved.assignmentId, state: Not(In(DEAD_BILLING_STATES)) },
        });
        if (entry && entry.state !== BillingState.INVOICED && entry.state !== BillingState.PAID && entry.state !== BillingState.CANCELLED) {
          const entryFromState = entry.state;
          entry.state = BillingState.CANCELLED;
          entry.onHold = false;
          entry.holdReason = null;
          entry.updatedBy = userId;
          const savedEntry = await m.save(entry);
          await this.history(userId, {
            clientId: savedEntry.clientId, projectId: savedEntry.projectId, assignmentId: savedEntry.assignmentId,
            entityType: BillingEntityType.ENTRY, entityId: savedEntry.id, action: 'ENTRY_STATUS_CHANGED',
            fromState: entryFromState, toState: BillingState.CANCELLED, reason: `Voided with payable ${saved.payableNumber}: ${reason.trim()}`,
          }, m);
        }
      }

      emit('billing:payout-changed', { payableId: saved.id, assayerId: saved.assayerId, status: saved.status, onHold: saved.onHold });
      return saved;
    };

    if (ctx) return work(ctx.manager, ctx.emit);
    return this.inTx(work);
  }

  // -----------------------------------------------------------------------
  // Assayer-invoice interactions (see assayer-invoice.service.ts for the lifecycle itself).
  // These two live HERE, not on AssayerInvoiceService, because they are called from inside
  // this service's own transactions (void / hold / re-price) — and injecting the invoice
  // service back into this one would close a dependency cycle for ten lines of SQL.
  // -----------------------------------------------------------------------

  /**
   * Detach a payable from the assayer invoice it rides, or refuse the caller's action.
   *
   *  - No invoice → nothing to do.
   *  - INVITED    → detach (null the fk, recompute the invoice's SUMs on the same transaction;
   *                 the last line leaving auto-cancels the invoice, reason "all lines removed").
   *                 Nobody has consented to anything yet, so the set may still shrink.
   *  - SUBMITTED  → refuse. The assayer confirmed exactly this set of lines; changing it under
   *                 their submission would falsify the consent. Cancel the invoice first.
   *  - APPROVED   → leave everything alone (the caller's own rules already govern approved
   *                 rows) — an approved invoice is a record, not a working set.
   *
   * Mutates `p.assayerInvoiceId` in memory AND writes it through `m.update` immediately, so the
   * recompute's SUM (which runs before the caller's own `m.save(p)`) already excludes the line.
   */
  private async releaseFromAssayerInvoice(
    m: EntityManager,
    emit: (event: string, payload: Record<string, unknown>) => void,
    p: AssayerPayableEntity,
    userId: string,
    verb: 'voided' | 'held',
  ): Promise<void> {
    if (!p.assayerInvoiceId) return;
    const inv = await m.findOne(AssayerInvoiceEntity, {
      where: { id: p.assayerInvoiceId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!inv) {
      // A dangling fk (the invoice row vanished) must not make the payable un-voidable forever.
      p.assayerInvoiceId = null;
      await m.update(AssayerPayableEntity, p.id, { assayerInvoiceId: null, updatedBy: userId });
      return;
    }
    if (inv.status === AssayerInvoiceStatus.SUBMITTED) {
      throw new ConflictException(
        `${p.payableNumber} is on submitted assayer invoice ${inv.invoiceNumber} — cancel invoice ${inv.invoiceNumber} first.`,
      );
    }
    if (inv.status !== AssayerInvoiceStatus.INVITED) return; // APPROVED / CANCELLED: unchanged behaviour
    p.assayerInvoiceId = null;
    await m.update(AssayerPayableEntity, p.id, { assayerInvoiceId: null, updatedBy: userId });
    await this.recomputeAssayerInvoiceInTx(m, emit, inv, userId, `Line ${p.payableNumber} ${verb} and detached`);
  }

  /**
   * Re-derive an INVITED invoice's stored figures from its lines, on the caller's transaction.
   *
   * The invoice's amounts are nothing but SUMs of stored line amounts — so whenever a line
   * moves (re-priced) or leaves (void/hold detach), the header is recomputed from the rows
   * rather than patched incrementally, and can therefore never drift from its lines. An
   * invoice left with NO lines is auto-cancelled: an invitation to bill nothing is noise, and
   * cancelling it re-opens the one-active-invoice slot so the next invite round works.
   */
  private async recomputeAssayerInvoiceInTx(
    m: EntityManager,
    emit: (event: string, payload: Record<string, unknown>) => void,
    inv: AssayerInvoiceEntity,
    userId: string,
    reason: string,
  ): Promise<void> {
    const rows = await m.query(
      `SELECT COUNT(*)::int                        AS n,
              COALESCE(SUM(base_amount), 0)        AS base,
              COALESCE(SUM(travel_amount), 0)      AS travel,
              COALESCE(SUM(tds_amount), 0)         AS tds,
              COALESCE(SUM(total_amount), 0)       AS total
         FROM assayer_payables
        WHERE assayer_invoice_id = $1 AND is_active = true`,
      [inv.id],
    );
    const r = rows?.[0] ?? {};
    const before = {
      lineCount: Number(inv.lineCount), subtotalBase: Number(inv.subtotalBase), subtotalTravel: Number(inv.subtotalTravel),
      tdsAmount: Number(inv.tdsAmount), totalAmount: Number(inv.totalAmount),
    };
    inv.lineCount = Number(r.n ?? 0);
    inv.subtotalBase = round2(Number(r.base ?? 0));
    inv.subtotalTravel = round2(Number(r.travel ?? 0));
    inv.tdsAmount = round2(Number(r.tds ?? 0));
    inv.totalAmount = round2(Number(r.total ?? 0));
    inv.updatedBy = userId;

    if (inv.lineCount === 0) {
      const fromStatus = inv.status;
      inv.status = AssayerInvoiceStatus.CANCELLED;
      inv.cancelledAt = new Date();
      inv.cancelledBy = userId;
      inv.cancelReason = 'all lines removed';
      const saved = await m.save(inv);
      await this.history(userId, {
        assayerId: saved.assayerId,
        entityType: BillingEntityType.ASSAYER_INVOICE, entityId: saved.id, action: 'ASSAYER_INVOICE_CANCELLED',
        fromState: fromStatus, toState: AssayerInvoiceStatus.CANCELLED,
        previousValue: before, newValue: { lineCount: 0 }, reason: 'all lines removed',
      }, m);
      await this.auditService.recordEvent({
        category: EventCategory.WORKFLOW,
        eventType: 'ASSAYER_INVOICE_CANCELLED',
        entityType: 'ASSAYER_INVOICE',
        entityId: saved.id,
        previousState: fromStatus,
        newState: AssayerInvoiceStatus.CANCELLED,
        userId,
        remarks: `Auto-cancelled ${saved.invoiceNumber}: all lines removed (${reason})`,
        metadata: { invoiceId: saved.id, invoiceNumber: saved.invoiceNumber, assayerId: saved.assayerId },
      }, { manager: m });
      emit('billing:assayer-invoice-changed', { invoiceId: saved.id, assayerId: saved.assayerId, status: saved.status });
      return;
    }

    const saved = await m.save(inv);
    await this.history(userId, {
      assayerId: saved.assayerId,
      entityType: BillingEntityType.ASSAYER_INVOICE, entityId: saved.id, action: 'ASSAYER_INVOICE_RECOMPUTED',
      previousValue: before,
      newValue: {
        lineCount: saved.lineCount, subtotalBase: Number(saved.subtotalBase), subtotalTravel: Number(saved.subtotalTravel),
        tdsAmount: Number(saved.tdsAmount), totalAmount: Number(saved.totalAmount),
      },
      reason,
    }, m);
    emit('billing:assayer-invoice-changed', { invoiceId: saved.id, assayerId: saved.assayerId, status: saved.status });
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

      // Operational KYC boundary & Destination Snapshot:
      // Payout disbursement strictly consumes the frozen destination snapshot from the payable.
      let destinationSnapshot = {
        destinationBankAccountNumber: payable.destinationBankAccountNumber ?? null,
        destinationIfsc: payable.destinationIfsc ?? null,
        destinationBankName: payable.destinationBankName ?? null,
        destinationAccountHolderName: payable.destinationAccountHolderName ?? null,
        payoutEvidenceVersionId: payable.payoutEvidenceVersionId ?? null,
        destinationVerifiedAt: payable.destinationVerifiedAt ?? null,
        destinationVerifiedSource: payable.destinationVerifiedSource ?? null,
      };

      // If payable was approved prior to frozen schema, freeze snapshot under lock now
      if (!destinationSnapshot.destinationBankAccountNumber || !destinationSnapshot.destinationIfsc) {
        if (payable.assayerId) {
          const assayer = await m.findOne(AssayerEntity, {
            where: { id: payable.assayerId },
            lock: { mode: 'pessimistic_read' },
          });

          if (assayer) {
            if (!assayer.bankAccountNumber?.trim() || !assayer.ifscCode?.trim()) {
              throw new BadRequestException(
                `Cannot disburse payout ${payable.payableNumber}: Assayer ${assayer.assayerCode || payable.assayerId} is missing bank account or IFSC details. Operational payout safety boundary blocked disbursement.`,
              );
            }
            if (!assayer.panNumber?.trim()) {
              throw new BadRequestException(
                `Cannot disburse payout ${payable.payableNumber}: Assayer ${assayer.assayerCode || payable.assayerId} is missing PAN. Indian statutory compliance requires PAN before disbursement.`,
              );
            }

            const bankDoc = await m.findOne(AssayerDocumentEntity, {
              where: {
                assayerId: payable.assayerId,
                requirement: OnboardingDocument.BANK_PASSBOOK,
                isActive: true,
              },
            });

            // The same one definition the approval path uses — see payout-destination.ts. This
            // branch carried its own copy of the `?? new Date()` fabrication, so the payment row
            // repeated a claim nothing had ever backed.
            destinationSnapshot = resolvePayoutDestination(assayer, bankDoc);

            // Freeze onto payable record
            payable.destinationBankAccountNumber = destinationSnapshot.destinationBankAccountNumber;
            payable.destinationIfsc = destinationSnapshot.destinationIfsc;
            payable.destinationBankName = destinationSnapshot.destinationBankName;
            payable.destinationAccountHolderName = destinationSnapshot.destinationAccountHolderName;
            payable.payoutEvidenceVersionId = destinationSnapshot.payoutEvidenceVersionId;
            payable.destinationVerifiedAt = destinationSnapshot.destinationVerifiedAt;
            payable.destinationVerifiedSource = destinationSnapshot.destinationVerifiedSource;
            await m.save(payable);
          }
        }
      }

      await this.assertSegregationOfDuties(
        userId,
        payable.approvedBy,
        `approve payout ${payable.payableNumber} and also pay it`,
        { entityType: 'PAYABLE', entityId: payable.id, payableNumber: payable.payableNumber },
      );
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
        receivedDate: dto.paidDate ?? businessTodayDateKey(),
        payableId: payable.id,
        assayerId: payable.assayerId,
        runningBalance: balance,
        invoiceId: null,
        notes: dto.notes ?? null,
        destinationBankAccountNumber: destinationSnapshot.destinationBankAccountNumber,
        destinationIfsc: destinationSnapshot.destinationIfsc,
        destinationBankName: destinationSnapshot.destinationBankName,
        destinationAccountHolderName: destinationSnapshot.destinationAccountHolderName,
        payoutEvidenceVersionId: destinationSnapshot.payoutEvidenceVersionId,
        destinationVerifiedAt: destinationSnapshot.destinationVerifiedAt,
        destinationVerifiedSource: destinationSnapshot.destinationVerifiedSource,
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
      // Compliance trail for the actual outbound money movement — who authorised the disbursement,
      // how much left, to whom, and against which reference. Same manager as the state change.
      const manager = m;
      await this.auditService.recordEvent({
        category: EventCategory.WORKFLOW,
        eventType: 'PAYABLE_DISBURSED',
        entityType: 'PAYMENT',
        entityId: saved.id,
        previousState: fromStatus,
        newState: payable.status,
        userId,
        remarks: `Disbursed ₹${amount} against ${payable.payableNumber} (ref ${dto.paymentReference})`,
        metadata: {
          paymentId: saved.id,
          payableId: payable.id,
          payableNumber: payable.payableNumber,
          assayerId: payable.assayerId,
          clientId: payable.clientId,
          amount,
          paymentReference: dto.paymentReference,
          method: dto.method,
          balanceAfterDisbursement: balance,
          fullyPaid,
        },
      }, { manager });
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
      const issueDate = dto.issueDate ?? businessTodayDateKey();

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
      if (!invoice.issueDate) invoice.issueDate = businessTodayDateKey();
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
      // Issuing turns a draft into a real receivable — the point money becomes owed to us.
      const manager = m;
      await this.auditService.recordEvent({
        category: EventCategory.WORKFLOW,
        eventType: 'INVOICE_ISSUED',
        entityType: 'INVOICE',
        entityId: saved.id,
        previousState: InvoiceStatus.DRAFT,
        newState: InvoiceStatus.ISSUED,
        userId,
        remarks: `Issued invoice ${saved.invoiceNumber} (₹${Number(saved.total)}) to client ${saved.clientId}`,
        metadata: {
          invoiceId: saved.id,
          invoiceNumber: saved.invoiceNumber,
          clientId: saved.clientId,
          projectId: saved.projectId,
          amount: Number(saved.total),
          dueDate: saved.dueDate,
        },
      }, { manager });
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
      // The invoice-void: an audit reader must be able to tell a cancelled receivable from a
      // collected one without cross-referencing billing_history.
      const manager = m;
      await this.auditService.recordEvent({
        category: EventCategory.WORKFLOW,
        eventType: 'INVOICE_CANCELLED',
        entityType: 'INVOICE',
        entityId: saved.id,
        previousState: fromStatus,
        newState: InvoiceStatus.CANCELLED,
        userId,
        remarks: reason.trim(),
        metadata: {
          invoiceId: saved.id,
          invoiceNumber: saved.invoiceNumber,
          clientId: saved.clientId,
          projectId: saved.projectId,
          amount: Number(saved.total),
          reason: reason.trim(),
        },
      }, { manager });
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
        receivedDate: dto.receivedDate ?? businessTodayDateKey(),
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
      // Compliance trail for the actual inbound money movement.
      const manager = m;
      await this.auditService.recordEvent({
        category: EventCategory.WORKFLOW,
        eventType: 'PAYMENT_RECEIVED',
        entityType: 'PAYMENT',
        entityId: saved.id,
        previousState: fromStatus,
        newState: invoice.status,
        userId,
        remarks: `Received ₹${amount} against ${invoice.invoiceNumber} (ref ${dto.paymentReference})`,
        metadata: {
          paymentId: saved.id,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          clientId: invoice.clientId,
          amount,
          paymentReference: dto.paymentReference,
          method: dto.method,
          outstandingAfter: invoice.outstandingAmount,
        },
      }, { manager });
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
        const manager = m;
        await this.auditService.recordEvent({
          category: EventCategory.WORKFLOW,
          eventType: 'PAYMENT_REVERSED',
          entityType: 'PAYMENT',
          entityId: payment.id,
          previousState: fromStatus,
          newState: invoice.status,
          userId,
          remarks: reason.trim(),
          metadata: {
            paymentId: payment.id,
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            clientId: invoice.clientId,
            amount: Number(payment.amount),
            paymentReference: payment.paymentReference,
            direction: 'INBOUND',
            reason: reason.trim(),
          },
        }, { manager });
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
        const manager = m;
        await this.auditService.recordEvent({
          category: EventCategory.WORKFLOW,
          eventType: 'PAYMENT_REVERSED',
          entityType: 'PAYMENT',
          entityId: payment.id,
          previousState: fromStatus,
          newState: payable.status,
          userId,
          remarks: reason.trim(),
          metadata: {
            paymentId: payment.id,
            payableId: payable.id,
            payableNumber: payable.payableNumber,
            assayerId: payable.assayerId,
            clientId: payable.clientId,
            amount: Number(payment.amount),
            paymentReference: payment.paymentReference,
            direction: 'OUTBOUND',
            reason: reason.trim(),
          },
        }, { manager });
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
      // Clamp between 0 and the line's own total, with the cap floored at 0 for a credit
      // (negative) line: `Math.min(Math.max(0, share), -590)` is -590, which recorded a negative
      // payment against the credit, shrank `allocated`, and inflated the last line's share — the
      // difference then vanished from the allocation entirely.
      const linePaid = Math.min(Math.max(0, share), Math.max(0, lineTotal));
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

  /**
   * The SUM expressions behind "what is owed to this assayer" — ONE select list, so the staff
   * view and the gated assayer view can never disagree about what a figure means, only about
   * which rows are in it (see `assayerVisibleTotals`). Columns are `p.`-prefixed so the gated
   * variant can join the invoice table without ambiguity.
   */
  private static readonly ASSAYER_TOTALS_SELECT = `
      COALESCE(SUM(p.total_amount), 0)                                                           AS earned,
      COALESCE(SUM(p.paid_amount), 0)                                                            AS paid,
      COALESCE(SUM(p.total_amount - p.paid_amount) FILTER (WHERE p.on_hold = false), 0)          AS outstanding,
      COALESCE(SUM(p.total_amount) FILTER (WHERE p.status = 'PENDING' AND p.on_hold = false), 0) AS awaiting_approval,
      COALESCE(SUM(p.total_amount - p.paid_amount) FILTER (WHERE p.on_hold = true), 0)           AS on_hold,
      COALESCE(SUM(p.tds_amount), 0)                                                             AS tds_withheld,
      COUNT(*)::int                                                                              AS payable_count`;

  private totalsFromRow(r: any) {
    return {
      earned: round2(Number(r?.earned ?? 0)),
      paid: round2(Number(r?.paid ?? 0)),
      outstanding: round2(Number(r?.outstanding ?? 0)),
      awaitingApproval: round2(Number(r?.awaiting_approval ?? 0)),
      onHoldOrDisputed: round2(Number(r?.on_hold ?? 0)),
      tdsWithheld: round2(Number(r?.tds_withheld ?? 0)),
      payableCount: Number(r?.payable_count ?? 0),
    };
  }

  /**
   * The one predicate for "what is owed to this assayer", used by every screen that says so.
   *
   * LIVE payables only, for three reasons that all cost money:
   *
   *  1. `recordDisbursement` writes this `outstanding` into `billing_payments.running_balance` on
   *     every outbound payment. That is a stored, immutable figure on a real payment, and a
   *     voided payable inflates it permanently — it cannot be recomputed away later.
   *  2. The finance-facing assayer statement shows it as "Outstanding", so finance would chase
   *     money that does not exist, and a second disbursement on a redone assignment would look
   *     like it still left a balance owed.
   *  3. `tdsWithheld` on the same statement would double-count the same withholding.
   *
   * A voided payable is guaranteed to land in `outstanding` without this, because `voidPayable`
   * explicitly sets `on_hold = false` and `on_hold` is the only status-ish column that clause
   * filters on. `assayerVisibleTotals` below — the assayer-facing fork of this very query — has
   * carried `status <> 'VOIDED'` all along; only the internal one that writes to the ledger did not.
   */
  async assayerTotals(assayerId: string, manager?: EntityManager): Promise<{
    earned: number; paid: number; outstanding: number; awaitingApproval: number; onHoldOrDisputed: number;
    tdsWithheld: number; payableCount: number;
  }> {
    const rows = await (manager ?? this.payableRepository.manager).query(
      `SELECT ${BillingEngineService.ASSAYER_TOTALS_SELECT}
         FROM assayer_payables p
        WHERE p.assayer_id = $1 AND p.is_active = true${andLivePayableSql('p')}`,
      [assayerId],
    );
    return this.totalsFromRow(rows?.[0]);
  }

  /**
   * The same figures, over only the rows the ASSAYER may see: lines on an APPROVED invoice,
   * plus grandfathered `pre_invoicing_era` rows (revealed under the old rules), never VOIDED.
   * The SELECT list is shared with `assayerTotals` above — the fork narrows the WHERE, it never
   * re-derives a formula.
   */
  private async assayerVisibleTotals(assayerId: string): Promise<{
    earned: number; paid: number; outstanding: number; awaitingApproval: number; onHoldOrDisputed: number;
    tdsWithheld: number; payableCount: number;
  }> {
    const rows = await this.payableRepository.manager.query(
      `SELECT ${BillingEngineService.ASSAYER_TOTALS_SELECT}
         FROM assayer_payables p
         LEFT JOIN assayer_invoices ai ON ai.id = p.assayer_invoice_id
        WHERE p.assayer_id = $1 AND p.is_active = true
          AND p.status <> 'VOIDED'
          AND (p.pre_invoicing_era = true OR ai.status = 'APPROVED')`,
      [assayerId],
    );
    return this.totalsFromRow(rows?.[0]);
  }

  /**
   * An assayer's financial statement: what they earned, what we have paid, what is still owed,
   * and the rows behind it. The mobile app's Earnings screen is this, verbatim — it never
   * computes money of its own.
   *
   * `audience` forks the SHAPE, not the maths:
   *
   *  - `'staff'` (default): today's full statement, unchanged, plus each payable's
   *    `invoiceNumber`/`invoiceStatus` so finance can see which lines ride which invoice.
   *  - `'assayer'`: the earnings gate. Amounts appear only for payables whose invoice the
   *    assayer has been through the invite → submit → approve loop for (invoice APPROVED), plus
   *    grandfathered `preInvoicingEra` rows whose money was already revealed under the old
   *    rules; VOIDED rows never. Payments are filtered to those visible payables,
   *    `balanceAfter` is OMITTED (a running balance over rows the reader cannot see is a money
   *    leak in disguise), and a counts-only `invoicing` block says what is pending without a
   *    single rupee — the reveal happens on the invitation, never on the statement's teaser.
   *
   * Rollout gate: while `billing.assayerInvoicingEnabled` is off (or unreadable — the registry
   * key ships with the coordinator's settings change), the assayer audience keeps TODAY'S full
   * shape. Deploying this code dark must change nothing for the field app until the flag flips.
   */
  async assayerStatement(
    assayerId: string,
    scope?: Partial<GlobalScope>,
    audience: 'staff' | 'assayer' = 'staff',
  ): Promise<any> {
    const invoicingEnabled = await this.settings
      .get<boolean>('billing.assayerInvoicingEnabled')
      .then((v) => v === true)
      .catch(() => false);
    const gated = audience === 'assayer' && invoicingEnabled;

    // Loaded through the repository, not raw SQL, so the encrypted PAN is decrypted for the
    // statement's TDS block. tds.section is a label only — it never changes an amount.
    const [totals, payables, payments, assayer, tdsSection] = await Promise.all([
      gated ? this.assayerVisibleTotals(assayerId) : this.assayerTotals(assayerId),
      this.payableRepository.find({ where: { assayerId, isActive: true }, order: { createdAt: 'DESC' } }),
      this.paymentRepository.find({ where: { assayerId, direction: PaymentDirection.OUTBOUND, isActive: true }, order: { createdAt: 'DESC' } }),
      this.assayerRepository.findOne({ where: { id: assayerId } }).catch(() => null),
      this.settings.get<string>('billing.tdsSection').catch(() => '194J'),
    ]);
    // The staged region ceiling — an assayer carries its own home region directly, no join
    // needed. `null` (unresolved region, or an unrestricted caller) is always allowed through.
    await this.regionGuard.assertRegionAllowedStaged(assayer?.region ?? null, scope, 'billing-engine:assayer-statement');

    // Invoice labels for the payables that ride one — a lookup, never a recompute.
    const invoiceIds = [...new Set(payables.map((p) => p.assayerInvoiceId).filter(Boolean))] as string[];
    const invoiceRows: Array<{ id: string; invoice_number: string; status: string }> = invoiceIds.length
      ? await this.payableRepository.manager.query(
          `SELECT id, invoice_number, status FROM assayer_invoices WHERE id = ANY($1)`,
          [invoiceIds],
        )
      : [];
    const invoiceById = new Map(invoiceRows.map((r) => [r.id, r]));

    const payableRow = (p: AssayerPayableEntity) => {
      const inv = p.assayerInvoiceId ? invoiceById.get(p.assayerInvoiceId) : undefined;
      return {
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
        invoiceNumber: inv?.invoice_number ?? null,
        invoiceStatus: inv?.status ?? null,
      };
    };

    const head = {
      assayerId,
      assayerName: assayer?.displayName ?? null,
      assayerCode: assayer?.assayerCode ?? null,
      pan: assayer?.panNumber ?? null,
      tdsSection: tdsSection ?? '194J',
      totals,
    };

    if (!gated) {
      return {
        ...head,
        payables: payables.map(payableRow),
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

    // The gate: same predicate as `assayerVisibleTotals`, applied to the row lists.
    const visible = payables.filter(
      (p) =>
        p.status !== AssayerPayableStatus.VOIDED &&
        (p.preInvoicingEra ||
          (p.assayerInvoiceId && invoiceById.get(p.assayerInvoiceId)?.status === AssayerInvoiceStatus.APPROVED)),
    );
    const visibleIds = new Set(visible.map((p) => p.id));

    return {
      ...head,
      payables: visible.map((p) => ({
        ...payableRow(p),
        /** Revealed under the pre-invoicing rules — badged in the app, never re-billed. */
        preInvoicingEra: p.preInvoicingEra === true,
      })),
      // Only payments against visible payables; a payment against an invisible one names an
      // amount the gate exists to withhold. No `balanceAfter` for the same reason — a running
      // balance is computed over ALL payables and would leak the hidden ones' sum.
      payments: payments
        .filter((pm) => pm.payableId && visibleIds.has(pm.payableId))
        .map((pm) => ({
          id: pm.id,
          paymentReference: pm.paymentReference,
          method: pm.method,
          amount: Number(pm.amount),
          paidDate: pm.receivedDate,
          notes: pm.notes,
        })),
      invoicing: await this.assayerInvoicingBlock(assayerId),
    };
  }

  /**
   * The counts-only invoicing block for the gated statement: how much work awaits an invite
   * (COUNT over the same eligibility predicate `AssayerInvoiceService.invite` uses — imported,
   * not copied, so the teaser can never disagree with the invite about what is billable), and
   * the active invitation if one exists. Deliberately NO amounts.
   */
  private async assayerInvoicingBlock(assayerId: string): Promise<{
    awaitingInvoiceCount: number;
    invitation: { id: string; status: AssayerInvoiceStatus; lineCount: number } | null;
  }> {
    const mgr = this.payableRepository.manager;
    const [awaitingRows, invitationRows] = await Promise.all([
      mgr.query(
        `SELECT COUNT(*)::int AS n
           FROM assayer_payables p
          WHERE p.assayer_id = $1 AND ${ASSAYER_INVOICE_ELIGIBLE_SQL('p')}`,
        [assayerId],
      ),
      mgr.query(
        `SELECT id, status, line_count FROM assayer_invoices
          WHERE assayer_id = $1 AND status IN ('INVITED','SUBMITTED')
          LIMIT 1`,
        [assayerId],
      ),
    ]);
    const inv = invitationRows?.[0];
    return {
      awaitingInvoiceCount: Number(awaitingRows?.[0]?.n ?? 0),
      invitation: inv ? { id: inv.id, status: inv.status, lineCount: Number(inv.line_count) } : null,
    };
  }

  /**
   * A page of payouts with their labels — what the Payouts tab renders.
   *
   * `scope` is the staged region ceiling (see the "Region scoping" primitives below). An
   * unrestricted caller, or the rollout in `off` mode, takes the original unfiltered path
   * unchanged; a restricted caller in `log`/`enforce` mode joins to each payable's assignment's
   * branch region in the SAME query used to fetch the page, so `log` mode's warning is computed
   * from the page already in hand rather than a second round trip.
   */
  async listPayouts(filters: {
    assayerId?: string; clientId?: string; status?: AssayerPayableStatus; onHold?: boolean;
    page?: number | string; limit?: number | string;
  } = {}, scope?: Partial<GlobalScope>): Promise<BillingPage<any>> {
    const w = billingPageWindow(filters.page, filters.limit);
    const regionScopeMode = await this.regionGuard.stagedMode();
    const restrictedRegions = scope?.regions?.length ? scope.regions : null;

    if (!restrictedRegions || regionScopeMode === 'off') {
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

    const buildQuery = () => {
      const qb = this.payableRepository.createQueryBuilder('p').where('p.is_active = :isActive', { isActive: true });
      if (filters.assayerId) qb.andWhere('p.assayer_id = :assayerId', { assayerId: filters.assayerId });
      if (filters.clientId) qb.andWhere('p.client_id = :clientId', { clientId: filters.clientId });
      if (filters.status) qb.andWhere('p.status = :status', { status: filters.status });
      if (filters.onHold !== undefined) qb.andWhere('p.on_hold = :onHold', { onHold: filters.onHold });
      qb.leftJoin('assignments', 'rg_a', 'rg_a.id = p.assignment_id')
        .leftJoin('project_branches', 'rg_pb', 'rg_pb.id = rg_a.project_branch_id')
        .leftJoin('branches', 'rg_b', 'rg_b.id = rg_pb.branch_id');
      if (regionScopeMode === 'enforce') qb.andWhere('rg_b.region IN (:...regions)', { regions: restrictedRegions });
      return qb;
    };

    const listQb = buildQuery().addSelect('rg_b.region', 'region_scope').orderBy('p.createdAt', 'DESC').skip(w.skip).take(w.take);
    const [{ entities, raw }, total] = await Promise.all([listQb.getRawAndEntities(), buildQuery().getCount()]);

    if (regionScopeMode === 'log') {
      const outOfScope = raw.filter((r: any) => r.region_scope && !restrictedRegions.includes(r.region_scope)).length;
      if (outOfScope > 0) {
        this.logger.warn(
          `[region-scope:billing-engine:payouts] would filter ${outOfScope} of ${raw.length} row(s) — outside ` +
            `[${restrictedRegions.join(', ')}]. Currently in Log mode: request allowed through.`,
        );
      }
    }

    return { items: await this.attachPayableNames(entities), total, page: w.page, limit: w.limit };
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
  async listInvoiceable(filters: { clientId?: string } = {}, scope?: Partial<GlobalScope>): Promise<{
    clients: Array<{ clientId: string; clientName: string; total: number; count: number; lines: any[] }>;
    total: number;
    truncated: boolean;
  }> {
    const regionScopeMode = await this.regionGuard.stagedMode();
    const restrictedRegions = scope?.regions?.length ? scope.regions : null;
    // The query already joins to `branches` for the branch label — `off` leaves the query
    // untouched; `log`/`enforce` add the region column to the same round trip so `log`'s count
    // never costs a second query, and `enforce` narrows the WHERE by the same column.
    const needsRegion = !!restrictedRegions && regionScopeMode !== 'off';
    const applyFilter = !!restrictedRegions && regionScopeMode === 'enforce';

    const rows = await this.entryRepository.manager.query(
      `SELECT e.id, e.entry_number, e.client_id, c.name AS client_name, e.project_id, p.name AS project_name,
              e.assignment_id, a.assignment_number, b.name AS branch_name, e.assayer_id, s.display_name AS assayer_name,
              e.service_date, e.on_hold, e.hold_reason, e.base_amount, e.travel_amount, e.adjustment_amount,
              e.taxable_amount, e.tax_amount, e.tds_amount, e.total_amount${needsRegion ? ', b.region AS region_scope' : ''}
         FROM billing_entries e
         JOIN clients c ON c.id = e.client_id
         LEFT JOIN projects p ON p.id = e.project_id
         LEFT JOIN assignments a ON a.id = e.assignment_id
         LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
         LEFT JOIN branches b ON b.id = pb.branch_id
         LEFT JOIN assayers s ON s.id = e.assayer_id
        WHERE e.is_active = true AND e.state = 'UNBILLED'
          AND ($1::uuid IS NULL OR e.client_id = $1::uuid)
          ${applyFilter ? 'AND b.region = ANY($2::text[])' : ''}
        ORDER BY c.name ASC, e.service_date DESC NULLS LAST, e.created_at DESC
        LIMIT ${INVOICEABLE_LIMIT}`,
      applyFilter ? [filters.clientId ?? null, restrictedRegions] : [filters.clientId ?? null],
    );

    if (needsRegion && regionScopeMode === 'log') {
      const outOfScope = rows.filter((r: any) => r.region_scope && !restrictedRegions!.includes(r.region_scope)).length;
      if (outOfScope > 0) {
        this.logger.warn(
          `[region-scope:billing-engine:invoiceable] would filter ${outOfScope} of ${rows.length} row(s) — outside ` +
            `[${restrictedRegions!.join(', ')}]. Currently in Log mode: request allowed through.`,
        );
      }
    }

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

  /**
   * Client lines with their labels — the export and the assignment filter read this.
   *
   * `paginate` defaults to false so the one internal caller that needs every matching line in
   * one shot — the billing export in `reports.service.ts`, which self-caps at its own
   * `EXPORT_ROW_CAP` and says so in a comment there — keeps its existing unbounded array back
   * unchanged. `GET /billing/lines` is the caller that actually needs bounding: an unauthenticated
   * ceiling here would have let `?state=` with no other filter return the entire, ever-growing
   * `billing_entries` table in one response. The controller always passes `paginate: true` with
   * a limit clamped by the same `billingPageWindow` used by `listPayouts`/`findInvoicesPage`.
   *
   * Overloaded (rather than one signature returning `any[] | BillingPage<any>`) so each caller's
   * return type is pinned to the literal `paginate` value it passes, instead of every caller
   * having to narrow a union it never actually receives both halves of.
   */
  async listClientLines(
    filters?: {
      clientId?: string; projectId?: string; assignmentId?: string; assayerId?: string; state?: BillingState; onHold?: boolean;
      page?: number | string; limit?: number | string;
    },
    scope?: Partial<GlobalScope>,
    paginate?: false,
  ): Promise<any[]>;
  async listClientLines(
    filters: {
      clientId?: string; projectId?: string; assignmentId?: string; assayerId?: string; state?: BillingState; onHold?: boolean;
      page?: number | string; limit?: number | string;
    },
    scope: Partial<GlobalScope> | undefined,
    paginate: true,
  ): Promise<BillingPage<any>>;
  async listClientLines(filters: {
    clientId?: string; projectId?: string; assignmentId?: string; assayerId?: string; state?: BillingState; onHold?: boolean;
    page?: number | string; limit?: number | string;
  } = {}, scope?: Partial<GlobalScope>, paginate = false): Promise<any[] | BillingPage<any>> {
    const w = billingPageWindow(filters.page, filters.limit);
    const regionScopeMode = await this.regionGuard.stagedMode();
    const restrictedRegions = scope?.regions?.length ? scope.regions : null;

    if (!restrictedRegions || regionScopeMode === 'off') {
      const where: Record<string, unknown> = {};
      if (filters.clientId) where.clientId = filters.clientId;
      if (filters.projectId) where.projectId = filters.projectId;
      if (filters.assignmentId) where.assignmentId = filters.assignmentId;
      if (filters.assayerId) where.assayerId = filters.assayerId;
      if (filters.state) where.state = filters.state;
      if (filters.onHold !== undefined) where.onHold = filters.onHold;
      if (!paginate) {
        const entries = await this.entryRepository.find({ where, order: { createdAt: 'DESC' } });
        return this.attachEntryNames(entries);
      }
      const [entries, total] = await this.entryRepository.findAndCount({
        where, order: { createdAt: 'DESC' }, skip: w.skip, take: w.take,
      });
      return { items: await this.attachEntryNames(entries), total, page: w.page, limit: w.limit };
    }

    // One query builder shape shared by the page fetch and the count, so the two can never
    // disagree about which rows match — built fresh each time because a TypeORM QueryBuilder is
    // stateful and a `.getCount()` after `.skip()/.take()` would count only the page, not the
    // whole result set the page is drawn from.
    const buildQuery = () => {
      const qb = this.entryRepository.createQueryBuilder('e');
      if (filters.clientId) qb.andWhere('e.client_id = :clientId', { clientId: filters.clientId });
      if (filters.projectId) qb.andWhere('e.project_id = :projectId', { projectId: filters.projectId });
      if (filters.assignmentId) qb.andWhere('e.assignment_id = :assignmentId', { assignmentId: filters.assignmentId });
      if (filters.assayerId) qb.andWhere('e.assayer_id = :assayerId', { assayerId: filters.assayerId });
      if (filters.state) qb.andWhere('e.state = :state', { state: filters.state });
      if (filters.onHold !== undefined) qb.andWhere('e.on_hold = :onHold', { onHold: filters.onHold });
      qb.leftJoin('assignments', 'rg_a', 'rg_a.id = e.assignment_id')
        .leftJoin('project_branches', 'rg_pb', 'rg_pb.id = rg_a.project_branch_id')
        .leftJoin('branches', 'rg_b', 'rg_b.id = rg_pb.branch_id');
      if (regionScopeMode === 'enforce') qb.andWhere('rg_b.region IN (:...regions)', { regions: restrictedRegions });
      return qb;
    };

    const pageQb = buildQuery().addSelect('rg_b.region', 'region_scope').orderBy('e.createdAt', 'DESC');
    if (paginate) pageQb.skip(w.skip).take(w.take);

    const { entities, raw } = await pageQb.getRawAndEntities();

    if (regionScopeMode === 'log') {
      const outOfScope = raw.filter((r: any) => r.region_scope && !restrictedRegions.includes(r.region_scope)).length;
      if (outOfScope > 0) {
        this.logger.warn(
          `[region-scope:billing-engine:lines] would filter ${outOfScope} of ${raw.length} row(s) — outside ` +
            `[${restrictedRegions.join(', ')}]. Currently in Log mode: request allowed through.`,
        );
      }
    }

    if (!paginate) return this.attachEntryNames(entities);
    const total = await buildQuery().getCount();
    return { items: await this.attachEntryNames(entities), total, page: w.page, limit: w.limit };
  }

  /**
   * Unpaginated by contract: the only caller is `reports.service.ts`'s billing export, which
   * needs every matching invoice with its lines in one shot to build a workbook, not a page.
   * `findInvoicesPage` is what `GET /invoices` actually serves — this method is not reachable
   * from any HTTP route.
   *
   * `FINDINVOICES_HARD_CAP` is a backstop, not a page size: an unfiltered export against an
   * ever-growing table should still fail loudly (or visibly truncate) rather than materialise an
   * unbounded result and every entry's relations with it. 5,000 matches the row ceiling the
   * exporter already applies to client lines from the same report (`EXPORT_ROW_CAP` in
   * reports.service.ts) — this cap does not attempt to invent a different number for the same job.
   */
  async findInvoices(filters: { clientId?: string; projectId?: string; status?: InvoiceStatus } = {}): Promise<BillingInvoiceEntity[]> {
    return this.invoiceRepository.find({
      where: this.invoiceWhere(filters), relations: ['entries'], order: { createdAt: 'DESC' },
      take: FINDINVOICES_HARD_CAP,
    });
  }

  private invoiceWhere(filters: { clientId?: string; projectId?: string; status?: InvoiceStatus }): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    if (filters.clientId) where.clientId = filters.clientId;
    if (filters.projectId) where.projectId = filters.projectId;
    if (filters.status) where.status = filters.status;
    return where;
  }

  /**
   * One page of invoices, with a line count and the client's name, and never the lines.
   *
   * An invoice can cover assignments in more than one region (see the region guard's
   * `assertInvoiceInScope`, which both this list and the detail route now share), so the ceiling
   * here mirrors the detail route's: a scoped caller sees an invoice only when NONE of its lines
   * resolve to a region outside their assignment — a partially-in-scope invoice would otherwise
   * be visible on the list but 403 when opened. Both honour `security.regionScope.mode`, so that
   * pairing holds in Log and Off mode too.
   */
  async findInvoicesPage(
    filters: { clientId?: string; projectId?: string; status?: InvoiceStatus; page?: number | string; limit?: number | string } = {},
    scope?: Partial<GlobalScope>,
  ): Promise<BillingPage<BillingInvoiceEntity & { entryCount: number; clientName: string | null }>> {
    const w = billingPageWindow(filters.page, filters.limit);
    const regionScopeMode = await this.regionGuard.stagedMode();
    const restrictedRegions = scope?.regions?.length ? scope.regions : null;

    let invoices: BillingInvoiceEntity[];
    let total: number;

    if (!restrictedRegions || regionScopeMode === 'off') {
      const [rows, count] = await this.invoiceRepository.findAndCount({
        where: this.invoiceWhere(filters), order: { createdAt: 'DESC' }, skip: w.skip, take: w.take,
      });
      invoices = rows;
      total = count;
    } else {
      const where = this.invoiceWhere(filters);
      const outOfScopeLine = `EXISTS (
        SELECT 1 FROM billing_entries rg_e
        JOIN assignments rg_a ON rg_a.id = rg_e.assignment_id
        LEFT JOIN project_branches rg_pb ON rg_pb.id = rg_a.project_branch_id
        LEFT JOIN branches rg_b ON rg_b.id = rg_pb.branch_id
        WHERE rg_e.invoice_id = i.id AND rg_b.region IS NOT NULL AND rg_b.region NOT IN (:...regions)
      )`;
      const buildQuery = () => {
        const qb = this.invoiceRepository.createQueryBuilder('i');
        if (where.clientId) qb.andWhere('i.client_id = :clientId', { clientId: where.clientId });
        if (where.projectId) qb.andWhere('i.project_id = :projectId', { projectId: where.projectId });
        if (where.status) qb.andWhere('i.status = :status', { status: where.status });
        if (regionScopeMode === 'enforce') qb.andWhere(`NOT ${outOfScopeLine}`, { regions: restrictedRegions });
        return qb;
      };
      const listQb = buildQuery()
        .addSelect(outOfScopeLine, 'would_filter')
        .setParameter('regions', restrictedRegions)
        .orderBy('i.createdAt', 'DESC')
        .skip(w.skip)
        .take(w.take);
      const [{ entities, raw }, count] = await Promise.all([listQb.getRawAndEntities(), buildQuery().getCount()]);
      invoices = entities;
      total = count;

      if (regionScopeMode === 'log') {
        const outOfScope = raw.filter((r: any) => r.would_filter === true).length;
        if (outOfScope > 0) {
          this.logger.warn(
            `[region-scope:billing-engine:invoices] would filter ${outOfScope} of ${raw.length} row(s) — a line ` +
              `outside [${restrictedRegions.join(', ')}]. Currently in Log mode: request allowed through.`,
          );
        }
      }
    }

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

  async getInvoice(invoiceId: string, scope?: Partial<GlobalScope>): Promise<any> {
    const invoice = await this.invoiceRepository.findOne({ where: { id: invoiceId }, relations: ['entries', 'payments'] });
    if (!invoice) throw new NotFoundException(`Invoice ${invoiceId} not found.`);
    await this.regionGuard.assertInvoiceInScope(invoiceId, scope, 'billing-engine:invoice');
    const [entries, clientRows] = await Promise.all([
      this.attachEntryNames(invoice.entries ?? []),
      this.invoiceRepository.manager.query(`SELECT name FROM clients WHERE id = $1`, [invoice.clientId]),
    ]);
    return { ...invoice, entries, clientName: clientRows?.[0]?.name ?? null, payments: (invoice.payments ?? []).filter((p) => p.isActive) };
  }

  /**
   * Everything a GST-compliant tax invoice document needs, in one payload.
   *
   * This does NOT recompute a single figure. The taxable value, tax rate and rupee tax on each
   * line are exactly what `assignmentMoney` booked and are read back unchanged; all this adds is
   * the two things a printable invoice needs on top of the stored totals:
   *
   *  1. the seller and client tax identity (seller from platform settings, never hardcoded), and
   *  2. how the already-computed tax is *labelled* — one IGST line when the seller and the place
   *     of supply are in different states, or a CGST half and an SGST half when they match. The
   *     halves are split so cgst + sgst equals the stored tax to the paisa (sgst takes the
   *     remainder), so the split can never disagree with the invoice total.
   *
   * Where the seller identity is not set, the field comes back null — the print view renders a
   * marked placeholder rather than a plausible-looking fake, so a half-configured system produces
   * an obviously-incomplete invoice instead of a wrong one.
   */
  async getInvoiceDocument(invoiceId: string, scope?: Partial<GlobalScope>): Promise<any> {
    const invoice = await this.invoiceRepository.findOne({ where: { id: invoiceId }, relations: ['entries'] });
    if (!invoice) throw new NotFoundException(`Invoice ${invoiceId} not found.`);
    await this.regionGuard.assertInvoiceInScope(invoiceId, scope, 'billing-engine:invoice-document');

    const [lines, clientRows, seller] = await Promise.all([
      this.attachEntryNames(invoice.entries ?? []),
      this.invoiceRepository.manager.query(
        `SELECT c.name, c.address, c.tax_id,
                cb.tax_identifier AS billing_gstin, cb.billing_address, cb.payment_terms
           FROM clients c
           LEFT JOIN client_billing cb ON cb.client_id = c.id AND cb.is_active = true
          WHERE c.id = $1 LIMIT 1`,
        [invoice.clientId],
      ),
      this.settings.getMany([
        'company.legalName', 'company.address', 'company.gstin', 'company.state', 'company.pan',
        'invoice.defaultSac',
      ]),
    ]);
    const c = clientRows?.[0] ?? {};

    // Seller state: the GSTIN prefix is authoritative; the typed state name is the fallback for a
    // system that has entered its state but not yet its GSTIN.
    const sellerGstin: string | null = seller['company.gstin'] ?? null;
    const sellerStateCode = resolveGstStateCode({ gstin: sellerGstin, stateName: seller['company.state'] });
    const sellerStateName = seller['company.state'] ?? gstStateCodeToName(sellerStateCode);

    // Place of supply for a service is the recipient's location; the client's GSTIN prefix is the
    // best signal we hold. No client GSTIN → we cannot know, and say so rather than guess.
    const clientGstin: string | null = c.billing_gstin ?? c.tax_id ?? null;
    const posCode = gstinStateCode(clientGstin);
    const posName = gstStateCodeToName(posCode) ?? null;

    const known = !!(sellerStateCode && posCode);
    const taxMode: 'INTRA' | 'INTER' = known && sellerStateCode !== posCode ? 'INTER' : 'INTRA';
    const defaultSac: string = seller['invoice.defaultSac'] ?? '998222';

    let cgstTotal = 0, sgstTotal = 0, igstTotal = 0, taxableTotal = 0;
    const docLines = lines.map((e: any, i: number) => {
      const taxable = round2(Number(e.taxableAmount));
      const tax = round2(Number(e.taxAmount));
      let cgst = 0, sgst = 0, igst = 0;
      if (taxMode === 'INTER') {
        igst = tax;
      } else {
        cgst = round2(tax / 2);
        sgst = round2(tax - cgst); // remainder to SGST so cgst + sgst === tax exactly
      }
      cgstTotal = round2(cgstTotal + cgst);
      sgstTotal = round2(sgstTotal + sgst);
      igstTotal = round2(igstTotal + igst);
      taxableTotal = round2(taxableTotal + taxable);
      const branch = e.branchName ?? null;
      return {
        srNo: i + 1,
        assignmentNumber: e.assignmentNumber ?? e.entryNumber,
        branchName: branch,
        serviceDate: e.serviceDate ?? null,
        description: e.description ?? `Audit services${branch ? ` — ${branch}` : ''}`,
        hsnSac: defaultSac,
        taxableAmount: taxable,
        taxRate: Number(e.taxRate),
        cgst, sgst, igst,
        total: round2(taxable + tax),
      };
    });

    const taxTotal = round2(Number(invoice.taxAmount));
    const invoiceValue = round2(Number(invoice.subtotal) + taxTotal);
    const tds = round2(Number(invoice.tdsAmount));

    return {
      invoice: {
        number: invoice.invoiceNumber,
        status: invoice.status,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        currency: invoice.currency,
        notes: invoice.notes,
        paymentTerms: c.payment_terms ?? null,
      },
      seller: {
        legalName: seller['company.legalName'] ?? null,
        address: seller['company.address'] ?? null,
        gstin: sellerGstin,
        stateName: sellerStateName ?? null,
        stateCode: sellerStateCode ?? null,
        pan: seller['company.pan'] ?? null,
      },
      client: {
        name: c.name ?? null,
        address: c.billing_address ?? c.address ?? null,
        gstin: clientGstin,
        stateName: posName,
        stateCode: posCode,
      },
      placeOfSupply: posCode ? { code: posCode, name: posName } : null,
      taxMode,
      /** True when seller state or place of supply could not be determined, so the split is a
       *  fallback (treated as intra-state) rather than a decision — the print view flags it. */
      taxSplitAssumed: !known,
      defaultSac,
      lines: docLines,
      totals: {
        taxable: round2(Number(invoice.subtotal)),
        cgst: cgstTotal,
        sgst: sgstTotal,
        igst: igstTotal,
        tax: taxTotal,
        invoiceValue,
        tds,
        netReceivable: round2(invoiceValue - tds),
      },
      amountInWords: numberToIndianWords(invoiceValue),
    };
  }

  /**
   * The bank details behind a set of selected payouts, for the NEFT bank file.
   *
   * Returns rows only for payouts that are genuinely payable — APPROVED, not on hold, with money
   * still outstanding — because a bank file that includes an already-paid or held row is how a
   * double payment or a mistaken disbursement leaves the building. Anything else in the selection
   * is returned in `skipped` with the reason, so the caller can tell the operator what was left
   * out rather than silently dropping it.
   *
   * PAN and account number are decrypted here (loaded through the repository); the endpoint that
   * exposes this is gated to the disbursement roles.
   */
  async payoutBankDetails(payableIds: string[], userId?: string): Promise<{
    rows: Array<{
      payableId: string; payableNumber: string; assignmentNumber: string | null;
      assayerName: string | null; assayerCode: string | null;
      beneficiaryName: string | null; accountNumber: string | null; ifsc: string | null; pan: string | null;
      netAmount: number; reference: string; hasBankDetails: boolean;
    }>;
    skipped: Array<{ id: string; reason: string }>;
  }> {
    const ids = [...new Set(payableIds)].filter(Boolean);
    if (!ids.length) return { rows: [], skipped: [] };

    const payables = await this.payableRepository.find({ where: { id: In(ids), isActive: true } });
    const found = new Map(payables.map((p) => [p.id, p]));
    const skipped: Array<{ id: string; reason: string }> = [];

    const payable = payables.filter((p) => {
      if (p.status !== AssayerPayableStatus.PAID && p.onHold) { skipped.push({ id: p.id, reason: `${p.payableNumber} is on hold` }); return false; }
      if (p.status === AssayerPayableStatus.PAID) { skipped.push({ id: p.id, reason: `${p.payableNumber} is already paid` }); return false; }
      if (p.status !== AssayerPayableStatus.APPROVED) { skipped.push({ id: p.id, reason: `${p.payableNumber} is not approved yet` }); return false; }
      if (round2(Number(p.totalAmount) - Number(p.paidAmount)) <= 0) { skipped.push({ id: p.id, reason: `${p.payableNumber} has nothing outstanding` }); return false; }
      return true;
    });
    for (const id of ids) if (!found.has(id)) skipped.push({ id, reason: 'Payout not found' });

    const assayerIds = [...new Set(payable.map((p) => p.assayerId))];
    const assayers = assayerIds.length
      ? await this.assayerRepository.find({ where: { id: In(assayerIds) } })
      : [];
    const byAssayer = new Map(assayers.map((a) => [a.id, a]));

    const rows = payable.map((p) => {
      const a = byAssayer.get(p.assayerId);
      // Strictly consume frozen destination banking details from payable snapshot — NEVER from live mutable assayer fields
      const account = p.destinationBankAccountNumber ?? null;
      const ifsc = p.destinationIfsc ?? null;
      const beneficiaryName = p.destinationAccountHolderName ?? a?.displayName ?? null;
      return {
        payableId: p.id,
        payableNumber: p.payableNumber,
        assignmentNumber: null as string | null, // filled below from a names lookup
        assayerName: a?.displayName ?? null,
        assayerCode: a?.assayerCode ?? null,
        beneficiaryName,
        accountNumber: account,
        ifsc,
        pan: a?.panNumber ?? null,
        netAmount: round2(Number(p.totalAmount) - Number(p.paidAmount)),
        reference: `${p.payableNumber}${a?.assayerCode ? ` ${a.assayerCode}` : ''}`,
        hasBankDetails: !!(account && ifsc),
      };
    });

    // Assignment numbers, for a human-readable narration, without a join on the sensitive load.
    const names = await this.resolveNames([], payable);
    for (let i = 0; i < rows.length; i++) {
      rows[i].assignmentNumber = names.assignments.get(payable[i].assignmentId) ?? null;
    }

    /**
     * The export leaves a trace. This is money leaving the company on an operator's upload, and
     * it was the ONE money movement in this service with no history row — a file exported twice
     * and uploaded twice was invisible until the bank statement arrived, and "who exported which
     * payables, when" had no answer. One row per payable, best-effort: a history failure must
     * not block a legitimate payment run, and `recordDisbursement` remains the authoritative
     * settlement step.
     */
    if (userId && payable.length) {
      const batchRef = `NEFT-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
      await Promise.all(payable.map((p) =>
        this.history(userId, {
          clientId: p.clientId, projectId: p.projectId, assignmentId: p.assignmentId, assayerId: p.assayerId,
          entityType: BillingEntityType.PAYABLE, entityId: p.id, action: 'PAYABLE_BANK_FILE_EXPORTED',
          newValue: { batchRef, payableNumber: p.payableNumber, netAmount: round2(Number(p.totalAmount) - Number(p.paidAmount)) },
          reason: `Included in NEFT bank file ${batchRef}`,
        }).catch(() => null),
      ));
    }

    return { rows, skipped };
  }

  /**
   * PAN-wise TDS withheld from assayers over a period — the substantiation finance needs to show
   * what was deducted and against whom. Reads the TDS the system already withheld (never
   * recomputes it); `gross − tds = net` by construction of the payable.
   *
   * `from`/`to` are inclusive calendar dates (YYYY-MM-DD) on the booking date; omit for the whole
   * book. Only assayers with TDS in the window appear.
   */
  /**
   * PAN follows the same rule here as everywhere else: masked to the last four unless the caller
   * is one of the roles entitled to the whole number, and audited when it is handed over.
   *
   * This route returned every payee's PAN in the clear to anyone who could open it. AUDITOR is
   * the sharp case — `scopeAssayerForRoles` strips identity fields from that role entirely, so an
   * auditor reading the person's own record gets no `panNumber` key at all, and could read five
   * PANs off this report in one call. No audit row was written either, while the single-field
   * reveal writes one per number.
   *
   * It slipped past the existing protection because that protection masks by key NAME
   * (`panNumber`, `aadhaarNumber`, `bankAccountNumber`) over objects shaped like an assayer, and
   * these rows are hand-built with a key called `pan`. Redaction keyed on names cannot cover a
   * payload that renames the key, which is why the decision is made here, explicitly, from the
   * caller's roles.
   *
   * `actor` is optional so the internal callers that build reports without a principal keep
   * working — and they get the masked form, which is the safe default.
   */
  async tdsReport(filters: { from?: string | null; to?: string | null } = {}, actor?: {
    id?: string; displayName?: string | null; roles?: string[]; ipAddress?: string | null;
  }): Promise<{
    from: string | null; to: string | null; section: string;
    rows: Array<{ assayerId: string; assayerName: string | null; assayerCode: string | null; pan: string | null; panMasked: boolean; gross: number; tds: number; net: number; count: number }>;
    totals: { gross: number; tds: number; net: number; count: number };
  }> {
    const from = filters.from || null;
    const to = filters.to || null;
    const [agg, section] = await Promise.all([
      this.payableRepository.manager.query(
        `SELECT assayer_id,
                COALESCE(SUM(base_amount + travel_amount), 0) AS gross,
                COALESCE(SUM(tds_amount), 0)                  AS tds,
                COALESCE(SUM(total_amount), 0)                AS net,
                COUNT(*)::int                                 AS n
           FROM assayer_payables
          WHERE is_active = true
            -- Fee payables only: TDS is withheld on the professional fee, not on expense
            -- reimbursements (which carry no TDS and would inflate the gross on a TDS report).
            AND expense_id IS NULL
            /*
             * LIVE payables only. This is the Form 26Q feed, and a voided payable keeps its full
             * amounts -- voidPayable sets the status and nothing else. A reopened-and-redone
             * audit now produces two fee payables in one quarter, and summing both would report
             * roughly double the professional fee and double the TDS deducted, against tax that
             * was never withheld or deposited. That is a misstatement to the tax authority and on
             * the assayer's Form 16A, correctable only by a revised return.
             *
             * The reasoning two lines above about what "would inflate the gross on a TDS report"
             * is right and stopped one line short.
             */
            AND ${livePayableSql('assayer_payables')}
            -- Bucketed by the IST calendar day, like every other date-window in this file
            -- (BUSINESS_TODAY_SQL): created_at is timestamptz on a UTC server, so a bare ::date
            -- files a payable booked 1 April 04:00 IST under 31 March — the previous financial
            -- year and quarter. A 26Q built from that misfiles every row between 00:00-05:30 IST.
            AND ($1::date IS NULL OR (created_at AT TIME ZONE 'Asia/Kolkata')::date >= $1::date)
            AND ($2::date IS NULL OR (created_at AT TIME ZONE 'Asia/Kolkata')::date <= $2::date)
          GROUP BY assayer_id
         HAVING SUM(tds_amount) > 0
          ORDER BY SUM(tds_amount) DESC`,
        [from, to],
      ),
      this.settings.get<string>('billing.tdsSection').catch(() => '194J'),
    ]);

    const assayerIds = agg.map((r: any) => r.assayer_id);
    const assayers = assayerIds.length ? await this.assayerRepository.find({ where: { id: In(assayerIds) } }) : [];
    const byId = new Map(assayers.map((a) => [a.id, a]));

    /**
     * The same list `scopeAssayerForRoles` uses for the whole number, matched on raw role names
     * because that is what a principal carries here. Anyone else gets the last four — which is
     * what the report is read for day to day (telling one payee's row from another's), while the
     * filing itself needs the reveal an entitled role performs deliberately.
     */
    const maySeeWholePan = (actor?.roles ?? []).some((r) =>
      r === SystemRole.ADMIN || r === SystemRole.OPERATIONS || r === SystemRole.DEVELOPER);

    const rows = agg.map((r: any) => {
      const a = byId.get(r.assayer_id);
      const pan = a?.panNumber ?? null;
      return {
        assayerId: r.assayer_id,
        assayerName: a?.displayName ?? null,
        assayerCode: a?.assayerCode ?? null,
        pan: pan ? (maySeeWholePan ? pan : maskTail(pan)) : null,
        /** So a reader knows whether they are looking at a number or a tail. */
        panMasked: !!pan && !maySeeWholePan,
        gross: round2(Number(r.gross)),
        tds: round2(Number(r.tds)),
        net: round2(Number(r.net)),
        count: Number(r.n),
      };
    });

    /**
     * A bulk reveal is still a reveal, and the trail has to say so.
     *
     * The single-field route writes one `ASSAYER_SENSITIVE_FIELD_REVEALED` row per number. This
     * hands over many at once and wrote none, so a compliance report could not tell that anybody
     * had ever read them. One row naming the actor, the count and the window — never the values,
     * for the same reason the single-field audit records the field and not the number.
     */
    const revealed = rows.filter((row: any) => row.pan && !row.panMasked);
    if (revealed.length && actor?.id) {
      await this.auditService.recordEvent({
        category: EventCategory.USER,
        eventType: 'ASSAYER_SENSITIVE_FIELD_REVEALED',
        entityType: 'ASSAYER',
        entityId: revealed[0].assayerId,
        userId: actor.id,
        userDisplayName: actor.displayName ?? undefined,
        ipAddress: actor.ipAddress ?? undefined,
        remarks: `Read the PAN of ${revealed.length} payee(s) from the TDS report`
          + `${from || to ? ` for ${from ?? 'the start of the book'} to ${to ?? 'today'}` : ' for the whole book'}.`,
        metadata: {
          field: 'pan', via: 'tds-report', count: revealed.length, from, to,
          assayerCodes: revealed.map((row: any) => row.assayerCode).filter(Boolean),
        },
      }).catch((err) => this.logger.error(`Failed to audit the TDS report PAN reveal: ${(err as Error).message}`));
    }
    const totals = rows.reduce(
      (t: { gross: number; tds: number; net: number; count: number }, r: any) => ({
        gross: round2(t.gross + r.gross), tds: round2(t.tds + r.tds), net: round2(t.net + r.net), count: t.count + r.count,
      }),
      { gross: 0, tds: 0, net: 0, count: 0 },
    );
    return { from, to, section: section ?? '194J', rows, totals };
  }

  /** Everything money-related about one assignment — the one line the assignment detail shows. */
  async assignmentMoneyLine(assignmentId: string, scope?: Partial<GlobalScope>): Promise<AssignmentMoneyLine> {
    const a = await this.assignmentRepository.findOne({ where: { id: assignmentId } });
    if (!a) throw new NotFoundException(`Assignment ${assignmentId} not found.`);
    // The staged region ceiling. An assignment carries no region of its own — it reaches one
    // through project_branches → branches, the same chain RegionGuardService.assertAssignmentInScope
    // joins for the already-enforced callers.
    if (scope?.regions?.length) {
      const region = await this.projectBranchRegion(a.projectBranchId);
      await this.regionGuard.assertRegionAllowedStaged(region, scope, 'billing-engine:assignment-money');
    }
    const [entries, payables, history] = await Promise.all([
      this.entryRepository.find({ where: { assignmentId }, order: { createdAt: 'ASC' } }),
      this.payableRepository.find({ where: { assignmentId, isActive: true }, order: { createdAt: 'ASC' } }),
      this.historyRepository.find({ where: { assignmentId }, order: { createdAt: 'DESC' }, take: 50 }),
    ]);
    /**
     * The LIVE leg is the headline; the dead ones stay in `superseded` as history.
     *
     * A reopened-and-redone assignment legitimately has two fee payables — the voided one from
     * the first completion and the live one from the redo — and this used to take whichever came
     * first by `createdAt`, which is the voided one. The screen then presented a voided payable
     * as *the* payable and reported `booked: true` beside it, on an assignment whose live money
     * this same bug had failed to book at all.
     */
    const feePayables = payables.filter((p) => !p.expenseId);
    const payable = feePayables.find((p) => isLivePayable(p.status)) ?? null;
    const entry = entries.find((e) => isLiveBillingEntry(e.state)) ?? null;
    const superseded = {
      payables: feePayables.filter((p) => !isLivePayable(p.status)) as any,
      entries: entries.filter((e) => !isLiveBillingEntry(e.state)) as any,
    };
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
      // `booked` means "this completion has a live financial effect", not "a row has ever
      // existed for it". Both legs, both live. See `billing-liveness.ts`.
      booked: !!(entry && payable),
      fee: fee.source === 'NONE' ? null : fee,
      payable: payable as any,
      /** Voided payables and cancelled lines from earlier completions of this same assignment. */
      superseded,
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
   *
   * ## Region scoping
   *
   * This route used to take no parameters at all, so a region-assigned operations account read
   * the whole organisation's book here — every other client's revenue, cost, outstanding and
   * cash, by client name — while the very tabs this screen heads (`listPayouts`,
   * `listClientLines`, `listInvoiceable`, `findInvoicesPage`) narrowed correctly. Confirmed
   * live: a NORTH-only account received a payload byte-identical to ADMIN's.
   *
   * `scope` is the same staged ceiling the list methods take, handled the same way — an
   * unrestricted caller, or the rollout in `off` mode, runs the original unfiltered SQL with no
   * predicate spliced in at all, so the national figures are exactly what they always were.
   * A restricted caller in `enforce` mode gets a region predicate on every one of the eight
   * queries (fifteen statements, counting the three grouped sub-selects inside `byClient` and
   * the six inside `attentionItems`), all built from `billing-region-scope.ts` so no two of
   * them can drift into disagreeing about what "in my region" means. `log` mode leaves the
   * figures national and reports what `enforce` would have removed.
   *
   * The one rule, stated in full in that file: a row counts when its region attribution
   * resolves and every region it resolves to is one the caller holds. So a payable on an
   * assignment with no project branch, a line whose branch has a null region, an invoice with
   * no lines and a payment settling neither a payable nor an invoice are all excluded for a
   * scoped caller and visible only to an unrestricted one — the alternative, counting them for
   * everybody, would put the same rupees in every region's total at once.
   */
  async overview(scope?: Partial<GlobalScope>): Promise<BillingOverview> {
    const mgr = this.entryRepository.manager;
    const n = (v: any) => round2(Number(v ?? 0));

    const regionScopeMode = await this.regionGuard.stagedMode();
    const restrictedRegions = scope?.regions?.length ? scope.regions : null;
    // Log mode reports, it does not narrow: only `enforce` puts the predicate in the WHERE.
    const enforced = restrictedRegions && regionScopeMode === 'enforce' ? restrictedRegions : null;
    const rg = billingRegionFilters(enforced);
    // `[]` for an unrestricted caller: the SQL below carries no placeholder to bind in that case.
    const rgp: unknown[] = enforced ? [enforced] : [];
    /**
     * How the payables table must be referred to INSIDE the first query below.
     *
     * `rg.as('p')` appends an alias only when region scoping is enforcing, so the same SQL reads
     * `FROM assayer_payables` in one mode and `FROM assayer_payables p` in the other — and once a
     * table carries an alias Postgres refuses its original name outright ("invalid reference to
     * FROM-clause entry for table assayer_payables"). The two `livePayableSql(...)` FILTERs wrote
     * that original name literally, so the billing overview failed for precisely the region-scoped
     * callers the scoping exists to serve, and for nobody else — which is why it survived the unit
     * suite. Deriving the reference from the same switch keeps the two in step by construction.
     */
    const payableRef = rg.as('p') ? 'p' : 'assayer_payables';

    const [payRows, entryRows, invRows, ageRows, cashRows, clientRows, history, attention] = await Promise.all([
      mgr.query(`
        SELECT COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE status = 'PENDING'  AND on_hold = false), 0) AS due,
               COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE status = 'APPROVED' AND on_hold = false), 0) AS approved,
               COALESCE(SUM(paid_amount), 0)                                                                    AS paid,
               COALESCE(SUM(total_amount - paid_amount) FILTER (WHERE on_hold = true), 0)                        AS held,
               COUNT(*) FILTER (WHERE status = 'PENDING'  AND on_hold = false)::int                              AS due_count,
               COUNT(*) FILTER (WHERE status = 'APPROVED' AND on_hold = false)::int                              AS approved_count,
               COUNT(*) FILTER (WHERE on_hold = true)::int                                                       AS held_count,
               COALESCE(SUM(base_amount + travel_amount) FILTER (WHERE ${livePayableSql(payableRef)}), 0) AS gross_cost,
               COALESCE(SUM(tds_amount) FILTER (WHERE ${livePayableSql(payableRef)}), 0)                     AS tds_from_assayers
          FROM assayer_payables${rg.as('p')} WHERE is_active = true${rg.payable('p')}`, rgp),
      mgr.query(`
        SELECT ${UNBILLED_RECEIVABLE_SQL} AS unbilled,
               ${HELD_RECEIVABLE_SQL}       AS held,
               ${REVENUE_TAXABLE_SQL}       AS revenue,
               COALESCE(SUM(tax_amount) FILTER (WHERE state <> 'CANCELLED'), 0)                    AS gst,
               COALESCE(SUM(tds_amount) FILTER (WHERE state <> 'CANCELLED'), 0)                    AS tds_by_clients
          FROM billing_entries${rg.as('e')} WHERE is_active = true${rg.entry('e')}`, rgp),
      mgr.query(`
        SELECT COALESCE(SUM(total) FILTER (WHERE status IN ('ISSUED','PAID')), 0)            AS invoiced,
               COALESCE(SUM(paid_amount) FILTER (WHERE status <> 'CANCELLED'), 0)            AS collected,
               COALESCE(SUM(outstanding_amount) FILTER (WHERE status = 'ISSUED'), 0)         AS outstanding
          FROM billing_invoices${rg.as('i')} WHERE is_active = true${rg.invoice('i')}`, rgp),
      mgr.query(
        `SELECT ${BillingEngineService.AGEING_SELECT} FROM billing_invoices${rg.as('i')} WHERE is_active = true AND status = 'ISSUED'${rg.invoice('i')}`, rgp),
      mgr.query(`
        SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'INBOUND'), 0)  AS cash_in,
               COALESCE(SUM(amount) FILTER (WHERE direction = 'OUTBOUND'), 0) AS cash_out
          FROM billing_payments${rg.as('pm')} WHERE is_active = true${rg.payment('pm')}`, rgp),
      // The three grouped sub-selects are narrowed rather than the outer query, so a client
      // with no in-region rows produces no group at all and drops out of `byClient` entirely —
      // rather than appearing with zeros, which would still disclose that the client exists.
      mgr.query(`
        SELECT c.id AS client_id, c.name AS client_name,
               (SELECT cc.default_base_fee FROM client_configurations cc
                 WHERE cc.client_id = c.id AND cc.is_active = true
                   AND (cc.effective_from IS NULL OR cc.effective_from <= NOW())
                   AND (cc.effective_to IS NULL OR cc.effective_to >= NOW())
                 ORDER BY cc.effective_from DESC NULLS LAST LIMIT 1) AS client_rate,
               COALESCE(e.unbilled, 0) AS unbilled, COALESCE(e.revenue, 0) AS revenue, COALESCE(e.assignment_count, 0) AS assignment_count,
               COALESCE(i.invoiced, 0) AS invoiced, COALESCE(i.outstanding, 0) AS outstanding,
               COALESCE(p.cost, 0) AS cost
          FROM clients c
          LEFT JOIN (SELECT be.client_id,
                            ${unbilledReceivableSql('be')} AS unbilled,
                            ${revenueTaxableSql('be')}     AS revenue,
                            COUNT(*) AS assignment_count
                       FROM billing_entries be WHERE be.is_active = true${rg.entry('be')} GROUP BY be.client_id) e ON e.client_id = c.id
          LEFT JOIN (SELECT bi.client_id,
                            SUM(bi.total) FILTER (WHERE bi.status IN ('ISSUED','PAID')) AS invoiced,
                            SUM(bi.outstanding_amount) FILTER (WHERE bi.status = 'ISSUED') AS outstanding
                       FROM billing_invoices bi WHERE bi.is_active = true${rg.invoice('bi')} GROUP BY bi.client_id) i ON i.client_id = c.id
          LEFT JOIN (SELECT ap.client_id, SUM(ap.base_amount + ap.travel_amount) AS cost
                       FROM assayer_payables ap
                      WHERE ap.is_active = true${rg.payable('ap')}${andLivePayableSql('ap')}
                      GROUP BY ap.client_id) p ON p.client_id = c.id
         WHERE c.is_active = true AND (e.client_id IS NOT NULL OR i.client_id IS NOT NULL OR p.client_id IS NOT NULL)
         ORDER BY c.name`, rgp),
      this.recentBillingActivity(rg.history('h'), rgp),
      this.attentionItems(rg, rgp),
    ]);

    if (restrictedRegions && regionScopeMode === 'log') {
      await this.warnOverviewOutOfScope(restrictedRegions);
    }
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
      recentActivity: history,
    };
  }

  /**
   * The last 30 billing events, narrowed to the caller's regions when they have any.
   *
   * A history row reaches a region exactly the way a payable or a client line does — through
   * its `assignment_id`. Rows carrying none (a client-level or invoice-level event) are
   * unattributable and follow the same rule as every other unattributable row: national
   * callers only.
   *
   * The unrestricted path is the original repository call, untouched, so nothing about the
   * national view depends on this method having been written.
   */
  private async recentBillingActivity(
    regionFilter: string,
    params: unknown[],
  ): Promise<BillingOverview['recentActivity']> {
    if (!regionFilter) {
      const rows = await this.historyRepository.find({ order: { createdAt: 'DESC' }, take: 30 });
      return rows.map((h) => ({
        id: h.id, action: h.action, entityType: h.entityType, entityId: h.entityId,
        fromState: h.fromState, toState: h.toState, reason: h.reason,
        occurredAt: h.createdAt as unknown as string, userName: h.userName,
      }));
    }
    const rows = await this.historyRepository.manager.query(
      `SELECT h.id, h.action, h.entity_type, h.entity_id, h.from_state, h.to_state, h.reason,
              h.created_at, h.user_name
         FROM billing_history h
        WHERE true${regionFilter}
        ORDER BY h.created_at DESC
        LIMIT 30`,
      params,
    );
    return rows.map((r: any) => ({
      id: r.id, action: r.action, entityType: r.entity_type, entityId: r.entity_id,
      fromState: r.from_state, toState: r.to_state, reason: r.reason,
      occurredAt: r.created_at, userName: r.user_name,
    }));
  }

  /**
   * Log mode's report for the overview.
   *
   * A list endpoint counts what it would have dropped from the page it already holds. An
   * aggregate holds one number and no rows, so the count has to be asked for — one statement
   * over the five base tables, run only for a restricted caller and only in Log mode.
   */
  private async warnOverviewOutOfScope(regions: readonly string[]): Promise<void> {
    try {
      const rows = await this.entryRepository.manager.query(BILLING_OUT_OF_SCOPE_COUNTS_SQL, [regions]);
      const r = rows?.[0] ?? {};
      const parts = ['payables', 'entries', 'invoices', 'payments', 'history']
        .map((k) => [k, Number(r[k] ?? 0)] as const)
        .filter(([, count]) => count > 0)
        .map(([k, count]) => `${count} ${k}`);
      if (parts.length === 0) return;
      this.logger.warn(
        `[region-scope:billing-engine:overview] would exclude ${parts.join(', ')} from the totals — ` +
          `outside [${regions.join(', ')}]. Currently in Log mode: organisation-wide figures returned.`,
      );
    } catch (err) {
      this.logger.warn(`[region-scope:billing-engine:overview] could not compute the Log-mode count: ${err}`);
    }
  }

  /**
   * What finance should look at. Each kind is a query over the live rows — there is no
   * "conflict" object to raise, resolve, or forget. Fix the cause and the item disappears.
   *
   * Every item names an assignment, a client, an assayer or an invoice, so the list is narrowed
   * by the same rule as the figures above it: each of the six queries anchors on whichever of
   * those it selects from, through `billingRegionFilters`. `rg` is inert for an unrestricted
   * caller, which leaves all six statements exactly as they were.
   */
  private async attentionItems(
    rg: BillingRegionFilters = billingRegionFilters(null),
    params: unknown[] = [],
  ): Promise<BillingAttentionItem[]> {
    const mgr = this.entryRepository.manager;
    /**
     * Each kind fails soft — one broken query must not take the whole overview down. It now
     * says so in the log instead of vanishing silently, which is what made a malformed
     * predicate here indistinguishable from "nothing needs attention".
     */
    const q = (sql: string, kind: string): Promise<any[]> =>
      mgr.query(sql, params).catch((err) => {
        this.logger.warn(`[billing-engine:attention:${kind}] query failed, this kind omitted: ${err}`);
        return [] as any[];
      });
    const [unbooked, unsettled, feeChanged, heldPayables, heldLines, overdue] = await Promise.all([
      q(`
        SELECT a.id, a.assignment_number, c.name AS client_name, s.display_name AS assayer_name,
               (e.id IS NULL) AS no_entry, (p.id IS NULL) AS no_payable,
               CASE WHEN a.agreed_fee > 0 THEN a.agreed_fee WHEN a.proposed_fee > 0 THEN a.proposed_fee ELSE 0 END AS fee
          FROM assignments a
          LEFT JOIN billing_entries e ON e.assignment_id = a.id AND ${liveBillingEntrySql('e')}
          LEFT JOIN assayer_payables p ON p.assignment_id = a.id AND p.expense_id IS NULL AND ${livePayableSql('p')}
          LEFT JOIN projects pr ON pr.id = a.project_id
          LEFT JOIN clients c ON c.id = pr.client_id
          LEFT JOIN assayers s ON s.id = a.assayer_id
         -- No a.is_active filter, matching unbookedAssignmentIds: a deleted assayer's cascade
         -- deactivates their assignments, but a COMPLETED audit still needs billing regardless.
         -- LIVE legs only, also matching unbookedAssignmentIds — a voided payable is history, and
         -- counting it as a leg is what kept a redone-but-unpaid audit off this very tile.
         WHERE a.status = 'COMPLETED' AND (e.id IS NULL OR p.id IS NULL)${rg.assignment('a')}
         ORDER BY a.completion_date DESC NULLS LAST LIMIT ${ATTENTION_LIMIT}`, 'unbooked'),
      q(`
        SELECT p.id, p.assignment_id, a.assignment_number, s.display_name AS assayer_name, p.total_amount
          FROM assayer_payables p
          JOIN assignments a ON a.id = p.assignment_id
          LEFT JOIN assayers s ON s.id = p.assayer_id
         WHERE p.is_active = true AND p.expense_id IS NULL AND (p.rate_snapshot->>'settled') = 'false'${rg.payable('p')}
         ORDER BY p.created_at DESC LIMIT ${ATTENTION_LIMIT}`, 'unsettled'),
      q(`
        SELECT p.id, p.assignment_id, a.assignment_number, s.display_name AS assayer_name,
               (p.rate_snapshot->>'feeAmount')::numeric AS booked_fee,
               CASE WHEN a.agreed_fee > 0 THEN a.agreed_fee WHEN a.proposed_fee > 0 THEN a.proposed_fee ELSE 0 END AS current_fee
          FROM assayer_payables p
          JOIN assignments a ON a.id = p.assignment_id
          LEFT JOIN assayers s ON s.id = p.assayer_id
         WHERE p.is_active = true AND p.expense_id IS NULL
           AND (p.rate_snapshot->>'feeAmount') IS NOT NULL
           AND (p.rate_snapshot->>'feeAmount')::numeric <>
               CASE WHEN a.agreed_fee > 0 THEN a.agreed_fee WHEN a.proposed_fee > 0 THEN a.proposed_fee ELSE 0 END${rg.payable('p')}
         ORDER BY p.created_at DESC LIMIT ${ATTENTION_LIMIT}`, 'fee-changed'),
      q(`
        SELECT p.id, p.assignment_id, a.assignment_number, s.display_name AS assayer_name, p.total_amount - p.paid_amount AS amount, p.hold_reason
          FROM assayer_payables p
          LEFT JOIN assignments a ON a.id = p.assignment_id
          LEFT JOIN assayers s ON s.id = p.assayer_id
         WHERE p.is_active = true AND p.on_hold = true${rg.payable('p')}
         ORDER BY p.updated_at DESC LIMIT ${ATTENTION_LIMIT}`, 'held-payable'),
      q(`
        SELECT e.id, e.assignment_id, a.assignment_number, c.name AS client_name, e.total_amount, e.hold_reason
          FROM billing_entries e
          LEFT JOIN assignments a ON a.id = e.assignment_id
          LEFT JOIN clients c ON c.id = e.client_id
         WHERE e.is_active = true AND e.on_hold = true${rg.entry('e')}
         ORDER BY e.updated_at DESC LIMIT ${ATTENTION_LIMIT}`, 'held-line'),
      q(`
        SELECT i.id, i.invoice_number, c.name AS client_name, i.outstanding_amount, i.due_date,
               (${BUSINESS_TODAY_SQL} - i.due_date) AS days_overdue
          FROM billing_invoices i
          LEFT JOIN clients c ON c.id = i.client_id
         WHERE i.is_active = true AND i.status = 'ISSUED' AND i.due_date < ${BUSINESS_TODAY_SQL} AND i.outstanding_amount > 0${rg.invoice('i')}
         ORDER BY i.due_date ASC LIMIT ${ATTENTION_LIMIT}`, 'overdue'),
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

  // -----------------------------------------------------------------------
  // Segregation of duties (staged) — see security.segregationOfDuties.mode in
  // settings.registry.ts. approvePayouts compares the approver against whoever booked the
  // ASSIGNMENT (not the payable's own createdBy, which is almost always the automated
  // on-completion event); recordDisbursement compares the disburser against payable.approvedBy,
  // already on the row. Both share this one check — only the two actor ids being compared differ.
  // -----------------------------------------------------------------------

  /**
   * The mode in force, never fail-open.
   *
   * The `.catch()` used to answer 'off' — so a settings store that could not be read silently
   * switched the money control off, which is the one failure mode a maker-checker gate must not
   * have. `PlatformSettingsService.get` already degrades to environment-then-shipped-default on
   * its own (`load()` swallows a read failure and returns no saved rows), so the only way here
   * is an unknown key, and the honest answer to that is what this build ships — read from the
   * registry rather than repeated as a literal, so the default lives in exactly one place.
   */
  private async sodMode(): Promise<'off' | 'warn' | 'enforce'> {
    const mode = await this.settings
      .get<string>(SEGREGATION_OF_DUTIES_SETTING_KEY)
      .catch(() => SETTING_BY_KEY[SEGREGATION_OF_DUTIES_SETTING_KEY]?.default ?? 'enforce');
    return mode === 'warn' || mode === 'off' ? mode : 'enforce';
  }

  /**
   * Refuses (Enforce) or records (Warn) when `actorId` is the same account as `otherPartyId`.
   *
   * Every same-person attempt reaches `audit_events`, refused or not. A control that only threw
   * an exception left nothing behind: the refusal was a 409 in one operator's browser and the
   * Warn-mode pass-through was a log line that rotates. "Who tried to approve and pay their own
   * payout, and when" is precisely the question this control exists to be able to answer, and it
   * has to survive the request. Recorded with `recordEventSafe` so a failure to write the trail
   * can never turn a refusal into a permission.
   */
  private async assertSegregationOfDuties(
    actorId: string,
    otherPartyId: string | null | undefined,
    context: string,
    subject?: { entityType: 'PAYABLE'; entityId: string; payableNumber?: string | null },
  ): Promise<void> {
    if (!otherPartyId || otherPartyId !== actorId) return;
    const mode = await this.sodMode();
    if (mode === 'off') return;

    await this.auditService.recordEventSafe({
      category: EventCategory.SYSTEM,
      eventType: mode === 'enforce' ? 'SEGREGATION_OF_DUTIES_REFUSED' : 'SEGREGATION_OF_DUTIES_WARNED',
      entityType: subject?.entityType ?? 'PAYABLE',
      entityId: subject?.entityId ?? NOT_A_RECORD_ENTITY_ID,
      userId: actorId,
      outcome: mode === 'enforce' ? 'DENIED' : 'SUCCESS',
      remarks:
        mode === 'enforce'
          ? `Refused: the same account cannot ${context}.`
          : `Allowed under Warn mode: the same account would not be permitted to ${context}.`,
      metadata: { mode, context, actorId, otherPartyId, payableNumber: subject?.payableNumber ?? null },
    });

    if (mode === 'enforce') {
      throw new ConflictException(`Segregation of duties: the same account cannot ${context}.`);
    }
    this.logger.warn(`[sod:${context}] would refuse — same account (${actorId}) on both sides. Currently in Warn mode: request allowed through.`);
  }

  // -----------------------------------------------------------------------
  // Region scoping (staged) — billing rows carry no region of their own; every one of them
  // reaches a region through the assignment → project_branch → branch chain
  // `RegionGuardService.assertAssignmentInScope` already joins for its already-enforced callers.
  // -----------------------------------------------------------------------

  /** The region a project_branch's branch belongs to, or `null` if either leg is missing. */
  private async projectBranchRegion(projectBranchId: string | null | undefined): Promise<string | null> {
    if (!projectBranchId) return null;
    const rows = await this.assignmentRepository.manager.query(
      `SELECT b.region FROM project_branches pb JOIN branches b ON b.id = pb.branch_id WHERE pb.id = $1`,
      [projectBranchId],
    );
    return rows?.[0]?.region ?? null;
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
   *
   * Public for the module's sibling `AssayerInvoiceService` only — the trail must have ONE
   * writer, and a second copy of this method is how two trails start disagreeing about the
   * user-name resolution. Not part of any HTTP surface.
   */
  async history(userId: string, h: Partial<BillingHistoryEntity>, manager?: EntityManager): Promise<BillingHistoryEntity> {
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
