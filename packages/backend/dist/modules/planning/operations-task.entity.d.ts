import { BaseEntity } from '../../core/entities/base.entity';
export declare enum OperationsTaskPriority {
    LOW = "LOW",
    MEDIUM = "MEDIUM",
    HIGH = "HIGH",
    CRITICAL = "CRITICAL"
}
export declare enum OperationsTaskStatus {
    OPEN = "OPEN",
    IN_PROGRESS = "IN_PROGRESS",
    RESOLVED = "RESOLVED",
    DISMISSED = "DISMISSED"
}
export declare class OperationsTaskEntity extends BaseEntity {
    projectId: string;
    title: string;
    reason: string;
    priority: OperationsTaskPriority;
    status: OperationsTaskStatus;
    dueTime: Date | null;
    ownerId: string | null;
    resolutionJustification: string | null;
}
