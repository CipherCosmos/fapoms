import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { BackgroundQueueManager, JobConfig, JobHandler } from '../../modules/platform/background/queue-manager.interface';

const QUEUE_NAME = 'background-jobs';

@Injectable()
export class BullQueueManager implements BackgroundQueueManager {
  private readonly logger = new Logger(BullQueueManager.name);
  private handlers = new Map<string, JobHandler>();

  constructor(
    @InjectQueue(QUEUE_NAME) private readonly queue: Queue,
  ) {}

  async enqueue(job: JobConfig): Promise<string> {
    const bullJob = await this.queue.add(job.name, job.payload, {
      priority: job.priority ?? 0,
      attempts: job.retryAttempts ?? 3,
      backoff: { type: 'exponential', delay: 1000 },
      /**
       * Retention, not "keep everything forever".
       *
       * `false` on both meant every job this queue ever ran stayed in Redis — the completed set
       * and the failed set growing without bound on the same instance that holds the cache, the
       * rate-limit counters and every other queue. Redis now runs with `maxmemory` and
       * `noeviction` in production, so an unbounded set does not silently evict a cache key: it
       * refuses writes. Keep a day of successes and a week of failures, which is long enough to
       * investigate one and short enough to bound the memory.
       */
      removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 500 },
    });
    this.logger.log(`Enqueued job ${job.name} with id ${bullJob.id}`);
    return bullJob.id!.toString();
  }

  registerWorker(jobName: string, handler: JobHandler): void {
    this.handlers.set(jobName, handler);
    this.logger.log(`Registered worker for job type: ${jobName}`);
  }

  getHandler(jobName: string): JobHandler | undefined {
    return this.handlers.get(jobName);
  }
}
