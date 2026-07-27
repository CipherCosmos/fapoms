import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { BullQueueManager } from './bull-queue-manager';

const QUEUE_NAME = 'background-jobs';

@Processor(QUEUE_NAME)
export class BullProcessor {
  private readonly logger = new Logger(BullProcessor.name);

  constructor(private readonly queueManager: BullQueueManager) {}

  @Process()
  async process(job: Job<{ name: string; payload: any }>) {
    const handler = this.queueManager.getHandler(job.name);
    if (!handler) {
      this.logger.warn(`No handler registered for job type: ${job.name}`);
      return;
    }

    this.logger.log(`Processing job ${job.id} of type ${job.name}`);
    try {
      await handler(job.data.payload);
      this.logger.log(`Job ${job.id} (${job.name}) completed successfully`);
    } catch (err) {
      this.logger.error(`Job ${job.id} (${job.name}) failed: ${err.message}`);
      throw err;
    }
  }
}
