import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { BullQueueManager } from './bull-queue-manager';

const QUEUE_NAME = 'background-jobs';

@Processor(QUEUE_NAME)
export class BullProcessor {
  private readonly logger = new Logger(BullProcessor.name);

  constructor(private readonly queueManager: BullQueueManager) {}

  /**
   * `'*'`, not the default, because `BullQueueManager.enqueue` adds NAMED jobs.
   *
   * Bull dispatches by job name: `handler = handlers[job.name] || handlers['*']`, and with no
   * handler it fails the job outright with "Missing process handler for job type <name>". An
   * unnamed `@Process()` registers under `__default__`, which a named job never matches — so
   * every job this queue ever received failed, retried to exhaustion and stayed in Redis, and
   * the only reason nobody noticed is that nothing in the application enqueues here yet. The
   * wildcard makes the generic facility work as its interface always claimed.
   *
   * `job.data.payload` matches what `enqueue` writes (`{ name, payload }`).
   */
  @Process('*')
  async process(job: Job<{ name: string; payload: any }>) {
    const handler = this.queueManager.getHandler(job.name);
    if (!handler) {
      // A queued job with no registered handler is a lost instruction, not a curiosity: the
      // producer believed the work would happen. Loud, and failed rather than silently dropped,
      // so it lands in the dead-letter monitor instead of disappearing with a warning.
      throw new Error(
        `No handler registered for job type "${job.name}". It was enqueued by a producer that ` +
          `expected it to run; register it with BullQueueManager.registerWorker at module init.`,
      );
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
