import { OnModuleInit } from '@nestjs/common';
import { Queue } from 'bull';
export declare class DocumentModule implements OnModuleInit {
    private readonly dispatchQueue;
    private readonly logger;
    constructor(dispatchQueue: Queue);
    private static readonly CRON;
    onModuleInit(): Promise<void>;
}
