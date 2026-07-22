import { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { AssignmentService } from '../../modules/assignment/assignment.service';
export declare class SlaScannerWorker implements OnModuleInit, OnModuleDestroy {
    private readonly assignmentService;
    private timer;
    constructor(assignmentService: AssignmentService);
    onModuleInit(): void;
    private runScan;
    onModuleDestroy(): void;
}
