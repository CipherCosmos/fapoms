import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, EntityManager } from 'typeorm';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { isUniqueViolation } from '../../infrastructure/database/unique-violation';
import { AssayerInvoiceEntity } from './assayer-invoice.entity';
import { AssayerPayableEntity } from './payable.entity';
import { ASSAYER_INVOICE_ELIGIBLE_SQL } from './assayer-invoice-eligibility';
import { BillingEngineService, billingPageWindow, BillingPage } from './billing-engine.service';
import { AuditService } from '../../core/audit/audit.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { round2, MONEY_EPSILON } from './assignment-money';
import {
  AssayerInvoiceStatus,
  AssayerPayableStatus,
  BillingEntityType,
  EventCategory,
  AssayerInvoiceInvitation,
  AssayerInvoiceLine,
  AssayerInvoiceSummary,
  AssayerInvoiceInviteOutcome,
} from '@fapoms/shared';

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
   * The rollout gate. `billing.assayerInvoicingEnabled` ships default-false so this whole
   * feature deploys dark: migrate, verify, then flip the flag. A read failure (the key not in
   * the registry yet — it lands with the coordinator's settings change) counts as OFF, because
   * a feature gate that fails open is not a gate. 404 rather than 403: while the feature is
   * off, these routes do not exist.
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
   */
  async inviteAll(actorId: string, scope?: Partial<GlobalScope>): Promise<{
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
    for (const r of rows) {
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
    });
    if (!invoice) return null;
    return { ...this.toSummary(invoice), lines: await this.linesOf(invoice.id) };
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
  async submit(assayerId: string, clientRequestId: string): Promise<AssayerInvoiceSummary> {
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
      inv.updatedBy = assayerId;
      const out = await m.save(inv);

      await this.engine.history(assayerId, {
        assayerId,
        entityType: BillingEntityType.ASSAYER_INVOICE, entityId: out.id, action: 'ASSAYER_INVOICE_SUBMITTED',
        fromState: AssayerInvoiceStatus.INVITED, toState: AssayerInvoiceStatus.SUBMITTED,
        newValue: { submittedRequestId: clientRequestId, lineCount: out.lineCount, totalAmount: Number(out.totalAmount) },
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
        userId: assayerId,
        remarks: `Assayer submitted invoice ${out.invoiceNumber} (${out.lineCount} line(s), ₹${Number(out.totalAmount)})`,
        metadata: { invoiceId: out.id, invoiceNumber: out.invoiceNumber, assayerId, lineCount: out.lineCount, totalAmount: Number(out.totalAmount) },
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
            actorUserId: assayerId,
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
    let notify: { invoiceNumber: string; count: number; assayerId: string } | null = null;
    const saved = await this.inTx(async (m, emit) => {
      const inv = await m.findOne(AssayerInvoiceEntity, { where: { id: invoiceId }, lock: { mode: 'pessimistic_write' } });
      if (!inv) throw new NotFoundException(`Assayer invoice ${invoiceId} not found.`);
      if (inv.status === AssayerInvoiceStatus.APPROVED) return inv; // the double-press — no-op
      if (inv.status === AssayerInvoiceStatus.CANCELLED) {
        throw new ConflictException(`${inv.invoiceNumber} is cancelled.`);
      }
      if (inv.status !== AssayerInvoiceStatus.SUBMITTED) {
        throw new BadRequestException(
          `${inv.invoiceNumber} has not been submitted by the assayer yet — approval accepts THEIR confirmation, it cannot precede it.`,
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
      for (const line of lines) {
        if (line.status === AssayerPayableStatus.PENDING) {
          await this.engine.approvePayableInTx(m, emit, line.id, actorId, {
            suppressNotification: true,
            bypassInvoiceGuard: true,
          });
        }
      }

      inv.status = AssayerInvoiceStatus.APPROVED;
      inv.approvedAt = new Date();
      inv.approvedBy = actorId;
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
      notify = { invoiceNumber: out.invoiceNumber, count: out.lineCount, assayerId: out.assayerId };
      return out;
    });

    if (notify) {
      // Count-only body (the catalog keeps ₹ out of assayer pushes); amounts are on the
      // statement, which approval has just unlocked.
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
      if (inv.status === AssayerInvoiceStatus.APPROVED) {
        throw new ConflictException(
          `${inv.invoiceNumber} is approved — its lines are approved payouts now. Void the payouts individually instead.`,
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

  // -----------------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------------

  /** A page of invoices with assayer labels — the ops list. */
  async list(filters: {
    status?: AssayerInvoiceStatus; assayerId?: string; page?: number | string; limit?: number | string;
  } = {}): Promise<BillingPage<AssayerInvoiceSummary>> {
    const w = billingPageWindow(filters.page, filters.limit);
    const where: Record<string, unknown> = { isActive: true };
    if (filters.status) where.status = filters.status;
    if (filters.assayerId) where.assayerId = filters.assayerId;
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
              x.category AS expense_category
         FROM assayer_payables p
         LEFT JOIN assignments a ON a.id = p.assignment_id
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
      branchName: r.branch_name ?? null,
      // ISO yyyy-mm-dd, like every other date this API returns — the frontend formats it once.
      // `String(date).slice(0,10)` looked right for a raw string column but this comes back from
      // the driver as a JS Date, whose `String()` form is "Sat Sep 05 2026 …" — slicing that gave
      // "Sat Sep 05", which the frontend's `new Date(...)` then re-parsed to the year 2001.
      serviceDate: r.completion_date
        ? (r.completion_date instanceof Date
            ? r.completion_date.toISOString().slice(0, 10)
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
