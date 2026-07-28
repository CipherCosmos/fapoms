import { BaseEntity } from '../../core/entities/base.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
export declare enum ExecutionGroupStatus {
    DRAFT = "DRAFT",
    DISPATCHED = "DISPATCHED",
    ACCEPTED = "ACCEPTED",
    DECLINED = "DECLINED",
    CONFIRMED = "CONFIRMED",
    READY = "READY",
    COMPLETED = "COMPLETED",
    CANCELLED = "CANCELLED"
}
export declare class OperationsExecutionGroupEntity extends BaseEntity {
    assayerId: string;
    name: string | null;
    status: ExecutionGroupStatus;
    totalFee: number;
    logisticsPreferences: any;
    assignments: AssignmentEntity[];
}
