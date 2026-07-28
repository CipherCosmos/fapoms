export declare class TaskId {
    readonly value: string;
    constructor(value: string);
}
export declare enum TaskPriority {
    LOW = "LOW",
    MEDIUM = "MEDIUM",
    HIGH = "HIGH",
    CRITICAL = "CRITICAL"
}
export declare enum TaskStatus {
    OPEN = "OPEN",
    IN_PROGRESS = "IN_PROGRESS",
    RESOLVED = "RESOLVED",
    DISMISSED = "DISMISSED",
    BLOCKED = "BLOCKED"
}
export interface OperationsTaskCreatedEvent {
    eventId: string;
    occurredAt: string;
    aggregateId: string;
    aggregateVersion: number;
    taskId: string;
    projectId: string;
    priority: TaskPriority;
    createdBy: string;
    correlationId: string;
    causationId: string;
}
export interface WorkAllocation {
    allocationId: string;
    assayerId: string;
    agreedFee: number;
    status: string;
}
export interface WorkAssignmentCoordinator {
    spawnAssignmentsForApprovedPlan(planId: string, allocations: WorkAllocation[]): Promise<void>;
}
export interface ResourceAllocationProvider {
    getAvailableAssayerCapacity(assayerId: string): Promise<number>;
}
export interface OperationsControlServiceInterface {
    createTask(projectId: string, title: string, reason: string, priority: TaskPriority): Promise<any>;
    resolveTask(taskId: string, justification: string): Promise<any>;
}
