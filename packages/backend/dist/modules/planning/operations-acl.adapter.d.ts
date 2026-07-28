import { WorkAllocation } from './operations-domain-contracts';
import { AssignmentEntity } from '../assignment/assignment.entity';
export declare class OperationsAntiCorruptionLayer {
    mapAssignmentToWorkAllocation(entity: AssignmentEntity): WorkAllocation;
}
