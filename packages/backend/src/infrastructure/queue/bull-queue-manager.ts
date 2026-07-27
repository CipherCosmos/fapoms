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
      removeOnComplete: false,
      removeOnFail: false,
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
