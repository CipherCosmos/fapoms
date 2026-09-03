import { Injectable, Logger } from '@nestjs/common';
import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { AssignmentService } from '../../modules/assignment/assignment.service';
import { HrWorkforceService } from '../../modules/assayer/hr-workforce.service';
import { NotificationDispatchService } from '../../modules/notifications/notification-dispatch.service';
import { DeskEscalationService } from '../../modules/validation/desk-escalation.service';
import { FeedbackEscalationService } from '../../modules/feedback/feedback-escalation.service';
import { LocationTrailService } from '../../modules/assayer/location-trail.service';
import { DataIntegrityService } from '../../modules/assayer/data-integrity.service';
import { EmailDigestService } from './email-digest.service';
import { BillingEngineService } from '../../modules/billing-engine/billing-engine.service';
import { businessTodayDateKey } from '@fapoms/shared';

@Injectable()
@Processor('sla-scanner')
export class SlaScannerWorker {
  private readonly logger = new Logger(SlaScannerWorker.name);

  /**
   * Far enough out that a renewal can realistically be started and completed, close
   * enough that HR are not told about paperwork half a year away and stop reading.
   */
  /**
   * How long a payout may sit unapproved, and a visit unclosed, before anyone is told.
   *
   * Days, not hours: approving payouts is a finance rhythm, not a live queue, and a scanner that
   * shouted on the afternoon of the same day would be muted within a week — at which point the
   * genuinely stuck ones stop being seen too.
   */
  private static readonly PAYOUT_APPROVAL_GRACE_DAYS = 3;
  private static readonly UNCLOSED_VISIT_GRACE_DAYS = 2;

  private static readonly DOCUMENT_EXPIRY_LEAD_DAYS = 30;

  constructor(
    private readonly assignmentService: AssignmentService,
    private readonly hrWorkforceService: HrWorkforceService,
    private readonly notificationDispatch: NotificationDispatchService,
    private readonly deskEscalation: DeskEscalationService,
    private readonly feedbackEscalation: FeedbackEscalationService,
    private readonly locationTrail: LocationTrailService,
    private readonly dataIntegrity: DataIntegrityService,
    private readonly emailDigest: EmailDigestService,
    private readonly billingEngine: BillingEngineService,
  ) {}

  /**
   * The morning email digest, on its own schedule (default 08:30 IST — see the module).
   * A separate job from 'scan': the scan runs every 15 minutes and must stay cheap; the
   * digest runs once a day and sends real email.
   */
  @Process('digest')
  async runDigest(_job: Job) {
    await this.emailDigest.run();
  }

  /**
   * Independent scans behind one 15-minute tick. Each is idempotent (its notifications carry
   * dedupe keys, its state changes are guarded), so they are run as siblings, not a chain.
   *
   * They used to run sequentially with every catch re-throwing, so a failure in the first phase
   * (the assignment SLA scan) aborted every one after it — desk escalation, feedback escalation and
   * the credential-expiry warnings all silently skipped for that tick, and the phase most likely
   * to throw under load was one of the unbounded scans this change also fixed. Now every phase
   * runs regardless of the others; failures are collected and re-thrown as one aggregate at the
   * end, so the job is still marked failed (and retried) without one broken scan starving the
   * rest. This also contains a fault in any single scan — including ones still being built out —
   * to that scan alone.
   */
  @Process('scan')
  async runScan(_job: Job) {
    const failures: Array<{ phase: string; error: unknown }> = [];
    const runPhase = async (phase: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        this.logger.error(`Error during ${phase}:`, error as Error);
        failures.push({ phase, error });
      }
    };

    await runPhase('SLA breach scan', async () => {
      const breachedCount = await this.assignmentService.checkSlaBreaches();
      if (breachedCount > 0) {
        this.logger.log(`SLA scan complete. Flagged ${breachedCount} breached assignments.`);
      }
    });

    await runPhase('auto-decline scan', async () => {
      const declinedCount = await this.assignmentService.autoDeclineExpiredOffers();
      if (declinedCount > 0) {
        this.logger.log(`Auto-declined ${declinedCount} assignment offer(s) with no response within the SLA window.`);
      }
    });

