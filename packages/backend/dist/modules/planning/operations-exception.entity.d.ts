import { BaseEntity } from '../../core/entities/base.entity';
export declare enum OperationsExceptionCategory {
    UNCOVERABLE_BRANCH = "UNCOVERABLE_BRANCH",
    CAPACITY_EXCEEDED = "CAPACITY_EXCEEDED",
    SCHEDULE_CONFLICT = "SCHEDULE_CONFLICT",
    COMMERCIAL_DISCREPANCY = "COMMERCIAL_DISCREPANCY",
    CERTIFICATION_EXPIRED = "CERTIFICATION_EXPIRED",
    ROUTE_UNREACHABLE = "ROUTE_UNREACHABLE"
}
export declare enum OperationsExceptionStatus {
    UNRESOLVED = "UNRESOLVED",
    RESOLVED = "RESOLVED",
    BYPASSED = "BYPASSED"
}
export declare class OperationsExceptionEntity extends BaseEntity {
    projectId: string;
    targetEntityId: string | null;
    category: OperationsExceptionCategory;
    status: OperationsExceptionStatus;
    message: string;
    overrideJustification: string | null;
}
