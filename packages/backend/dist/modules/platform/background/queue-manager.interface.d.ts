export interface JobConfig {
    name: string;
    payload: any;
    priority?: number;
    retryAttempts?: number;
}
export type JobHandler = (payload: any) => Promise<void>;
export interface BackgroundQueueManager {
    enqueue(job: JobConfig): Promise<string>;
    registerWorker(jobName: string, handler: JobHandler): void;
}
