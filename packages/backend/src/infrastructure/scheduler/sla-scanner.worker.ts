import { Injectable, Logger } from '@nestjs/common';
import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { AssignmentService } from '../../modules/assignment/assignment.service';

@Injectable()
@Processor('sla-scanner')
export class SlaScannerWorker {
  private readonly logger = new Logger(SlaScannerWorker.name);

  constructor(private readonly assignmentService: AssignmentService) {}

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
  }
}