    /**
     * Credential expiry — identity documents AND professional certifications.
     *
     * Certifications used to be missing from this sweep entirely, because
     * `credentialsExpiringWithin` read `assayer_government_documents` alone while
     * certifications live in `workforce_attributes` (`type = 'CERTIFICATION'`). That was the
     * expensive half to lose: an expired certification BLOCKS assignment (assayer.service.ts
     * refuses it), so the silence ended with dispatch being told, on the morning of the job,
     * that the only qualified assayer was ineligible. The same 30-day lead applies to both —
     * the figure was chosen for "long enough to actually renew, short enough that HR keeps
     * reading", and that reasoning does not change with the kind of credential.
     */
    await runPhase('credential expiry scan', async () => {
      const expiring = await this.hrWorkforceService.credentialsExpiringWithin(
        SlaScannerWorker.DOCUMENT_EXPIRY_LEAD_DAYS,
      );
      let certifications = 0;
      for (const doc of expiring) {
        const isCertification = doc.credentialKind === 'CERTIFICATION';
        if (isCertification) certifications += 1;
        // This scan runs every 15 minutes, so the key has to survive repetition: one
        // notification per credential per expiry date. A renewed credential carries a new
        // expiry and so legitimately warns again the next time it comes due. The type is part
        // of the key by construction, so a document and a certification can never collide even
        // if their primary keys ever did.
        const type = isCertification ? 'ASSAYER_CERTIFICATION_EXPIRING' : 'ASSAYER_DOCUMENT_EXPIRING';
        this.notificationDispatch.emitSafe({
          type,
          entityType: 'ASSAYER',
          entityId: doc.assayerId,
          assayerId: doc.assayerId,
          dedupeKey: `${type}:${doc.id}:${doc.expiryDate}`,
          payload: {
            assayerName: doc.assayerName,
            // Both keys are populated for both kinds: the templates differ, but a payload that
            // silently lacks the placeholder its template needs renders "${…}" at the user.
            documentName: doc.documentName,
            certificationName: doc.documentName,
            expiryDate: doc.expiryDate,
          },
        });
      }
      if (expiring.length > 0) {
        this.logger.log(`Flagged ${expiring.length} assayer credential(s) (${certifications} certification(s)) expiring within ${SlaScannerWorker.DOCUMENT_EXPIRY_LEAD_DAYS} days.`);
      }
    });

    // The data-entry desk's stalled stages: unassigned packets, silent members,
    // undecided reviews, unshipped approved reports, stuck OCR, stale clarifications.
    await runPhase('desk escalation scan', () => this.deskEscalation.scan());

    // The feedback desk's response-time SLAs: items awaiting a first reply, or open
    // past their severity-scaled resolution clock.
    await runPhase('feedback escalation scan', () => this.feedbackEscalation.scan());

    /**
     * The money chain's watchdog — the half of the lifecycle nothing was watching.
     *
     * Everything from "audit completed" to "assayer paid" is a person clicking: approve the
     * payout, export the bank file, mark it paid. Booking the payable was the single automatic
     * hop, and no phase of this scanner looked at `assayer_payables` at all. So a payout could
     * rest unapproved for weeks while the assayer's own screen called it owed, and an audit that
     * was attended but never closed booked nothing and told nobody. Both ended with a real person
     * not being paid, and neither raised anything.
     *
     * Day-bucketed dedupe keys, because this runs every 15 minutes: without them a slow week
     * would be 672 notifications about the same stalled payout.
     */
    await runPhase('payout approval backlog', async () => {
      const stale = await this.billingEngine.payoutsAwaitingApproval(
        SlaScannerWorker.PAYOUT_APPROVAL_GRACE_DAYS,
      );
      if (stale.count === 0) return;
      this.notificationDispatch.emitSafe({
        type: 'PAYABLE_AWAITING_APPROVAL',
        entityType: 'PAYABLE',
        entityId: 'backlog',
        dedupeKey: `PAYABLE_AWAITING_APPROVAL:${businessTodayDateKey()}`,
        payload: {
          count: stale.count,
          amount: stale.totalAmount.toLocaleString('en-IN'),
          days: stale.oldestDays,
        },
      });
      this.logger.warn(
        `${stale.count} payout(s) worth ₹${stale.totalAmount} awaiting approval (oldest ${stale.oldestDays}d).`,
      );
    });

