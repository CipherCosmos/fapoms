import { BackgroundQueueManager, JobConfig, JobHandler } from './queue-manager.interface';
export declare class InMemoryQueueManager implements BackgroundQueueManager {
    private workers;
    enqueue(job: JobConfig): Promise<string>;
    registerWorker(jobName: string, handler: JobHandler): void;
}
