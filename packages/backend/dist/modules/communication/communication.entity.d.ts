import { BaseEntity } from '../../core/entities/base.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { CommunicationType } from '@fapoms/shared';
export declare class CommunicationEntity extends BaseEntity {
    assignmentId: string;
    type: CommunicationType;
    content: string;
    initiatedBy: string;
    recipientRef: string | null;
    isDelivered: boolean;
    assignment: AssignmentEntity;
}
