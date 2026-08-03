import { OnModuleInit } from '@nestjs/common';
import { Queue } from 'bull';
export declare class NotificationsModule implements OnModuleInit {
    private readonly queue;
    private readonly logger;
    private static readonly SWEEP_CRON;
    private static readonly ABANDONED_CRON;
    constructor(queue: Queue);
    onModuleInit(): Promise<void>;
}
