import { Injectable, Logger } from '@nestjs/common';
import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { AssignmentService } from '../../modules/assignment/assignment.service';
import { HrWorkforceService } from '../../modules/assayer/hr-workforce.service';
import { NotificationDispatchService } from '../../modules/notifications/notification-dispatch.service';
import { DeskEscalationService } from '../../modules/validation/desk-escalation.service';
import { FeedbackEscalationService } from '../../modules/feedback/feedback-escalation.service';
import { LocationTrailService } from '../../modules/assayer/location-trail.service';

@Injectable()
@Processor('sla-scanner')
export class SlaScannerWorker {
  private readonly logger = new Logger(SlaScannerWorker.name);

  /**
   * Far enough out that a renewal can realistically be started and completed, close
   * enough that HR are not told about paperwork half a year away and stop reading.
   */
  private static readonly DOCUMENT_EXPIRY_LEAD_DAYS = 30;

  constructor(
    private readonly assignmentService: AssignmentService,
    private readonly hrWorkforceService: HrWorkforceService,
    private readonly notificationDispatch: NotificationDispatchService,
    private readonly deskEscalation: DeskEscalationService,
    private readonly feedbackEscalation: FeedbackEscalationService,
    private readonly locationTrail: LocationTrailService,
  ) {}

  /**
   * Six independent scans behind one 15-minute tick. Each is idempotent (its notifications carry
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

    await runPhase('document expiry scan', async () => {
      const expiring = await this.hrWorkforceService.credentialsExpiringWithin(
        SlaScannerWorker.DOCUMENT_EXPIRY_LEAD_DAYS,
      );
      for (const doc of expiring) {
        // This scan runs every 15 minutes, so the key has to survive repetition: one
        // notification per document per expiry date. A renewed document carries a new
        // expiry and so legitimately warns again the next time it comes due.
        this.notificationDispatch.emitSafe({
          type: 'ASSAYER_DOCUMENT_EXPIRING',
          entityType: 'ASSAYER',
          entityId: doc.assayerId,
          assayerId: doc.assayerId,
          dedupeKey: `ASSAYER_DOCUMENT_EXPIRING:${doc.id}:${doc.expiryDate}`,
          payload: {
            assayerName: doc.assayerName,
            documentName: doc.documentName,
            expiryDate: doc.expiryDate,
          },
        });
      }
      if (expiring.length > 0) {
        this.logger.log(`Flagged ${expiring.length} assayer document(s) expiring within ${SlaScannerWorker.DOCUMENT_EXPIRY_LEAD_DAYS} days.`);
      }
    });

    // The data-entry desk's stalled stages: unassigned packets, silent members,
    // undecided reviews, unshipped approved reports, stuck OCR, stale clarifications.
    await runPhase('desk escalation scan', () => this.deskEscalation.scan());

    // The feedback desk's response-time SLAs: items awaiting a first reply, or open
    // past their severity-scaled resolution clock.
    await runPhase('feedback escalation scan', () => this.feedbackEscalation.scan());

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

    if (failures.length > 0) {
      // Surface the tick as failed (so Bull records and retries it) while preserving that every
      // phase was attempted. AggregateError keeps each underlying cause for the logs.
      throw new AggregateError(
        failures.map((f) => f.error),
        `SLA scanner: ${failures.length} of 6 phases failed (${failures.map((f) => f.phase).join(', ')}).`,
      );
    }
  }
}