    await runPhase('attended but unclosed audits', async () => {
      const stuck = await this.billingEngine.attendedButNotClosed(
        SlaScannerWorker.UNCLOSED_VISIT_GRACE_DAYS,
      );
      if (stuck.count === 0) return;
      this.notificationDispatch.emitSafe({
        type: 'ASSIGNMENT_ATTENDED_NOT_CLOSED',
        entityType: 'ASSIGNMENT',
        entityId: 'backlog',
        dedupeKey: `ASSIGNMENT_ATTENDED_NOT_CLOSED:${businessTodayDateKey()}`,
        payload: { count: stuck.count, oldest: stuck.oldestDate ?? 'unknown' },
      });
      this.logger.warn(
        `${stuck.count} attended audit(s) never closed — nothing booked for payment (oldest ${stuck.oldestDate}).`,
      );
    });

    /**
     * Re-run the booking sweep the system already had, on a schedule rather than on a click.
     *
     * `reconcile()` was written for "the day the event was lost, the lock failed open twice, or a
     * database was restored" — and the only way to run it was a button on the finance page. A
     * dropped completion event therefore meant an assayer was never paid and nothing ever noticed,
     * which is precisely the failure the routine exists to repair. It is idempotent (two unique
     * indexes make a re-book a no-op), so running it hourly costs a query and removes the
     * dependency on somebody remembering.
     */
    await runPhase('billing reconcile sweep', async () => {
      const hour = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
      // Hourly, not every 15 minutes: it walks completed assignments, and the notifications above
      // already surface anything it would repair.
      if (hour % 60 >= 15) return;
      // 'SYSTEM' as the actor: this run has no human behind it, and the history rows it writes
      // should say so rather than attributing the repair to whoever last pressed the button.
      const result = await this.billingEngine.reconcile('SYSTEM', { since: null });
      const booked = result?.booked ?? 0;
      if (booked > 0) {
        this.logger.warn(`Billing reconcile booked ${booked} assignment(s) the completion event had missed.`);
      }
    });

    /**
     * Trail retention. A no-op unless LOCATION_TRAIL_RETENTION_DAYS is set — see
     * LocationTrailService.purgeOlderThanRetention for why no default is chosen here. Drains in
     * slices so a first run over a long-neglected table does not hold a lock; bounded per tick so
     * it can never monopolise the scanner.
     */
    await runPhase('location trail retention', async () => {
      let removed = 0;
      for (let pass = 0; pass < 10; pass++) {
        const { configured, deleted } = await this.locationTrail.purgeOlderThanRetention();
        if (!configured || deleted === 0) break;
        removed += deleted;
      }
      if (removed > 0) this.logger.log(`Location trail retention removed ${removed} fix(es).`);
    });

    /**
     * The roster's standing data-integrity scan — corrupt dates, lifecycle contradictions,
     * duplicate identity numbers — writing into the same review queue the import panel reads.
     * Every 15-minute tick, not the hourly gate the reconcile uses: ten small reads over 1,163
     * rows plus ~150 keyed lookups is cheap, and it means a corrected record's finding closes
     * within 15 minutes instead of an hour. Idempotent by key: two ticks over unchanged data
     * write nothing (data-integrity.spec.ts pins it), so repetition costs only the reads.
     */
    await runPhase('data integrity scan', async () => {
      const result = await this.dataIntegrity.scan();
      if (result.inserted + result.reopened + result.autoClosed > 0) {
        this.logger.log(
          `Data integrity scan: ${result.findings} finding(s) — ${result.inserted} new, `
          + `${result.reopened} reopened, ${result.autoClosed} auto-closed as corrected.`,
        );
      }
    });

    if (failures.length > 0) {
      // Surface the tick as failed (so Bull records and retries it) while preserving that every
      // phase was attempted. AggregateError keeps each underlying cause for the logs.
      throw new AggregateError(
        failures.map((f) => f.error),
        `SLA scanner: ${failures.length} of 10 phases failed (${failures.map((f) => f.phase).join(', ')}).`,
      );
    }
  }
}
