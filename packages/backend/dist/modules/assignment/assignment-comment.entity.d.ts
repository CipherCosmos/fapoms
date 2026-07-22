import { BaseEntity } from '../../core/entities/base.entity';
import { AssignmentEntity } from './assignment.entity';
export declare class AssignmentCommentEntity extends BaseEntity {
    assignmentId: string;
    userId: string;
    userName: string;
    comment: string;
    assignment: AssignmentEntity;
}
