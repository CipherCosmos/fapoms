import { DataSource } from 'typeorm';
import { OperationsSnapshotService } from './operations-snapshot.service';
export declare class SystemDashboardController {
    private readonly dataSource;
    private readonly operationsSnapshot;
    constructor(dataSource: DataSource, operationsSnapshot: OperationsSnapshotService);
    getOperations(req: any): Promise<{
        success: boolean;
        data: any;
    }>;
    getMetrics(): Promise<{
        success: boolean;
        data: {
            clients: number;
            projects: number;
            activeProjects: number;
            branches: number;
            activeBranches: number;
            users: number;
            activities: any;
        };
    }>;
}
