import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, EntityManager, Raw } from 'typeorm';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { isUniqueViolation } from '../../infrastructure/database/unique-violation';
import { AssayerInvoiceEntity } from './assayer-invoice.entity';
import { AssayerPayableEntity } from './payable.entity';
import { ASSAYER_INVOICE_ELIGIBLE_SQL } from './assayer-invoice-eligibility';
import { BillingEngineService, billingPageWindow, BillingPage, isApprovedBill } from './billing-engine.service';
import { AuditService } from '../../core/audit/audit.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { round2, MONEY_EPSILON } from './assignment-money';
import type { ProgressCallback } from '../../infrastructure/queue/queued-job';
import { withCode } from '../../infrastructure/http/api-error';
import { AssayerInvoiceStatus, AssayerPayableStatus, BillingEntityType, EventCategory, AssayerInvoiceInvitation, AssayerInvoiceLine, AssayerInvoiceSummary, AssayerInvoiceInviteOutcome, businessDateKey, hodRejectReasonProblem } from '@fapoms/shared';

/**
 * The assayer-invoice lifecycle: invite → submit → approve (and cancel).
 *
 * The invoice is a consent-and-visibility wrapper over EXISTING payables — the payable is the
 * line, attached by `assayer_payables.assayer_invoice_id`. Nothing here prices anything: every
 * amount is a SUM of amounts `assignmentMoney` already snapshotted at booking, and the approve
 * step RE-VERIFIES those sums rather than recomputing them (drift is a 409, not a silent fix).
 *
 * Why the ceremony exists at all: the assayer sees no money anywhere in the app until ops
 * invites them to bill their unbilled work. `getInvitationFor` is THE reveal — the first payload
 * in the system that shows an assayer a rupee — and `submit` is their consent to those exact
 * figures, which is why submission is idempotent by `submittedRequestId` (a mobile retry must
 * confirm once, not twice) and why a SUBMITTED invoice's line set is frozen everywhere else
 * (see `BillingEngineService.releaseFromAssayerInvoice`).
 *
 * Approving the invoice IS approving its lines: each still-PENDING payable goes through the
 * same `approvePayableInTx` gate `approvePayouts` uses — segregation-of-duties assert, history
 * row, audit row and all — in the invoice's own transaction, with the N per-payable pushes
 * replaced by one `ASSAYER_INVOICE_APPROVED` notification.
 *
 * All writes ride `UnitOfWork` transactions with the rows write-locked, exactly as
 * `billing-engine.service.ts` does; history rows go through the engine's one `history` writer.
 */
/** The shortest reason accepted when staff confirm a bill for the assayer (audit F5). */
export const SUBMIT_ON_BEHALF_REASON_MIN = 10;

/**
 * The refusal an office approval gets when re-deciding the lines' TDS moved the bill's net total
 * (audit F4 no-PAN re-rate, F15 s.194J threshold). The assayer confirmed a figure; they are not
 * paid a different one without confirming it — the bill goes back to them as a new revision.
 */
export const BILL_TAX_RECALCULATED_MESSAGE =
  'The bill amount changed because tax was recalculated — sent back to the assayer to confirm';

type RevisionNotice = { assayerId: string; invoiceId: string; invoiceNumber: string; count: number; revision: number };

/** Thrown inside the approval transaction so it rolls back whole; handled by `approve`. */
class BillTaxMovedSignal extends Error {
  constructor(readonly invoiceNumber: string, readonly totalBefore: number, readonly totalAfter: number) {
    super('bill tax moved at approval');
  }
}

@Injectable()
export class AssayerInvoiceService {
  private readonly logger = new Logger(AssayerInvoiceService.name);

  constructor(
    @InjectRepository(AssayerInvoiceEntity)
    private readonly invoiceRepository: Repository<AssayerInvoiceEntity>,
    @InjectRepository(AssayerPayableEntity)
    private readonly payableRepository: Repository<AssayerPayableEntity>,
    private readonly engine: BillingEngineService,
    private readonly auditService: AuditService,
    private readonly regionGuard: RegionGuardService,
    private readonly uow: UnitOfWork,
    private readonly notificationDispatch: NotificationDispatchService,
    private readonly settings: PlatformSettingsService,
  ) {}

  private inTx<T>(
    work: (manager: EntityManager, emit: (event: string, payload: Record<string, unknown>) => void) => Promise<T>,
  ): Promise<T> {
    return this.uow.run(work);
  }

