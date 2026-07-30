import { AssignmentEntity } from './assignment.entity';
import { AssignmentStatus } from '@fapoms/shared';
export declare class AssignmentStateMachine {
    private static readonly VALID_PATHS;
    private static validateTransition;
    static acceptOffer(assignment: AssignmentEntity, userId: string): {
        previousState: AssignmentStatus;
        newState: AssignmentStatus.ACCEPTED;
        userId: string;
    };
    static rejectOffer(assignment: AssignmentEntity, userId: string, reason?: string): {
        previousState: AssignmentStatus;
        newState: AssignmentStatus.REJECTED;
        userId: string;
    };
    static cancel(assignment: AssignmentEntity, userId: string, reason?: string): {
        previousState: AssignmentStatus;
        newState: AssignmentStatus.CANCELLED;
        userId: string;
    };
}
