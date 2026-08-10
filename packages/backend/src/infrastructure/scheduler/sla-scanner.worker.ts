import { Injectable, Logger } from '@nestjs/common';
import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { AssignmentService } from '../../modules/assignment/assignment.service';
import { HrWorkforceService } from '../../modules/assayer/hr-workforce.service';
import { NotificationDispatchService } from '../../modules/notifications/notification-dispatch.service';
import { DeskEscalationService } from '../../modules/validation/desk-escalation.service';

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
  ) {}

  @Process('scan')
  async runScan(job: Job) {
    try {
      const breachedCount = await this.assignmentService.checkSlaBreaches();
      if (breachedCount > 0) {
        this.logger.log(`SLA scan complete. Flagged ${breachedCount} breached assignments.`);
      }
    } catch (err) {
      this.logger.error('Error during periodic SLA scan:', err);
      throw err;
    }

    try {
      const declinedCount = await this.assignmentService.autoDeclineExpiredOffers();
      if (declinedCount > 0) {
        this.logger.log(`Auto-declined ${declinedCount} assignment offer(s) with no response within the SLA window.`);
      }
    } catch (err) {
      this.logger.error('Error during periodic auto-decline scan:', err);
      throw err;
    }

    try {
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
    } catch (err) {
      this.logger.error('Error during periodic document expiry scan:', err);
      throw err;
    }

    // The data-entry desk's stalled stages: unassigned packets, silent members,
    // undecided reviews, unshipped approved reports, stuck OCR, stale clarifications.
    try {
      await this.deskEscalation.scan();
    } catch (err) {
      this.logger.error('Error during desk escalation scan:', err);
      throw err;
    }
  }
}
