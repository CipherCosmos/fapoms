import { DataSource } from 'typeorm';
export declare class SystemDashboardController {
    private readonly dataSource;
    constructor(dataSource: DataSource);
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
