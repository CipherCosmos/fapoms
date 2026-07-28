import { Job } from 'bull';
import { AssignmentService } from '../../modules/assignment/assignment.service';
export declare class SlaScannerWorker {
    private readonly assignmentService;
    private readonly logger;
    constructor(assignmentService: AssignmentService);
    runScan(job: Job): Promise<void>;
}
