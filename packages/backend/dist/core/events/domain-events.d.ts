export declare class DomainEvent {
    readonly aggregateId: string;
    readonly previousState: string;
    readonly newState: string;
    readonly timestamp: Date;
    readonly userId: string;
    readonly metadata?: any;
    constructor(aggregateId: string, previousState: string, newState: string, userId: string, metadata?: any);
}
export declare class ProjectPlanningStartedEvent extends DomainEvent {
}
export declare class ProjectSchedulingReadyEvent extends DomainEvent {
}
export declare class ProjectExecutionStartedEvent extends DomainEvent {
}
export declare class ProjectValidationStartedEvent extends DomainEvent {
}
export declare class ProjectCompletedEvent extends DomainEvent {
}
export declare class ProjectCancelledEvent extends DomainEvent {
}
export declare class ProjectBranchPlanningStartedEvent extends DomainEvent {
}
export declare class ProjectBranchAssignmentConfirmedEvent extends DomainEvent {
}
export declare class ProjectBranchAuditScheduledEvent extends DomainEvent {
}
export declare class ProjectBranchAuditCompletedEvent extends DomainEvent {
}
export declare class ProjectBranchValidationCompletedEvent extends DomainEvent {
}
export declare class ProjectBranchClosedEvent extends DomainEvent {
}
export declare class AssignmentCandidateSelectedEvent extends DomainEvent {
}
export declare class AssignmentContactInitiatedEvent extends DomainEvent {
}
export declare class AssignmentNegotiationStartedEvent extends DomainEvent {
}
export declare class OfferAcceptedEvent extends DomainEvent {
}
export declare class OfferRejectedEvent extends DomainEvent {
}
export declare class AuditScheduledEvent extends DomainEvent {
}
export declare class AuditCompletedEvent extends DomainEvent {
}
export declare class AssignmentClosedEvent extends DomainEvent {
}
export declare class AssignmentCancelledEvent extends DomainEvent {
}
export declare class ValidationApprovedEvent extends DomainEvent {
}
export declare class ValidationCorrectionRequestedEvent extends DomainEvent {
}
export declare class ValidationSubmittedEvent extends DomainEvent {
}
export declare class AssayerDocumentVerificationStartedEvent extends DomainEvent {
}
export declare class AssayerBackgroundCheckInitiatedEvent extends DomainEvent {
}
export declare class AssayerTrainingStartedEvent extends DomainEvent {
}
export declare class AssayerActivatedEvent extends DomainEvent {
}
export declare class AssayerOnLeaveEvent extends DomainEvent {
}
export declare class AssayerSuspendedEvent extends DomainEvent {
}
export declare class AssayerDeactivatedEvent extends DomainEvent {
}
export declare class AssayerResignedEvent extends DomainEvent {
}
export declare class AssayerTerminatedEvent extends DomainEvent {
}
export declare class AssayerArchivedEvent extends DomainEvent {
}
