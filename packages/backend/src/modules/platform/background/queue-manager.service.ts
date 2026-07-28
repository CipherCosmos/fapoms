import { Injectable } from '@nestjs/common';
import { BackgroundQueueManager, JobConfig, JobHandler } from './queue-manager.interface';

@Injectable()
export class InMemoryQueueManager implements BackgroundQueueManager {
  private workers: Record<string, JobHandler> = {};

  async enqueue(job: JobConfig): Promise<string> {
    const jobId = `job-${Math.random().toString(36).substring(2, 9)}`;
    const handler = this.workers[job.name];
    if (handler) {
      // Execute asynchronously in background thread context
      setTimeout(async () => {
        try {
          await handler(job.payload);
        } catch (err) {
          console.error(`Background job ${job.name} execution failed:`, err);
        }
      }, 0);
    }
    return jobId;
  }

  registerWorker(jobName: string, handler: JobHandler): void {
    this.workers[jobName] = handler;
  }
}
