import { Injectable, Logger } from '@nestjs/common';
import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { AuditSealService } from './audit-seal.service';

/**
 * The Bull side of audit sealing: seal newly-recorded events into the hash chain, every minute.
 *
 * A frequent, cheap tick on purpose — the more often it runs, the smaller the window in which a
 * just-recorded event is not yet tamper-evident. One pass appends at most a batch; if a backlog
 * exists (first run after this ships, or the sealer was down), it drains across ticks. The pass is
 * cluster-safe and idempotent, so a retry or a second replica cannot fork the chain.
 */
@Injectable()
@Processor('audit-seal')
export class AuditSealWorker {
  private readonly logger = new Logger(AuditSealWorker.name);

  constructor(private readonly seal: AuditSealService) {}

  @Process('seal')
  async seal_(_job: Job): Promise<void> {
    try {
      await this.seal.sealPending();
    } catch (err) {
      this.logger.error(`Audit seal pass failed: ${(err as Error).message}`);
      throw err;
    }
  }
}
