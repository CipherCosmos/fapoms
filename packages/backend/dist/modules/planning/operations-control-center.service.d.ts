import { Repository } from 'typeorm';
import { OperationsTaskEntity, OperationsTaskPriority } from './operations-task.entity';
import { OperationsExceptionEntity, OperationsExceptionCategory } from './operations-exception.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectMetricsProvider } from './operations-providers.interface';
export interface ControlCenterDashboardData {
    totalProjects: number;
    activeProjects: number;
    overallCoveragePercentage: number;
    overallDeploymentPercentage: number;
    assignmentAcceptancePercentage: number;
    pendingAssignmentsCount: number;
    delayedBranchesCount: number;
    criticalTasksCount: number;
    projectsAtRiskCount: number;
}
export declare class OperationsControlCenterService {
    private readonly taskRepository;
    private readonly exceptionRepository;
    private readonly assignmentRepository;
    private readonly metricsProvider;
    constructor(taskRepository: Repository<OperationsTaskEntity>, exceptionRepository: Repository<OperationsExceptionEntity>, assignmentRepository: Repository<AssignmentEntity>, metricsProvider: ProjectMetricsProvider);
    getDashboardSummary(): Promise<ControlCenterDashboardData>;
    createOperationsTask(projectId: string, title: string, reason: string, priority: OperationsTaskPriority): Promise<OperationsTaskEntity>;
    resolveOperationsTask(taskId: string, justification: string): Promise<OperationsTaskEntity>;
    flagException(projectId: string, category: OperationsExceptionCategory, message: string, targetEntityId?: string): Promise<OperationsExceptionEntity>;
    resolveException(exceptionId: string, justification: string): Promise<OperationsExceptionEntity>;
}
