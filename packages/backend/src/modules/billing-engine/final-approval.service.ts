import { BadRequestException, Injectable } from '@nestjs/common';
import { FinalApprovalBulkResult, FinalApprovalQueue, FinalApprovalRef } from '@fapoms/shared';
import { BillingEngineService } from './billing-engine.service';
import { AssayerInvoiceService } from './assayer-invoice.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import type { ProgressCallback } from '../../infrastructure/queue/queued-job';

/**
 * THE HOD'S QUEUE (owner, 2026-09-24): everything the office approved that is waiting for the
 * final approval, in one list — and the bulk approve that walks it.
 *
 * The state changes themselves live with what they change: a payout's and a client invoice's in
 * `BillingEngineService`, a bill's in `AssayerInvoiceService`. This class only reads across the
 * three and dispatches, so there is one implementation of each approval whichever screen asks.
 *
 * What is waiting, exactly:
 *  - ASSAYER_BILL — a bill in APPROVED (the office approved it; HOD_APPROVED is after the HOD).
 *  - DIRECT_PAYOUT / EXPENSE_REIMBURSEMENT — an APPROVED payable with no final approval, not on
 *    hold, still owed, and not riding a bill that is out, confirmed or office-approved (that bill
 *    is what the HOD approves). Told apart by `expense_id`.
 *  - CLIENT_INVOICE — an invoice in AWAITING_HOD.
 *
 * Region: the same ceilings as the lists these come from. A bill is anchored on its assayer's home
 * region (`assertAssayerInvoiceInScope`); a payout and an invoice on their assignments' branches,
 * by the one rule `billing-region-scope.ts` writes down, applied when region scoping enforces.
 */
@Injectable()
export class FinalApprovalService {
  constructor(
    private readonly engine: BillingEngineService,
    private readonly bills: AssayerInvoiceService,
    private readonly regionGuard: RegionGuardService,
  ) {}

  /** The queue itself is read by the engine (it owns the tables); see `BillingEngineService.finalApprovalQueue`. */
  async queue(scope?: Partial<GlobalScope>): Promise<FinalApprovalQueue> {
    return this.engine.finalApprovalQueue(scope);
  }

  /**
   * Approve ONE item — the single-row button, and each step of the bulk run. Dispatches to the
   * owner of the state change; every refusal (not the HOD's to give, already paid, the same person
   * as the office approver) is theirs, word for word.
   */
  async approveOne(ref: FinalApprovalRef, userId: string): Promise<void> {
    switch (ref.kind) {
      case 'ASSAYER_BILL':
        await this.bills.hodApprove(ref.id, userId);
        return;
      case 'DIRECT_PAYOUT':
      case 'EXPENSE_REIMBURSEMENT':
        await this.engine.hodApprovePayout(ref.id, userId);
        return;
      case 'CLIENT_INVOICE':
        await this.engine.hodApproveInvoice(ref.id, userId);
        return;
      default:
        throw new BadRequestException(`Unknown kind of item: ${String((ref as FinalApprovalRef).kind)}.`);
    }
  }

  async rejectOne(ref: FinalApprovalRef, reason: string, userId: string): Promise<void> {
    switch (ref.kind) {
      case 'ASSAYER_BILL':
        await this.bills.hodReject(ref.id, userId, reason);
        return;
      case 'DIRECT_PAYOUT':
      case 'EXPENSE_REIMBURSEMENT':
        await this.engine.hodRejectPayout(ref.id, reason, userId);
        return;
      case 'CLIENT_INVOICE':
        await this.engine.hodRejectInvoice(ref.id, reason, userId);
        return;
      default:
        throw new BadRequestException(`Unknown kind of item: ${String((ref as FinalApprovalRef).kind)}.`);
    }
  }

  /**
   * The bulk approve, run by `BillingBulkJobsWorker`. One item at a time, each its own transaction:
   * one refusal does not undo the rest, and the result says which went through and why the others
   * did not. There is no bulk reject — a reason is written per item, for the person who reads it.
   */
  async approveMany(refs: FinalApprovalRef[], userId: string, onProgress?: ProgressCallback): Promise<FinalApprovalBulkResult> {
    const seen = new Set<string>();
    const unique = refs.filter((r) => {
      const key = `${r.kind}:${r.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const done: FinalApprovalRef[] = [];
    const refused: FinalApprovalBulkResult['refused'] = [];
    for (const [index, ref] of unique.entries()) {
      try {
        await this.approveOne(ref, userId);
        done.push({ kind: ref.kind, id: ref.id });
      } catch (err) {
        refused.push({ kind: ref.kind, id: ref.id, reason: (err as Error).message });
      }
      await onProgress?.(index + 1, unique.length, 'Giving final approval');
    }
    return { done, refused };
  }

  /**
   * The region ceiling for a set of items, asked about the WHOLE set before anything is queued —
   * the same rule the payout batch routes follow: a half-run approval is worse than a refusal.
   */
  async assertInScope(refs: FinalApprovalRef[], scope?: Partial<GlobalScope>): Promise<void> {
    if (!scope?.regions?.length) return;
    const payables = refs.filter((r) => r.kind === 'DIRECT_PAYOUT' || r.kind === 'EXPENSE_REIMBURSEMENT').map((r) => r.id);
    if (payables.length) await this.regionGuard.assertPayablesInScope(payables, scope);
    for (const r of refs) {
      if (r.kind === 'ASSAYER_BILL') await this.regionGuard.assertAssayerInvoiceInScope(r.id, scope);
      if (r.kind === 'CLIENT_INVOICE') await this.regionGuard.assertInvoiceInScope(r.id, scope);
    }
  }
}
