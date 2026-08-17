import { Injectable, Logger } from '@nestjs/common';
import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { RetentionService } from './retention.service';

/**
 * The Bull side of retention: one job, one call.
 *
 * Kept on its own queue rather than added as a seventh phase to the SLA scanner. The scanner runs
 * every fifteen minutes and its whole design rests on every phase staying cheap — a retention pass
 * can legitimately spend a minute deleting 50,000 rows across four tables, and putting that in
 * front of the SLA breach scan, the auto-decline sweep and the credential-expiry warnings would
 * make those late whenever there is a backlog to clear.
 *
 * (The SLA scanner's existing `location trail retention` phase is now redundant — see the note in
 * `RetentionModule`.)
 */
@Injectable()
@Processor('retention')
export class RetentionWorker {
  private readonly logger = new Logger(RetentionWorker.name);

  constructor(private readonly retention: RetentionService) {}

  @Process('purge')
  async purge(_job: Job): Promise<void> {
    try {
      await this.retention.runOnce();
    } catch (err) {
      // Re-thrown so Bull records the tick as failed and retries it. `runOnce` has already
      // contained the failure to the phase that caused it and completed the other three.
      this.logger.error(`Retention pass failed: ${(err as Error).message}`);
      throw err;
    }
  }
}