  /** Same mechanism as `payableNumber`/`entryNumber` generation in the engine. */
  private seq(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * The gate. `billing.assayerInvoicingEnabled` now ships default-TRUE: the invoicing round is
   * the payment flow, not a preview of one, and this comment used to say the opposite — it
   * described the dark rollout the flag was born for, long after the default had been flipped.
   *
   * The gate itself is unchanged and still earns its place: an estate whose field app predates
   * the invoicing round can switch it off. A read failure counts as OFF, because a feature gate
   * that fails open is not a gate. 404 rather than 403: where the feature is off, these routes
   * do not exist.
   */
  async assertEnabled(): Promise<void> {
    const enabled = await this.settings
      .get<boolean>('billing.assayerInvoicingEnabled')
      .then((v) => v === true)
      .catch(() => false);
    if (!enabled) {
      throw new NotFoundException('Assayer invoicing is not enabled on this deployment.');
    }
  }

  // -----------------------------------------------------------------------
  // Invite: attach the eligible payables to one new invoice
  // -----------------------------------------------------------------------

  /**
   * Invite one assayer to invoice ALL of their currently-eligible payables (fee AND expense
   * rows — see `ASSAYER_INVOICE_ELIGIBLE_SQL` for the predicate), as one invoice.
   *
   * One transaction: the eligible set is write-locked, so a payable cannot be voided, held or
   * double-invited between the read and the attach. Totals are SUMs of the locked rows' stored
   * amounts — `assignment-money` is never called; the invoice snapshots sums of
   * already-snapshotted lines.
   *
   * One ACTIVE invoice per assayer: the partial unique index
   * `UQ_assayer_invoices_one_active_per_assayer` is the real guard (two concurrent invites race
   * past any pre-check); the loser's violation is translated to a 409 naming the standing
   * invoice.
   */
  async invite(assayerId: string, actorId: string): Promise<AssayerInvoiceSummary> {
    let notify: { invoiceId: string; count: number } | null = null;
    let saved: AssayerInvoiceEntity;
    try {
      saved = await this.inTx(async (m, emit) => {
        const lines = await m
          .createQueryBuilder(AssayerPayableEntity, 'p')
          .setLock('pessimistic_write')
          .where(`p.assayer_id = :assayerId AND ${ASSAYER_INVOICE_ELIGIBLE_SQL('p')}`, { assayerId })
          .orderBy('p.id', 'ASC')
          .getMany();
        if (!lines.length) {
          /**
           * An empty eligible set has two very different causes, and the message must name the
           * right one: after an invite, every payable is ATTACHED to the standing invoice, so a
           * repeat invite found "nothing eligible" and told ops to go hunting for missing
           * payables — when the truthful answer was "an invitation already stands; approve or
           * cancel it". The unique index still backstops the concurrent race below; this check
           * only fixes what the sequential case is TOLD.
           */
          const standing = await m.findOne(AssayerInvoiceEntity, {
            where: { assayerId, status: In([AssayerInvoiceStatus.INVITED, AssayerInvoiceStatus.SUBMITTED]) },
          });
          if (standing) {
            throw new ConflictException(
              `An invitation already stands for this assayer — invoice ${standing.invoiceNumber} is ${standing.status}. Approve or cancel it before inviting again.`,
            );
          }
          throw new BadRequestException('Nothing eligible to invoice for this assayer.');
        }

        const invoice = this.invoiceRepository.create({
          invoiceNumber: `AINV-${Date.now().toString(36).toUpperCase()}-${this.seq()}`,
          assayerId,
          status: AssayerInvoiceStatus.INVITED,
          invitedAt: new Date(),
          invitedBy: actorId,
          lineCount: lines.length,
          subtotalBase: round2(lines.reduce((s, l) => s + Number(l.baseAmount), 0)),
          subtotalTravel: round2(lines.reduce((s, l) => s + Number(l.travelAmount), 0)),
          tdsAmount: round2(lines.reduce((s, l) => s + Number(l.tdsAmount), 0)),
          totalAmount: round2(lines.reduce((s, l) => s + Number(l.totalAmount), 0)),
          currency: 'INR',
          createdBy: actorId,
          updatedBy: actorId,
        });
        const inv = await m.save(invoice);

        await m.update(
          AssayerPayableEntity,
          lines.map((l) => l.id),
          { assayerInvoiceId: inv.id, updatedBy: actorId },
        );

        await this.engine.history(actorId, {
          assayerId,
          entityType: BillingEntityType.ASSAYER_INVOICE, entityId: inv.id, action: 'ASSAYER_INVOICE_INVITED',
          fromState: null, toState: AssayerInvoiceStatus.INVITED,
          newValue: {
            invoiceNumber: inv.invoiceNumber, lineCount: inv.lineCount,
            subtotalBase: Number(inv.subtotalBase), subtotalTravel: Number(inv.subtotalTravel),
            tdsAmount: Number(inv.tdsAmount), totalAmount: Number(inv.totalAmount),
            payableIds: lines.map((l) => l.id),
          },
        }, m);
        // `const manager = m` + shorthand `{ manager }`: the audit-write-scope guard checks this
        // exact spelling on the closing line — same alias the sibling service uses for it.
        const manager = m;
        await this.auditService.recordEvent({
          category: EventCategory.WORKFLOW,
          eventType: 'ASSAYER_INVOICE_INVITED',
          entityType: 'ASSAYER_INVOICE',
          entityId: inv.id,
          newState: AssayerInvoiceStatus.INVITED,
          userId: actorId,
          remarks: `Invited assayer ${assayerId} to submit invoice ${inv.invoiceNumber} (${inv.lineCount} line(s), ₹${Number(inv.totalAmount)})`,
          metadata: {
            invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, assayerId,
            lineCount: inv.lineCount, totalAmount: Number(inv.totalAmount),
          },
        }, { manager });
        emit('billing:assayer-invoice-changed', { invoiceId: inv.id, assayerId, status: inv.status });
        notify = { invoiceId: inv.id, count: inv.lineCount };
        return inv;
      });
    } catch (err) {
      if (isUniqueViolation(err, 'UQ_assayer_invoices_one_active_per_assayer')) {
        const standing = await this.invoiceRepository.findOne({
          where: { assayerId, status: In([AssayerInvoiceStatus.INVITED, AssayerInvoiceStatus.SUBMITTED]) },
        });
        throw new ConflictException(
          `This assayer already has an active invoice${standing ? ` (${standing.invoiceNumber}, ${standing.status.toLowerCase()})` : ''} — approve or cancel it first.`,
        );
      }
      throw err;
    }

    if (notify) {
      // Post-commit, fire-and-forget — a push failure must not undo an invite that committed.
      // NO amounts in the payload: the reveal happens in-app on the invitation itself, never in
      // a push body that sits on a lock screen.
      const n = notify as { invoiceId: string; count: number };
      this.notificationDispatch.emitSafe({
        type: 'ASSAYER_INVOICE_INVITED',
        entityType: 'ASSAYER_INVOICE',
        entityId: n.invoiceId,
        actorUserId: actorId,
        assayerId,
        dedupeKey: `ASSAYER_INVOICE_INVITED:${n.invoiceId}`,
        payload: { count: n.count },
      });
    }
    return this.toSummary(saved);
  }

  /**
   * The bulk cadence gesture: invite EVERY assayer with at least one eligible payable, one
   * invoice each. Mirrors the `resolveIssues` batch pattern — every assayer gets an outcome and
   * the request never fails as a whole, because one assayer already holding an active invoice
   * is not a reason to skip the other forty.
   *
   * `scope` narrows the round to the caller's regions (matched on the assayer's own home
   * region, the same column `assertAssayerInScope` reads): a region desk's "invite everyone"
   * must mean everyone THEY can see, not everyone nationwide.
   *
   * Runs in `BillingBulkJobsWorker`, not in the request: at ~1,200 assayers, each a transaction and
   * a notification, it ran far past the web client's 30 s (see `billing-bulk-jobs.contract.ts`).
   * The target set is still computed HERE, when the run starts, under the scope captured when it
   * was requested; `onProgress` is told after every assayer.
   */
  async inviteAll(actorId: string, scope?: Partial<GlobalScope>, onProgress?: ProgressCallback): Promise<{
    outcomes: AssayerInvoiceInviteOutcome[];
    invited: number;
    skipped: number;
  }> {
    const restrictedRegions = scope?.regions?.length ? scope.regions : null;
    const rows: Array<{ assayer_id: string }> = await this.payableRepository.manager.query(
      `SELECT p.assayer_id
         FROM assayer_payables p
         JOIN assayers s ON s.id = p.assayer_id
        WHERE ${ASSAYER_INVOICE_ELIGIBLE_SQL('p')}
          AND ($1::text[] IS NULL OR s.region = ANY($1::text[]))
        GROUP BY p.assayer_id
        ORDER BY p.assayer_id`,
      [restrictedRegions],
    );

    const outcomes: AssayerInvoiceInviteOutcome[] = [];
    // Sequential, like resolveIssues: one transaction per assayer, bounded by how many assayers
    // have unbilled work, and nothing to win from hammering the same tables in parallel.
    for (const [index, r] of rows.entries()) {
      const assayerId = r.assayer_id;
      try {
        const inv = await this.invite(assayerId, actorId);
        outcomes.push({ assayerId, outcome: 'invited', invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, lineCount: inv.lineCount });
      } catch (err) {
        if (err instanceof ConflictException) {
          outcomes.push({ assayerId, outcome: 'skipped-active-invoice' });
        } else if (err instanceof BadRequestException) {
          // The grouped query found eligible rows, but they were consumed (or held/voided)
          // between the read and this assayer's own locked re-read — the re-read is the truth.
          outcomes.push({ assayerId, outcome: 'nothing-eligible' });
        } else {
          // Defensive: an infrastructure error on one assayer must not abandon the rest of the
          // round, but it must not be dressed up as a business outcome either.
          this.logger.error(`Bulk invite failed for assayer ${assayerId}: ${(err as Error).message}`);
          outcomes.push({ assayerId, outcome: 'failed', error: (err as Error).message });
        }
      }
      await onProgress?.(index + 1, rows.length, 'Inviting assayers');
    }
    return {
      outcomes,
      invited: outcomes.filter((o) => o.outcome === 'invited').length,
      skipped: outcomes.length - outcomes.filter((o) => o.outcome === 'invited').length,
    };
  }

  // -----------------------------------------------------------------------
  // The reveal, and the assayer's confirmation
  // -----------------------------------------------------------------------

  /**
   * The active invitation (INVITED or SUBMITTED) with its lines fully labelled — assignment
   * number, branch, service date, expense category — and, for the first time anywhere in the
   * assayer's app, the money. Null when there is nothing to review.
   */
  async getInvitationFor(assayerId: string, scope?: Partial<GlobalScope>): Promise<AssayerInvoiceInvitation | null> {
    // The staged region ceiling, same pattern as the statement: matched on the assayer's own
    // home region; null (unresolved, or an unrestricted caller) passes.
    const regionRows = await this.payableRepository.manager
      .query(`SELECT region FROM assayers WHERE id = $1`, [assayerId])
      .catch(() => []);
    await this.regionGuard.assertRegionAllowedStaged(
      regionRows?.[0]?.region ?? null, scope, 'billing-engine:assayer-invoice-invitation',
    );

    const invoice = await this.invoiceRepository.findOne({
      where: { assayerId, status: In([AssayerInvoiceStatus.INVITED, AssayerInvoiceStatus.SUBMITTED]) },
      order: { createdAt: 'DESC' },
    });
    if (!invoice) return null;
    const labels = await this.assayerLabels([invoice.assayerId]);
    return {
      ...this.toSummary(invoice),
      assayerName: labels.get(invoice.assayerId)?.name ?? null,
      assayerCode: labels.get(invoice.assayerId)?.code ?? null,
      lines: await this.linesOf(invoice.id),
    };
  }

  /**
   * The assayer's confirmation: INVITED → SUBMITTED, under FOR UPDATE.
   *
   * Idempotent by `clientRequestId`, mirroring `lastCounterRequestId`'s semantics on the
   * assignment: mobile retries this POST on a flaky connection with the same body, and the
   * retry must return the submission it already made — one consent, recorded once. A DIFFERENT
   * request id against an already-SUBMITTED invoice is a real conflict (a second device, or a
   * stale screen) and is refused, because silently swallowing it would hide that two
   * submissions were attempted.
   */
  async submit(
    assayerId: string,
    clientRequestId: string,
    /**
     * Set when billing staff record the confirmation FOR the assayer (the desk-side road, e.g. an
     * assayer who confirmed on the phone) — audit F5, 2026-09-24. The trail then names the staff
     * member who did it and why; it used to record the assayer's own id as the actor, so a desk
     * submission read, forever after, as the assayer's own consent.
     */
    onBehalf?: { staffId: string; reason: string },
  ): Promise<AssayerInvoiceSummary> {
    const actorId = onBehalf?.staffId ?? assayerId;
    const onBehalfReason = onBehalf?.reason?.trim() ?? null;
    if (onBehalf && (!onBehalfReason || onBehalfReason.length < SUBMIT_ON_BEHALF_REASON_MIN)) {
      throw new BadRequestException(
        `Say why you are confirming this bill for the assayer (at least ${SUBMIT_ON_BEHALF_REASON_MIN} characters) — the reason is written to the bill's history.`,
      );
    }
    let notify: { invoiceId: string; invoiceNumber: string; count: number; total: number } | null = null;
    const saved = await this.inTx(async (m, emit) => {
      const inv = await m.findOne(AssayerInvoiceEntity, {
        where: { assayerId, status: In([AssayerInvoiceStatus.INVITED, AssayerInvoiceStatus.SUBMITTED]) },
        lock: { mode: 'pessimistic_write' },
      });
      if (!inv) throw new NotFoundException('You have no invoice invitation right now.');

      if (inv.status === AssayerInvoiceStatus.SUBMITTED) {
        if (inv.submittedRequestId === clientRequestId) return inv; // the retry — no-op
        throw new ConflictException(
          `${inv.invoiceNumber} has already been submitted. Pull to refresh to see its current state.`,
        );
      }

      inv.status = AssayerInvoiceStatus.SUBMITTED;
      inv.submittedAt = new Date();
      inv.submittedRequestId = clientRequestId;
      inv.confirmedVersion = inv.revision ?? 1;
      inv.updatedBy = actorId;
      const out = await m.save(inv);

      await this.engine.history(actorId, {
        assayerId,
        entityType: BillingEntityType.ASSAYER_INVOICE, entityId: out.id, action: 'ASSAYER_INVOICE_SUBMITTED',
        fromState: AssayerInvoiceStatus.INVITED, toState: AssayerInvoiceStatus.SUBMITTED,
        newValue: {
          submittedRequestId: clientRequestId, lineCount: out.lineCount, totalAmount: Number(out.totalAmount),
          submittedBy: onBehalf ? 'STAFF_ON_BEHALF' : 'ASSAYER',
          ...(onBehalf ? { onBehalfOfAssayerId: assayerId, staffId: onBehalf.staffId } : {}),
        },
        reason: onBehalf ? `Confirmed for the assayer by staff: ${onBehalfReason}` : null,
      }, m);
      // `const manager = m` + shorthand `{ manager }`: the audit-write-scope guard checks this
      // exact spelling on the closing line — same alias the sibling service uses for it.
      const manager = m;
      await this.auditService.recordEvent({
        category: EventCategory.WORKFLOW,
        eventType: 'ASSAYER_INVOICE_SUBMITTED',
        entityType: 'ASSAYER_INVOICE',
        entityId: out.id,
        previousState: AssayerInvoiceStatus.INVITED,
        newState: AssayerInvoiceStatus.SUBMITTED,
        userId: actorId,
        remarks: onBehalf
          ? `Staff confirmed invoice ${out.invoiceNumber} for assayer ${assayerId} (${out.lineCount} line(s), ₹${Number(out.totalAmount)}): ${onBehalfReason}`
          : `Assayer submitted invoice ${out.invoiceNumber} (${out.lineCount} line(s), ₹${Number(out.totalAmount)})`,
        metadata: {
          invoiceId: out.id, invoiceNumber: out.invoiceNumber, assayerId, lineCount: out.lineCount, totalAmount: Number(out.totalAmount),
          submittedBy: onBehalf ? 'STAFF_ON_BEHALF' : 'ASSAYER',
        },
      }, { manager });
      emit('billing:assayer-invoice-changed', { invoiceId: out.id, assayerId, status: out.status });
      notify = { invoiceId: out.id, invoiceNumber: out.invoiceNumber, count: out.lineCount, total: Number(out.totalAmount) };
      return out;
    });

    if (notify) {
      // Ops-facing, so the ₹ total is fine here — it is the desk's queue item, not a lock-screen
      // reveal. Name resolved post-commit and best-effort: a label lookup must not fail a consent.
      const n = notify as { invoiceId: string; invoiceNumber: string; count: number; total: number };
      void this.payableRepository.manager
        .query(`SELECT display_name FROM assayers WHERE id = $1`, [assayerId])
        .catch(() => [])
        .then((rows: any[]) => {
          this.notificationDispatch.emitSafe({
            type: 'ASSAYER_INVOICE_SUBMITTED',
            entityType: 'ASSAYER_INVOICE',
            entityId: n.invoiceId,
            actorUserId: actorId,
            dedupeKey: `ASSAYER_INVOICE_SUBMITTED:${n.invoiceId}:${clientRequestId}`,
            payload: {
              assayerName: rows?.[0]?.display_name ?? 'An assayer',
              invoiceNumber: n.invoiceNumber,
              count: n.count,
              total: n.total,
            },
          });
        });
    }
    return this.toSummary(saved);
  }

  // -----------------------------------------------------------------------
  // Ops: approve / cancel
  // -----------------------------------------------------------------------

  /**
   * Ops accepts the submission: SUBMITTED → APPROVED, and every still-PENDING line payable →
   * APPROVED, all in ONE transaction — invoice approval IS payable approval for its lines.
   *
   * Before anything moves, the stored totals are RE-VERIFIED against a fresh SUM over the
   * locked lines. They cannot drift through this module (re-price recomputes INVITED invoices
   * and is frozen on SUBMITTED ones), so a mismatch means something touched the rows outside
   * the rules — which is precisely when money must stop and a human must look: 409, never a
   * silent re-total, because the assayer consented to the figures as shown.
   */
  async approve(invoiceId: string, actorId: string): Promise<AssayerInvoiceSummary> {
    let notify: { invoiceNumber: string; count: number; assayerId: string; total: number; at: number } | null = null;
    /** What the approver must know that did not refuse the approval (audit F3) — returned with the bill. */
    const warnings: string[] = [];
    let saved: AssayerInvoiceEntity;
    try {
      saved = await this.approveInTx(invoiceId, actorId, warnings, (n) => { notify = n; });
    } catch (err) {
      if (!(err instanceof BillTaxMovedSignal)) throw err;
      await this.sendBackForTaxChange(invoiceId, actorId, err);
      throw withCode(
        new ConflictException(`${BILL_TAX_RECALCULATED_MESSAGE} (${err.invoiceNumber}: ₹${err.totalBefore} confirmed, ₹${err.totalAfter} after tax).`),
        'BILL_TAX_RECALCULATED',
      );
    }
    return this.afterApprove(saved, actorId, notify, warnings);
  }

  /**
   * The bill goes back to its assayer because approval re-decided its lines' tax (see
   * `BILL_TAX_RECALCULATED_MESSAGE`). In ONE transaction: each Due line takes its new TDS (with the
   * line's own PAYABLE_TDS_RECOMPUTED history), then the bill is revised exactly as `reviseInvoice`
   * revises it — superseded, a new revision INVITED at the new figures — and the assayer is asked to
   * confirm it. Nothing is approved.
   */
  private async sendBackForTaxChange(invoiceId: string, actorId: string, moved: BillTaxMovedSignal): Promise<void> {
    const reason = `${BILL_TAX_RECALCULATED_MESSAGE}: net ₹${moved.totalBefore} → ₹${moved.totalAfter}`;
    const revision = await this.inTx(async (m, emit) => {
      // The bill before its lines — the order `approve` takes them in.
      await m.findOne(AssayerInvoiceEntity, { where: { id: invoiceId }, lock: { mode: 'pessimistic_write' } });
      const lines = await m
        .createQueryBuilder(AssayerPayableEntity, 'p')
        .setLock('pessimistic_write')
        .where('p.assayer_invoice_id = :invoiceId AND p.is_active = true', { invoiceId })
        .orderBy('p.id', 'ASC')
        .getMany();
      const current: AssayerPayableEntity[] = [];
      for (const line of lines) {
        current.push(line.status === AssayerPayableStatus.PENDING
          ? (await this.engine.reTaxDueLineForRevisionInTx(m, line.id, actorId)).payable
          : line);
      }
      return this.reviseInTx(m, emit, invoiceId, actorId, reason, current);
    });
    this.notifyRevision(revision.notify, actorId, 'TAX_RECALCULATED');
  }

  private async approveInTx(
    invoiceId: string,
    actorId: string,
    warnings: string[],
    setNotify: (n: { invoiceNumber: string; count: number; assayerId: string; total: number; at: number }) => void,
  ): Promise<AssayerInvoiceEntity> {
    return this.inTx(async (m, emit) => {
      const inv = await m.findOne(AssayerInvoiceEntity, { where: { id: invoiceId }, lock: { mode: 'pessimistic_write' } });
      if (!inv) throw new NotFoundException(`Assayer invoice ${invoiceId} not found.`);
      if (isApprovedBill(inv.status)) return inv; // the double-press — no-op
      if (inv.status === AssayerInvoiceStatus.PAID) {
        throw new ConflictException(`${inv.invoiceNumber} is already paid.`);
      }
      if (inv.status === AssayerInvoiceStatus.SUPERSEDED) {
        throw new ConflictException(`${inv.invoiceNumber} has been superseded by a newer revision.`);
      }
      if (inv.status === AssayerInvoiceStatus.CANCELLED) {
        throw new ConflictException(`${inv.invoiceNumber} is cancelled.`);
      }
      if (inv.status !== AssayerInvoiceStatus.SUBMITTED) {
        throw new BadRequestException(
          `${inv.invoiceNumber} has not been submitted by the assayer yet — approval accepts THEIR confirmation, it cannot precede it.`,
        );
      }
      if (inv.confirmedVersion !== inv.revision) {
        throw new ConflictException(
          `${inv.invoiceNumber} revision ${inv.revision} has not been confirmed by the assayer (last confirmed: ${inv.confirmedVersion ?? 'none'}).`,
        );
      }

      const lines = await m
        .createQueryBuilder(AssayerPayableEntity, 'p')
        .setLock('pessimistic_write')
        .where('p.assayer_invoice_id = :invoiceId', { invoiceId: inv.id })
        .orderBy('p.id', 'ASC')
        .getMany();

      const held = lines.filter((l) => l.onHold);
      if (held.length) {
        throw new ConflictException(
          `${held.map((l) => l.payableNumber).join(', ')} on hold — release the hold or cancel ${inv.invoiceNumber} first.`,
        );
      }

      // The drift re-check. Same SUMs as invite, over what is attached NOW.
      const sums = {
        lineCount: lines.length,
        subtotalBase: round2(lines.reduce((s, l) => s + Number(l.baseAmount), 0)),
        subtotalTravel: round2(lines.reduce((s, l) => s + Number(l.travelAmount), 0)),
        tdsAmount: round2(lines.reduce((s, l) => s + Number(l.tdsAmount), 0)),
        totalAmount: round2(lines.reduce((s, l) => s + Number(l.totalAmount), 0)),
      };
      const drifted =
        sums.lineCount !== Number(inv.lineCount) ||
        Math.abs(sums.subtotalBase - Number(inv.subtotalBase)) > MONEY_EPSILON ||
        Math.abs(sums.subtotalTravel - Number(inv.subtotalTravel)) > MONEY_EPSILON ||
        Math.abs(sums.tdsAmount - Number(inv.tdsAmount)) > MONEY_EPSILON ||
        Math.abs(sums.totalAmount - Number(inv.totalAmount)) > MONEY_EPSILON;
      if (drifted) {
        throw new ConflictException(
          `${inv.invoiceNumber} no longer matches its lines (stored ₹${Number(inv.totalAmount)} vs ₹${sums.totalAmount} across ${sums.lineCount} line(s)). ` +
            `Cancel it and re-invite so the assayer confirms the real figures.`,
        );
      }

      // Approve every line that still needs it, through the SAME gate approvePayouts uses —
      // segregation-of-duties, history, audit and the payout-changed event all included; only
      // the per-payable push is suppressed in favour of one invoice-level notification.
      // `bypassInvoiceGuard`: THIS invoice is the active one those lines ride.
      const tdsDelta = { tds: 0, total: 0 };
      for (const line of lines) {
        if (line.status === AssayerPayableStatus.PENDING) {
          await this.engine.approvePayableInTx(m, emit, line.id, actorId, {
            suppressNotification: true,
            bypassInvoiceGuard: true,
            onWarning: (w) => { if (!warnings.includes(w)) warnings.push(w); },
            onTdsChange: (d) => { tdsDelta.tds += d.tds; tdsDelta.total += d.total; },
          });
        }
      }

      /**
       * Approval can re-decide a line's TDS (audit F4/F15: the PAN is on file now, or the year's
       * s.194J threshold position moved), which moves what the assayer is paid. The assayer
       * CONFIRMED the bill's figure, so a different net total is never approved over their head.
       */
      if (Math.abs(tdsDelta.total) > MONEY_EPSILON / 2) {
        // NOT approved silently at a figure the assayer never saw: the whole approval rolls back,
        // and the bill goes back to them as a revision at the new figure (handled below).
        const totalBefore = Number(inv.totalAmount);
        throw new BillTaxMovedSignal(inv.invoiceNumber, totalBefore, round2(totalBefore + tdsDelta.total));
      }

      inv.status = AssayerInvoiceStatus.APPROVED;
      inv.approvedAt = new Date();
      inv.approvedBy = actorId;
      // The office's approval is the first of two (2026-09-24); the HOD's is always given after it.
      inv.hodApprovedAt = null;
      inv.hodApprovedBy = null;
      inv.updatedBy = actorId;
      const out = await m.save(inv);

      await this.engine.history(actorId, {
        assayerId: out.assayerId,
        entityType: BillingEntityType.ASSAYER_INVOICE, entityId: out.id, action: 'ASSAYER_INVOICE_APPROVED',
        fromState: AssayerInvoiceStatus.SUBMITTED, toState: AssayerInvoiceStatus.APPROVED,
        newValue: { lineCount: out.lineCount, totalAmount: Number(out.totalAmount) },
      }, m);
      // `const manager = m` + shorthand `{ manager }`: the audit-write-scope guard checks this
      // exact spelling on the closing line — same alias the sibling service uses for it.
      const manager = m;
      await this.auditService.recordEvent({
        category: EventCategory.WORKFLOW,
        eventType: 'ASSAYER_INVOICE_APPROVED',
        entityType: 'ASSAYER_INVOICE',
        entityId: out.id,
        previousState: AssayerInvoiceStatus.SUBMITTED,
        newState: AssayerInvoiceStatus.APPROVED,
        userId: actorId,
        remarks: `Approved assayer invoice ${out.invoiceNumber} (${out.lineCount} line(s), ₹${Number(out.totalAmount)}) — lines approved with it`,
        metadata: { invoiceId: out.id, invoiceNumber: out.invoiceNumber, assayerId: out.assayerId, lineCount: out.lineCount, totalAmount: Number(out.totalAmount) },
      }, { manager });
      emit('billing:assayer-invoice-changed', { invoiceId: out.id, assayerId: out.assayerId, status: out.status });
      // Every line already paid (paid directly before this bill reached approval): settled now, not
      // left "approved" with nothing to pay (audit F10).
      await this.engine.settleAssayerInvoiceIfPaidInTx(m, emit, out.id, actorId);
      const settled = await m.findOne(AssayerInvoiceEntity, { where: { id: out.id } });
      if (settled?.status === AssayerInvoiceStatus.PAID) return settled;
      setNotify({
        invoiceNumber: out.invoiceNumber, count: out.lineCount, assayerId: out.assayerId,
        total: Number(out.totalAmount), at: out.approvedAt ? new Date(out.approvedAt).getTime() : Date.now(),
      });
      return out;
    });
  }

  private afterApprove(
    saved: AssayerInvoiceEntity,
    actorId: string,
    notify: { invoiceNumber: string; count: number; assayerId: string; total: number; at: number } | null,
    warnings: string[],
  ): AssayerInvoiceSummary {
    if (notify) {
      /*
        The office's approval now waits for the HOD (2026-09-24), so it is the HOD who hears about
        it. The assayer's "approved" (ASSAYER_INVOICE_APPROVED) moved to `hodApprove`: it is sent
        when the bill is actually cleared for payment, never as a promise the HOD could still undo.
      */
      const n = notify as { invoiceNumber: string; count: number; total: number; at: number };
      this.engine.notifyFinalApprovalNeeded({
        entityType: 'ASSAYER_INVOICE',
        entityId: saved.id,
        actorUserId: actorId,
        what: `Assayer bill ${n.invoiceNumber} (${n.count} line${n.count === 1 ? '' : 's'})`,
        amount: n.total,
        version: n.at,
      });
    }
    return warnings.length ? { ...this.toSummary(saved), warnings } : this.toSummary(saved);
  }

  // -----------------------------------------------------------------------
  // The HOD's final approval of a bill (owner, 2026-09-24)
  // -----------------------------------------------------------------------

  /**
   * The HOD approves an office-approved bill: APPROVED → HOD_APPROVED, and every approved,
   * still-owed line gets the final approval in the SAME transaction — through the engine's
   * `hodApprovePayableInTx`, so the checks, history, audit and events are the payout path's own.
   * Only after this can any of the bill's payouts be paid.
   *
   * The HOD may not be the office approver of the bill (nor of any line on it): checked by
   * `assertSegregationOfDuties` under `security.segregationOfDuties.mode`, refused and audited.
   */
  async hodApprove(invoiceId: string, actorId: string): Promise<AssayerInvoiceSummary> {
    let notify: { invoiceNumber: string; count: number; assayerId: string } | null = null;
    const saved = await this.inTx(async (m, emit) => {
      const inv = await m.findOne(AssayerInvoiceEntity, { where: { id: invoiceId }, lock: { mode: 'pessimistic_write' } });
      if (!inv) throw new NotFoundException(`Assayer invoice ${invoiceId} not found.`);
      if (inv.status === AssayerInvoiceStatus.HOD_APPROVED) return inv; // the double-press
      if (inv.status !== AssayerInvoiceStatus.APPROVED) {
        throw new ConflictException(
          inv.status === AssayerInvoiceStatus.SUBMITTED
            ? `${inv.invoiceNumber} has not been approved by the office yet.`
            : `${inv.invoiceNumber} is ${inv.status.toLowerCase()} — there is nothing for the HOD to approve.`,
        );
      }
      await this.engine.assertSegregationOfDuties(
        actorId,
        inv.approvedBy,
        `approve assayer bill ${inv.invoiceNumber} at the office and also give it the final approval`,
        { entityType: 'ASSAYER_INVOICE', entityId: inv.id, payableNumber: inv.invoiceNumber },
      );

      const lines = await m
        .createQueryBuilder(AssayerPayableEntity, 'p')
        .setLock('pessimistic_write')
        .where('p.assayer_invoice_id = :invoiceId AND p.is_active = true', { invoiceId: inv.id })
        .orderBy('p.id', 'ASC')
        .getMany();
      const held = lines.filter((l) => l.onHold && l.status === AssayerPayableStatus.APPROVED);
      if (held.length) {
        throw new ConflictException(
          `${held.map((l) => l.payableNumber).join(', ')} on hold — release the hold, or void the line, before the bill's final approval.`,
        );
      }
      let approvedLines = 0;
      for (const line of lines) {
        if (line.status === AssayerPayableStatus.APPROVED && !line.hodApprovedAt) {
          await this.engine.hodApprovePayableInTx(m, emit, line.id, actorId, { viaBill: true });
          approvedLines++;
        }
      }

      inv.status = AssayerInvoiceStatus.HOD_APPROVED;
      inv.hodApprovedAt = new Date();
      inv.hodApprovedBy = actorId;
      inv.updatedBy = actorId;
      const out = await m.save(inv);
      await this.engine.history(actorId, {
        assayerId: out.assayerId,
        entityType: BillingEntityType.ASSAYER_INVOICE, entityId: out.id, action: 'ASSAYER_INVOICE_HOD_APPROVED',
        fromState: AssayerInvoiceStatus.APPROVED, toState: AssayerInvoiceStatus.HOD_APPROVED,
        newValue: { lineCount: out.lineCount, linesApproved: approvedLines, totalAmount: Number(out.totalAmount), officeApprovedBy: out.approvedBy },
      }, m);
      const manager = m;
      await this.auditService.recordEvent({
        category: EventCategory.WORKFLOW,
        eventType: 'ASSAYER_INVOICE_HOD_APPROVED',
        entityType: 'ASSAYER_INVOICE',
        entityId: out.id,
        previousState: AssayerInvoiceStatus.APPROVED,
        newState: AssayerInvoiceStatus.HOD_APPROVED,
        userId: actorId,
        remarks: `Final approval (HOD) of assayer bill ${out.invoiceNumber} (${out.lineCount} line(s), ₹${Number(out.totalAmount)}) — cleared for payment`,
        metadata: { invoiceId: out.id, invoiceNumber: out.invoiceNumber, assayerId: out.assayerId, officeApprovedBy: out.approvedBy, totalAmount: Number(out.totalAmount) },
      }, { manager });
      emit('billing:assayer-invoice-changed', { invoiceId: out.id, assayerId: out.assayerId, status: out.status });
      notify = { invoiceNumber: out.invoiceNumber, count: out.lineCount, assayerId: out.assayerId };
      // A bill whose lines were all paid before its final approval is settled by it (audit F10).
      await this.engine.settleAssayerInvoiceIfPaidInTx(m, emit, out.id, actorId);
      const settled = await m.findOne(AssayerInvoiceEntity, { where: { id: out.id } });
      return settled?.status === AssayerInvoiceStatus.PAID ? settled : out;
    });

    if (notify) {
      // Count-only body (the catalog keeps ₹ out of assayer pushes); amounts are on the statement.
      const n = notify as { invoiceNumber: string; count: number; assayerId: string };
      this.notificationDispatch.emitSafe({
        type: 'ASSAYER_INVOICE_APPROVED',
        entityType: 'ASSAYER_INVOICE',
        entityId: saved.id,
        actorUserId: actorId,
        assayerId: n.assayerId,
        dedupeKey: `ASSAYER_INVOICE_APPROVED:${saved.id}`,
        payload: { count: n.count, invoiceNumber: n.invoiceNumber },
      });
    }
    return this.toSummary(saved);
  }

  /**
   * The HOD sends a bill back to the office, with the reason: APPROVED → SUBMITTED.
   *
   * Back to exactly where the office found it. The assayer's confirmation still stands — they
   * confirmed THESE figures, and nothing about them changed (`confirmedVersion` is untouched; a
   * correction is still a revision, which asks them again). The office's approval is undone on the
   * bill and on every line it approved: the lines return to PENDING with their approver and the
   * bank destination frozen at that approval cleared, exactly the fields approval set. The office
   * then approves again, revises, or cancels.
   *
   * Refused when any line has money against it (a bill part-paid before the HOD step existed) — a
   * line that paid cannot be un-approved. Refused, too, when the assayer already has another bill
   * out (the one-open-bill-per-assayer rule): that one has to be dealt with first.
   */
  async hodReject(invoiceId: string, actorId: string, reason: string): Promise<AssayerInvoiceSummary> {
    const problem = hodRejectReasonProblem(reason);
    if (problem) throw new BadRequestException(problem);
    const why = reason.trim();
    let officeApprover: string | null = null;
    let saved: AssayerInvoiceEntity;
    try {
      saved = await this.inTx(async (m, emit) => {
        const inv = await m.findOne(AssayerInvoiceEntity, { where: { id: invoiceId }, lock: { mode: 'pessimistic_write' } });
        if (!inv) throw new NotFoundException(`Assayer invoice ${invoiceId} not found.`);
        if (inv.status !== AssayerInvoiceStatus.APPROVED) {
          throw new ConflictException(
            inv.status === AssayerInvoiceStatus.HOD_APPROVED
              ? `${inv.invoiceNumber} already has the final approval. To stop a payout on it, put it on hold or void it.`
              : `${inv.invoiceNumber} is ${inv.status.toLowerCase()} — there is nothing for the HOD to send back.`,
          );
        }
        const lines = await m
          .createQueryBuilder(AssayerPayableEntity, 'p')
          .setLock('pessimistic_write')
          .where('p.assayer_invoice_id = :invoiceId AND p.is_active = true', { invoiceId: inv.id })
          .orderBy('p.id', 'ASC')
          .getMany();
        const moneyMoved = lines.filter((l) => l.status === AssayerPayableStatus.PAID || Number(l.paidAmount) > 0);
        if (moneyMoved.length) {
          throw new ConflictException(
            `${moneyMoved.map((l) => l.payableNumber).join(', ')} already paid on ${inv.invoiceNumber} — the bill cannot go back to the office. Hold or void the unpaid lines instead.`,
          );
        }

        officeApprover = inv.approvedBy;
        for (const l of lines) {
          if (l.status !== AssayerPayableStatus.APPROVED) continue;
          const before = { approvedAt: l.approvedAt, approvedBy: l.approvedBy, hodApprovedAt: l.hodApprovedAt };
          l.status = AssayerPayableStatus.PENDING;
          l.approvedAt = null;
          l.approvedBy = null;
          l.hodApprovedAt = null;
          l.hodApprovedBy = null;
          l.destinationBankAccountNumber = null;
          l.destinationIfsc = null;
          l.destinationBankName = null;
          l.destinationAccountHolderName = null;
          l.payoutEvidenceVersionId = null;
          l.destinationVerifiedAt = null;
          l.destinationVerifiedSource = null;
          l.hodRejectedAt = new Date();
          l.hodRejectedBy = actorId;
          l.hodRejectReason = why;
          l.updatedBy = actorId;
          await m.save(l);
          await this.engine.history(actorId, {
            clientId: l.clientId, projectId: l.projectId, assignmentId: l.assignmentId, assayerId: l.assayerId,
            entityType: BillingEntityType.PAYABLE, entityId: l.id, action: 'PAYABLE_HOD_REJECTED',
            fromState: AssayerPayableStatus.APPROVED, toState: AssayerPayableStatus.PENDING,
            previousValue: before, reason: `With bill ${inv.invoiceNumber}: ${why}`,
          }, m);
          emit('billing:payout-changed', { payableId: l.id, assayerId: l.assayerId, status: l.status, onHold: l.onHold });
        }

        inv.status = AssayerInvoiceStatus.SUBMITTED;
        inv.approvedAt = null;
        inv.approvedBy = null;
        inv.hodRejectedAt = new Date();
        inv.hodRejectedBy = actorId;
        inv.hodRejectReason = why;
        inv.updatedBy = actorId;
        const out = await m.save(inv);
        await this.engine.history(actorId, {
          assayerId: out.assayerId,
          entityType: BillingEntityType.ASSAYER_INVOICE, entityId: out.id, action: 'ASSAYER_INVOICE_HOD_REJECTED',
          fromState: AssayerInvoiceStatus.APPROVED, toState: AssayerInvoiceStatus.SUBMITTED,
          newValue: { lineCount: out.lineCount, totalAmount: Number(out.totalAmount), officeApprovedBy: officeApprover },
          reason: why,
        }, m);
        const manager = m;
        await this.auditService.recordEvent({
          category: EventCategory.WORKFLOW,
          eventType: 'ASSAYER_INVOICE_HOD_REJECTED',
          entityType: 'ASSAYER_INVOICE',
          entityId: out.id,
          previousState: AssayerInvoiceStatus.APPROVED,
          newState: AssayerInvoiceStatus.SUBMITTED,
          userId: actorId,
          remarks: `Final approval refused; assayer bill ${out.invoiceNumber} sent back to the office: ${why}`,
          metadata: { invoiceId: out.id, invoiceNumber: out.invoiceNumber, assayerId: out.assayerId, officeApprovedBy: officeApprover, reason: why },
        }, { manager });
        emit('billing:assayer-invoice-changed', { invoiceId: out.id, assayerId: out.assayerId, status: out.status });
        return out;
      });
    } catch (err) {
      if (isUniqueViolation(err, 'UQ_assayer_invoices_one_active_per_assayer')) {
        throw new ConflictException(
          'This assayer already has another bill out or confirmed. Deal with that bill first (approve or cancel it), then send this one back.',
        );
      }
      throw err;
    }
    this.engine.notifyFinalApprovalRejected({
      ownerUserId: officeApprover,
      actorUserId: actorId,
      entityType: 'ASSAYER_INVOICE',
      entityId: saved.id,
      what: `Assayer bill ${saved.invoiceNumber}`,
      reason: why,
      tab: 'bills',
      version: saved.hodRejectedAt ? new Date(saved.hodRejectedAt).getTime() : Date.now(),
    });
    return this.toSummary(saved);
  }

  /**
   * Cancel an INVITED or SUBMITTED invoice, releasing its lines back to the eligible pool.
   *
   * This is also the "reject" path — there is deliberately no REJECTED state: ops cancels with
   * a reason, fixes the underlying payables (void, hold, re-price), and re-invites, so a
   * dispute is always resolved through the same single loop. APPROVED refuses: its lines are
   * approved payables now, and unwinding those is `voidPayable`'s job, line by line, with its
   * own trail.
   */
  async cancel(invoiceId: string, actorId: string, reason: string): Promise<AssayerInvoiceSummary> {
    if (!reason?.trim()) throw new BadRequestException('Say why this invoice is being cancelled.');
    const saved = await this.inTx(async (m, emit) => {
      const inv = await m.findOne(AssayerInvoiceEntity, { where: { id: invoiceId }, lock: { mode: 'pessimistic_write' } });
      if (!inv) throw new NotFoundException(`Assayer invoice ${invoiceId} not found.`);
      if (inv.status === AssayerInvoiceStatus.CANCELLED) return inv;
      if (isApprovedBill(inv.status)) {
        throw new ConflictException(
          `${inv.invoiceNumber} is approved — its lines are approved payouts now. Void the payouts individually instead.`,
        );
      }
      if (inv.status === AssayerInvoiceStatus.PAID) {
        throw new ConflictException(
          `${inv.invoiceNumber} is already paid — its disbursements are settled in bank transfers. It cannot be cancelled.`,
        );
      }
      if (inv.status === AssayerInvoiceStatus.SUPERSEDED) {
        throw new ConflictException(
          `${inv.invoiceNumber} has been superseded by a corrected revision. Cancel or approve the active revision instead.`,
        );
      }

      const fromStatus = inv.status;
      // Release the lines first, on the same transaction: a cancelled invoice holding lines
      // would silently keep that work un-invitable forever.
      await m.update(AssayerPayableEntity, { assayerInvoiceId: inv.id }, { assayerInvoiceId: null, updatedBy: actorId });

      inv.status = AssayerInvoiceStatus.CANCELLED;
      inv.cancelledAt = new Date();
      inv.cancelledBy = actorId;
      inv.cancelReason = reason.trim();
      inv.updatedBy = actorId;
      const out = await m.save(inv);

      await this.engine.history(actorId, {
        assayerId: out.assayerId,
        entityType: BillingEntityType.ASSAYER_INVOICE, entityId: out.id, action: 'ASSAYER_INVOICE_CANCELLED',
        fromState: fromStatus, toState: AssayerInvoiceStatus.CANCELLED,
        newValue: { lineCount: out.lineCount, totalAmount: Number(out.totalAmount) },
        reason: reason.trim(),
      }, m);
      // `const manager = m` + shorthand `{ manager }`: the audit-write-scope guard checks this
      // exact spelling on the closing line — same alias the sibling service uses for it.
      const manager = m;
      await this.auditService.recordEvent({
        category: EventCategory.WORKFLOW,
        eventType: 'ASSAYER_INVOICE_CANCELLED',
        entityType: 'ASSAYER_INVOICE',
        entityId: out.id,
        previousState: fromStatus,
        newState: AssayerInvoiceStatus.CANCELLED,
        userId: actorId,
        remarks: reason.trim(),
        metadata: { invoiceId: out.id, invoiceNumber: out.invoiceNumber, assayerId: out.assayerId, reason: reason.trim() },
      }, { manager });
      emit('billing:assayer-invoice-changed', { invoiceId: out.id, assayerId: out.assayerId, status: out.status });
      return out;
    });
    return this.toSummary(saved);
  }

  /**
   * Controlled Revision & Supersession (Scenario F):
   * If a confirmed or submitted claim requires correction (e.g. line dispute or fee correction),
   * the current invoice is marked SUPERSEDED, and a new revision (Rev N+1) is generated.
   *
   * The revised claim requires fresh assayer review & confirmation (INVITED -> SUBMITTED)
   * before Ops can approve it for disbursement.
   */
  async reviseInvoice(invoiceId: string, actorId: string, reason: string): Promise<AssayerInvoiceSummary> {
    if (!reason?.trim()) throw new BadRequestException('Reason is required when revising a claim.');
    const out = await this.inTx((m, emit) => this.reviseInTx(m, emit, invoiceId, actorId, reason));
    this.notifyRevision(out.notify, actorId);
    return this.toSummary(out.saved);
  }

  /**
   * The revision itself, on the caller's transaction — shared by `reviseInvoice` (a person asked
   * for it) and `approve` (the tax moved at approval, so the assayer must confirm the new figure).
   */
  private async reviseInTx(
    m: EntityManager,
    emit: (event: string, payload: Record<string, unknown>) => void,
    invoiceId: string,
    actorId: string,
    reason: string,
    /** The bill's lines, already locked (and re-taxed) by the caller on this transaction. */
    lockedLines?: AssayerPayableEntity[],
  ): Promise<{ saved: AssayerInvoiceEntity; notify: RevisionNotice }> {
    const inv = await m.findOne(AssayerInvoiceEntity, {
      where: { id: invoiceId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!inv) throw new NotFoundException(`Assayer invoice ${invoiceId} not found.`);
    if (isApprovedBill(inv.status) || inv.status === AssayerInvoiceStatus.PAID) {
      throw new ConflictException(`${inv.invoiceNumber} is already ${inv.status === AssayerInvoiceStatus.PAID ? 'paid' : 'approved'} and cannot be revised.`);
    }
    if (inv.status === AssayerInvoiceStatus.SUPERSEDED) {
      throw new ConflictException(`${inv.invoiceNumber} is already superseded.`);
    }
    if (inv.status === AssayerInvoiceStatus.CANCELLED) {
      throw new ConflictException(`${inv.invoiceNumber} is cancelled.`);
    }

    const lines = lockedLines ?? await m
      .createQueryBuilder(AssayerPayableEntity, 'p')
      .setLock('pessimistic_write')
      .where('p.assayer_invoice_id = :invoiceId AND p.is_active = true', { invoiceId: inv.id })
      .orderBy('p.id', 'ASC')
      .getMany();

    const eligibleLines = lines.filter((l) => !l.onHold && l.status === AssayerPayableStatus.PENDING);
    if (!eligibleLines.length) {
      throw new BadRequestException('No eligible unheld lines remain to create a revised claim.');
    }

    const prevStatus = inv.status;
    const baseNumber = inv.invoiceNumber.split('-R')[0];
    const nextRevision = (inv.revision || 1) + 1;
    const revisedInvoiceNumber = `${baseNumber}-R${nextRevision}`;

    // Transition old invoice to SUPERSEDED first (clears active partial unique index slot)
    inv.status = AssayerInvoiceStatus.SUPERSEDED;
    inv.updatedBy = actorId;
    await m.save(inv);

    // Create new revised invoice
    const revisedInvoice = this.invoiceRepository.create({
      invoiceNumber: revisedInvoiceNumber,
      assayerId: inv.assayerId,
      status: AssayerInvoiceStatus.INVITED,
      invitedAt: new Date(),
      invitedBy: actorId,
      revision: nextRevision,
      supersedesInvoiceId: inv.id,
      lineCount: eligibleLines.length,
      subtotalBase: round2(eligibleLines.reduce((s, l) => s + Number(l.baseAmount), 0)),
      subtotalTravel: round2(eligibleLines.reduce((s, l) => s + Number(l.travelAmount), 0)),
      tdsAmount: round2(eligibleLines.reduce((s, l) => s + Number(l.tdsAmount), 0)),
      totalAmount: round2(eligibleLines.reduce((s, l) => s + Number(l.totalAmount), 0)),
      currency: inv.currency,
      notes: `Revision ${nextRevision} superseding ${inv.invoiceNumber}. Reason: ${reason.trim()}`,
      createdBy: actorId,
      updatedBy: actorId,
    });
    const savedRevised = await m.save(revisedInvoice);

    // Re-link eligible lines to the new revised invoice
    await m.update(
      AssayerPayableEntity,
      eligibleLines.map((l) => l.id),
      { assayerInvoiceId: savedRevised.id, updatedBy: actorId },
    );

    // Lines on hold (if any) are detached from the old invoice so they return to eligible pool upon unholding
    const heldLines = lines.filter((l) => l.onHold || l.status !== AssayerPayableStatus.PENDING);
    if (heldLines.length) {
      await m.update(
        AssayerPayableEntity,
        heldLines.map((l) => l.id),
        { assayerInvoiceId: null, updatedBy: actorId },
      );
    }

    // Record pointer from old invoice to the new revision
    inv.supersededByInvoiceId = savedRevised.id;
    await m.save(inv);

    await this.engine.history(actorId, {
      assayerId: inv.assayerId,
      entityType: BillingEntityType.ASSAYER_INVOICE, entityId: inv.id, action: 'ASSAYER_INVOICE_SUPERSEDED',
      fromState: prevStatus, toState: AssayerInvoiceStatus.SUPERSEDED,
      newValue: { supersededByInvoiceId: savedRevised.id, revision: nextRevision, reason: reason.trim() },
      reason: reason.trim(),
    }, m);

    await this.engine.history(actorId, {
      assayerId: inv.assayerId,
      entityType: BillingEntityType.ASSAYER_INVOICE, entityId: savedRevised.id, action: 'ASSAYER_INVOICE_INVITED',
      fromState: null, toState: AssayerInvoiceStatus.INVITED,
      newValue: {
        invoiceNumber: savedRevised.invoiceNumber, lineCount: savedRevised.lineCount,
        totalAmount: Number(savedRevised.totalAmount), revision: nextRevision,
        supersedesInvoiceId: inv.id,
      },
      reason: reason.trim(),
    }, m);

    const manager = m;
    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSAYER_INVOICE_SUPERSEDED',
      entityType: 'ASSAYER_INVOICE',
      entityId: inv.id,
      previousState: prevStatus,
      newState: AssayerInvoiceStatus.SUPERSEDED,
      userId: actorId,
      remarks: `Superseded by revision ${savedRevised.invoiceNumber}: ${reason.trim()}`,
      metadata: { oldInvoiceId: inv.id, newInvoiceId: savedRevised.id, reason: reason.trim() },
    }, { manager });

    emit('billing:assayer-invoice-changed', { invoiceId: inv.id, assayerId: inv.assayerId, status: inv.status });
    emit('billing:assayer-invoice-changed', { invoiceId: savedRevised.id, assayerId: savedRevised.assayerId, status: savedRevised.status });

    return {
      saved: savedRevised,
      notify: {
        assayerId: inv.assayerId,
        invoiceId: savedRevised.id,
        invoiceNumber: savedRevised.invoiceNumber,
        count: savedRevised.lineCount,
        revision: nextRevision,
      },
    };
  }

  /** Ask the assayer to confirm a new revision. `why` tells the app why it came back. */
  private notifyRevision(n: RevisionNotice, actorId: string, why?: 'TAX_RECALCULATED'): void {
    this.notificationDispatch.emitSafe({
      type: 'ASSAYER_INVOICE_INVITED',
      entityType: 'ASSAYER_INVOICE',
      entityId: n.invoiceId,
      actorUserId: actorId,
      assayerId: n.assayerId,
      dedupeKey: `ASSAYER_INVOICE_REVISED:${n.invoiceId}`,
      // NO amount (audit F13), exactly like the first invitation: a push body sits on a lock
      // screen, and the reveal happens in the app, on the invitation itself.
      payload: {
        invoiceNumber: n.invoiceNumber,
        count: n.count,
        revision: n.revision,
        isRevision: true,
        ...(why ? { reason: why } : {}),
      },
    });
  }

  // -----------------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------------

  /**
   * A page of invoices with assayer labels — the ops list.
   *
   * Region-narrowed (audit F12, 2026-09-24) like every other billing read: a bill is anchored on its
   * assayer's home region, the same column `assertAssayerInvoiceInScope` reads when one is opened, so
   * the list never offers a bill the drawer would then refuse. An assayer with no region passes, as
   * it does there. This list used to return the whole country's bills to a region desk.
   */
  async list(filters: {
    status?: AssayerInvoiceStatus; assayerId?: string; page?: number | string; limit?: number | string;
  } = {}, scope?: Partial<GlobalScope>): Promise<BillingPage<AssayerInvoiceSummary>> {
    const w = billingPageWindow(filters.page, filters.limit);
    const where: Record<string, unknown> = { isActive: true };
    if (filters.status) where.status = filters.status;
    const regions = scope?.regions?.length ? [...scope.regions] : null;
    if (regions) {
      const inScope = `IN (SELECT s.id FROM assayers s WHERE s.region IS NULL OR s.region = ANY(CAST(:regions AS text[])))`;
      where.assayerId = filters.assayerId
        ? Raw((alias) => `${alias} = :assayerId AND ${alias} ${inScope}`, { assayerId: filters.assayerId, regions })
        : Raw((alias) => `${alias} ${inScope}`, { regions });
    } else if (filters.assayerId) {
      where.assayerId = filters.assayerId;
    }
    const [rows, total] = await this.invoiceRepository.findAndCount({
      where, order: { createdAt: 'DESC' }, skip: w.skip, take: w.take,
    });
    const labels = await this.assayerLabels(rows.map((r) => r.assayerId));
    return {
      items: rows.map((r) => ({
        ...this.toSummary(r),
        assayerName: labels.get(r.assayerId)?.name ?? null,
        assayerCode: labels.get(r.assayerId)?.code ?? null,
      })),
      total, page: w.page, limit: w.limit,
    };
  }

  /** One invoice, lines and labels included — the ops review drawer. */
  async getById(invoiceId: string): Promise<AssayerInvoiceInvitation> {
    const inv = await this.invoiceRepository.findOne({ where: { id: invoiceId } });
    if (!inv) throw new NotFoundException(`Assayer invoice ${invoiceId} not found.`);
    const labels = await this.assayerLabels([inv.assayerId]);
    return {
      ...this.toSummary(inv),
      assayerName: labels.get(inv.assayerId)?.name ?? null,
      assayerCode: labels.get(inv.assayerId)?.code ?? null,
      lines: await this.linesOf(inv.id),
    };
  }

  // -----------------------------------------------------------------------
  // Shapes and labels
  // -----------------------------------------------------------------------

  private toSummary(inv: AssayerInvoiceEntity): AssayerInvoiceSummary {
    return {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      assayerId: inv.assayerId,
      status: inv.status,
      invitedAt: inv.invitedAt ? new Date(inv.invitedAt).toISOString() : null,
      invitedBy: inv.invitedBy ?? null,
      submittedAt: inv.submittedAt ? new Date(inv.submittedAt).toISOString() : null,
      approvedAt: inv.approvedAt ? new Date(inv.approvedAt).toISOString() : null,
      approvedBy: inv.approvedBy ?? null,
      hodApprovedAt: inv.hodApprovedAt ? new Date(inv.hodApprovedAt).toISOString() : null,
      hodApprovedBy: inv.hodApprovedBy ?? null,
      hodRejectedAt: inv.hodRejectedAt ? new Date(inv.hodRejectedAt).toISOString() : null,
      hodRejectedBy: inv.hodRejectedBy ?? null,
      hodRejectReason: inv.hodRejectReason ?? null,
      cancelledAt: inv.cancelledAt ? new Date(inv.cancelledAt).toISOString() : null,
      cancelledBy: inv.cancelledBy ?? null,
      cancelReason: inv.cancelReason ?? null,
      lineCount: Number(inv.lineCount),
      subtotalBase: Number(inv.subtotalBase),
      subtotalTravel: Number(inv.subtotalTravel),
      tdsAmount: Number(inv.tdsAmount),
      totalAmount: Number(inv.totalAmount),
      currency: inv.currency,
      notes: inv.notes ?? null,
      revision: inv.revision ?? 1,
      supersedesInvoiceId: inv.supersedesInvoiceId ?? null,
      supersededByInvoiceId: inv.supersededByInvoiceId ?? null,
      confirmedVersion: inv.confirmedVersion ?? null,
      paidAt: inv.paidAt ? new Date(inv.paidAt).toISOString() : null,
      paidBy: inv.paidBy ?? null,
    };
  }

  /**
   * The invoice's lines, labelled for a human: assignment number, branch, the completion date
   * as the service date, and the expense category on reimbursement lines. Amounts are the
   * stored payable amounts, read back verbatim.
   */
  private async linesOf(invoiceId: string): Promise<AssayerInvoiceLine[]> {
    const rows = await this.payableRepository.manager.query(
      `SELECT p.id, p.payable_number, p.status, p.on_hold, p.expense_id, p.assignment_id,
              p.base_amount, p.travel_amount, p.tds_amount, p.total_amount,
              a.assignment_number, a.completion_date, b.name AS branch_name,
              c.name AS client_name,
              x.category AS expense_category
         FROM assayer_payables p
         LEFT JOIN assignments a ON a.id = p.assignment_id
         LEFT JOIN clients c ON c.id = p.client_id
         LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
         LEFT JOIN branches b ON b.id = pb.branch_id
         LEFT JOIN assignment_expenses x ON x.id = p.expense_id
        WHERE p.assayer_invoice_id = $1 AND p.is_active = true
        ORDER BY a.completion_date ASC NULLS LAST, p.created_at ASC`,
      [invoiceId],
    );
    return rows.map((r: any): AssayerInvoiceLine => ({
      payableId: r.id,
      payableNumber: r.payable_number,
      kind: r.expense_id ? 'EXPENSE' : 'FEE',
      payableStatus: r.status,
      onHold: !!r.on_hold,
      assignmentId: r.assignment_id ?? null,
      assignmentNumber: r.assignment_number ?? null,
      clientName: r.client_name ?? null,
      branchName: r.branch_name ?? null,
      // ISO yyyy-mm-dd, like every other date this API returns — the frontend formats it once.
      // `String(date).slice(0,10)` looked right for a raw string column but this comes back from
      // the driver as a JS Date, whose `String()` form is "Sat Sep 05 2026 …" — slicing that gave
      // "Sat Sep 05", which the frontend's `new Date(...)` then re-parsed to the year 2001.
      serviceDate: r.completion_date
        ? (r.completion_date instanceof Date
            ? businessDateKey(r.completion_date)
            : String(r.completion_date).slice(0, 10))
        : null,
      expenseCategory: r.expense_category ?? null,
      baseAmount: Number(r.base_amount),
      travelAmount: Number(r.travel_amount),
      tdsAmount: Number(r.tds_amount),
      totalAmount: Number(r.total_amount),
    }));
  }

  private async assayerLabels(assayerIds: string[]): Promise<Map<string, { name: string | null; code: string | null }>> {
    const ids = [...new Set(assayerIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const rows = await this.payableRepository.manager
      .query(`SELECT id, display_name, assayer_code FROM assayers WHERE id = ANY($1)`, [ids])
      .catch(() => []);
    return new Map(rows.map((r: any) => [r.id, { name: r.display_name ?? null, code: r.assayer_code ?? null }]));
  }
}
