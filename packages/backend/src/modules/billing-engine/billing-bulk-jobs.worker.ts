import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { BillingEngineService } from './billing-engine.service';
import { AssayerInvoiceService } from './assayer-invoice.service';
import { FinalApprovalService } from './final-approval.service';
import {
  ApprovePayoutsJobData,
  BILLING_BULK_JOB,
  BILLING_BULK_QUEUE,
  FinalApproveJobData,
  InviteAllAssayerInvoicesJobData,
  PayPayoutsJobData,
} from './billing-bulk-jobs.contract';
import { runAsJobActor } from '../../infrastructure/queue/job-actor';
import { BackgroundJobTracker } from '../../infrastructure/background-jobs/background-job.tracker';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Runs billing bulk writes (see `billing-bulk-jobs.contract.ts` for why they left the request).
 *
 * ONE loop for the whole queue, dispatching on the job name — not a `@Process` per action.
 *
 * Bull does not reserve slots per job name: each `@Process({ name, concurrency })` adds loops to
 * the queue, and every loop takes the next job of any name. Three named handlers at concurrency 1
 * would be three loops, so an approval run and a payment run over the same payouts could be
 * active together, each re-reading rows the other is changing. A single `'*'` loop makes "one
 * billing bulk run at a time" true.
 *
 * Every run executes inside the requester's scope (`runAsJobActor`): tenant scoping and the audit
 * rows these writes produce read the ambient principal, and a worker has none of its own.
 *
 * Every run is also TRACKED (`BackgroundJobTracker`): its `background_jobs` row goes RUNNING,
 * carries the progress, and ends with a one-sentence summary and counts — so a refreshed page and
 * the Jobs tray still know whether "Pay 12 payouts" went through. The return value, Bull progress
 * and rethrow are unchanged, so `GET bulk-jobs/:jobId` answers exactly what it did.
 */
@Processor(BILLING_BULK_QUEUE)
export class BillingBulkJobsWorker {
  private readonly logger = new Logger(BillingBulkJobsWorker.name);

  constructor(
    private readonly billing: BillingEngineService,
    private readonly assayerInvoices: AssayerInvoiceService,
    private readonly tracker: BackgroundJobTracker,
    private readonly finalApproval: FinalApprovalService,
  ) {}

  @Process({ name: '*', concurrency: 1 })
  async run(job: Job<ApprovePayoutsJobData | PayPayoutsJobData | InviteAllAssayerInvoicesJobData | FinalApproveJobData>) {
    switch (job.name) {
      case BILLING_BULK_JOB.APPROVE_PAYOUTS:
        return this.approvePayouts(job as Job<ApprovePayoutsJobData>);
      case BILLING_BULK_JOB.PAY_PAYOUTS:
        return this.payPayouts(job as Job<PayPayoutsJobData>);
      case BILLING_BULK_JOB.INVITE_ALL_ASSAYER_INVOICES:
        return this.inviteAllAssayerInvoices(job as Job<InviteAllAssayerInvoicesJobData>);
      case BILLING_BULK_JOB.FINAL_APPROVE:
        return this.finalApprove(job as Job<FinalApproveJobData>);
      default:
        // A name nothing here knows would otherwise complete silently with no result.
        throw new Error(`No handler for billing bulk job "${job.name}".`);
    }
  }

  async approvePayouts(job: Job<ApprovePayoutsJobData>) {
    const { payableIds, actor, reason } = job.data;
    this.logger.log(`Approve payouts run ${job.id}: ${payableIds.length} payout(s).`);
    return this.tracker.run(job, (t) => runAsJobActor(actor, () =>
      this.billing.approvePayouts(payableIds, actor.userId, t.progress, reason)), {
      describe: (r) => ({
        summary: r.refused.length
          ? `${plural(r.done.length, 'payout')} approved; ${r.refused.length} refused.`
          : `${plural(r.done.length, 'payout')} approved.`,
        counts: { approved: r.done.length, refused: r.refused.length },
      }),
    });
  }

  /** The HOD's bulk final approval — one owner per kind, one transaction per item. */
  async finalApprove(job: Job<FinalApproveJobData>) {
    const { items, actor } = job.data;
    this.logger.log(`Final approval run ${job.id}: ${items.length} item(s).`);
    return this.tracker.run(job, (t) => runAsJobActor(actor, () =>
      this.finalApproval.approveMany(items, actor.userId, t.progress)), {
      describe: (r) => ({
        summary: r.refused.length
          ? `${plural(r.done.length, 'item')} given final approval; ${r.refused.length} refused.`
          : `${plural(r.done.length, 'item')} given final approval.`,
        counts: { approved: r.done.length, refused: r.refused.length },
      }),
    });
  }

  async payPayouts(job: Job<PayPayoutsJobData>) {
    const { payableIds, payment, actor } = job.data;
    this.logger.log(`Pay payouts run ${job.id}: ${payableIds.length} payout(s).`);
    return this.tracker.run(job, (t) => runAsJobActor(actor, () =>
      this.billing.payPayouts(payableIds, payment, actor.userId, t.progress)), {
      describe: (r) => ({
        summary: r.refused.length
          ? `${plural(r.done.length, 'payout')} paid; ${r.refused.length} refused.`
          : `${plural(r.done.length, 'payout')} paid.`,
        counts: { paid: r.done.length, refused: r.refused.length },
      }),
    });
  }

  async inviteAllAssayerInvoices(job: Job<InviteAllAssayerInvoicesJobData>) {
    const { scope, actor } = job.data;
    this.logger.log(`Invite-all assayer invoices run ${job.id}.`);
    return this.tracker.run(job, (t) => runAsJobActor(actor, async () => {
      /*
        The rollout gate again, at run time. The request checked it before queueing, but a run that
        waited behind another could start after the flag was turned off — and the gate's whole
        promise is that nothing starts a money reveal while the feature is dark.
      */
      await this.assayerInvoices.assertEnabled();
      return this.assayerInvoices.inviteAll(actor.userId, scope ?? undefined, t.progress);
    }), {
      describe: (r) => {
        // `skipped` counts every assayer not invited, a failure included; the sentence separates them.
        const failed = r.outcomes.filter((o) => o.outcome === 'failed').length;
        const skipped = r.skipped - failed;
        return {
          summary: `${plural(r.invited, 'assayer')} invited to submit a bill; ${skipped} skipped`
            + (failed ? `; ${failed} could not be invited (run the round again for them).` : '.'),
          counts: { invited: r.invited, skipped, failed },
        };
      },
    });
  }
}
