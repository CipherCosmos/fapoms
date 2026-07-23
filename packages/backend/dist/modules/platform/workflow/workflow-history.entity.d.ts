export declare class WorkflowHistoryEntity {
    id: string;
    workflowKey: string;
    entityId: string;
    previousState: string;
    newState: string;
    command: string;
    userId: string;
    timestamp: Date;
    correlationId: string;
}
