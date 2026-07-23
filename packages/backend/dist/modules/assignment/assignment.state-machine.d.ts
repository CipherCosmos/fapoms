import { AssignmentEntity } from './assignment.entity';
import { AssignmentCandidateSelectedEvent, AssignmentContactInitiatedEvent, AssignmentNegotiationStartedEvent, OfferAcceptedEvent, OfferRejectedEvent, AuditScheduledEvent, AuditCompletedEvent, AssignmentClosedEvent, AssignmentCancelledEvent } from '../../core/events/domain-events';
export declare class AssignmentStateMachine {
    private static validateTransition;
    static selectCandidate(assignment: AssignmentEntity, userId: string): AssignmentCandidateSelectedEvent;
    static initiateContact(assignment: AssignmentEntity, userId: string): AssignmentContactInitiatedEvent;
    static negotiate(assignment: AssignmentEntity, fee: number, userId: string): AssignmentNegotiationStartedEvent;
    static acceptOffer(assignment: AssignmentEntity, userId: string, fee?: number): OfferAcceptedEvent;
    static rejectOffer(assignment: AssignmentEntity, userId: string, reason?: string): OfferRejectedEvent;
    static scheduleAudit(assignment: AssignmentEntity, scheduledDate: string, userId: string): AuditScheduledEvent;
    static completeAudit(assignment: AssignmentEntity, userId: string): AuditCompletedEvent;
    static close(assignment: AssignmentEntity, userId: string): AssignmentClosedEvent;
    static cancel(assignment: AssignmentEntity, userId: string, reason?: string): AssignmentCancelledEvent;
}
