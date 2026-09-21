import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { BillingEngineService } from './billing-engine.service';
import { AssayerInvoiceService } from './assayer-invoice.service';
import {
  ApprovePayoutsJobData,
  BILLING_BULK_JOB,
  BILLING_BULK_QUEUE,
  InviteAllAssayerInvoicesJobData,
  PayPayoutsJobData,
} from './billing-bulk-jobs.contract';
import { progressReporter } from '../../infrastructure/queue/queued-job';
import { runAsJobActor } from '../../infrastructure/queue/job-actor';

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
 */
@Processor(BILLING_BULK_QUEUE)
export class BillingBulkJobsWorker {
  private readonly logger = new Logger(BillingBulkJobsWorker.name);

  constructor(
    private readonly billing: BillingEngineService,
    private readonly assayerInvoices: AssayerInvoiceService,
  ) {}

  @Process({ name: '*', concurrency: 1 })
  async run(job: Job<ApprovePayoutsJobData | PayPayoutsJobData | InviteAllAssayerInvoicesJobData>) {
    switch (job.name) {
      case BILLING_BULK_JOB.APPROVE_PAYOUTS:
        return this.approvePayouts(job as Job<ApprovePayoutsJobData>);
      case BILLING_BULK_JOB.PAY_PAYOUTS:
        return this.payPayouts(job as Job<PayPayoutsJobData>);
      case BILLING_BULK_JOB.INVITE_ALL_ASSAYER_INVOICES:
        return this.inviteAllAssayerInvoices(job as Job<InviteAllAssayerInvoicesJobData>);
      default:
        // A name nothing here knows would otherwise complete silently with no result.
        throw new Error(`No handler for billing bulk job "${job.name}".`);
    }
  }

  async approvePayouts(job: Job<ApprovePayoutsJobData>) {
    const { payableIds, actor, reason } = job.data;
    this.logger.log(`Approve payouts run ${job.id}: ${payableIds.length} payout(s).`);
    return runAsJobActor(actor, () =>
      this.billing.approvePayouts(payableIds, actor.userId, progressReporter(job), reason));
  }

  async payPayouts(job: Job<PayPayoutsJobData>) {
    const { payableIds, payment, actor } = job.data;
    this.logger.log(`Pay payouts run ${job.id}: ${payableIds.length} payout(s).`);
    return runAsJobActor(actor, () =>
      this.billing.payPayouts(payableIds, payment, actor.userId, progressReporter(job)));
  }

  async inviteAllAssayerInvoices(job: Job<InviteAllAssayerInvoicesJobData>) {
    const { scope, actor } = job.data;
    this.logger.log(`Invite-all assayer invoices run ${job.id}.`);
    return runAsJobActor(actor, async () => {
      /*
        The rollout gate again, at run time. The request checked it before queueing, but a run that
        waited behind another could start after the flag was turned off — and the gate's whole
        promise is that nothing starts a money reveal while the feature is dark.
      */
      await this.assayerInvoices.assertEnabled();
      return this.assayerInvoices.inviteAll(actor.userId, scope ?? undefined, progressReporter(job));
    });
  }
}
