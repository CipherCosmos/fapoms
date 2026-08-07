export class DomainEvent {
  readonly aggregateId: string;
  readonly previousState: string;
  readonly newState: string;
  readonly timestamp: Date;
  readonly userId: string;
  readonly metadata?: any;

  constructor(
    aggregateId: string,
    previousState: string,
    newState: string,
    userId: string,
    metadata?: any,
  ) {
    this.aggregateId = aggregateId;
    this.previousState = previousState;
    this.newState = newState;
    this.userId = userId;
    this.timestamp = new Date();
    this.metadata = metadata;
  }
}

// Project Events
export class ProjectPlanningStartedEvent extends DomainEvent {}
export class ProjectSchedulingReadyEvent extends DomainEvent {}
export class ProjectExecutionStartedEvent extends DomainEvent {}
export class ProjectValidationStartedEvent extends DomainEvent {}
export class ProjectCompletedEvent extends DomainEvent {}
export class ProjectCancelledEvent extends DomainEvent {}
export class ProjectOnHoldEvent extends DomainEvent {}
export class ProjectArchivedEvent extends DomainEvent {}

// Project Branch Events
export class ProjectBranchPlanningStartedEvent extends DomainEvent {}
export class ProjectBranchAssignmentConfirmedEvent extends DomainEvent {}
export class ProjectBranchAuditScheduledEvent extends DomainEvent {}
export class ProjectBranchAuditCompletedEvent extends DomainEvent {}
export class ProjectBranchValidationCompletedEvent extends DomainEvent {}
export class ProjectBranchClosedEvent extends DomainEvent {}
/** Ops has concluded this branch cannot be staffed. See ProjectBranchStateMachine.markUnableToCover. */
export class ProjectBranchUnableToCoverEvent extends DomainEvent {}
/** A previously uncoverable branch is back in play. */
export class ProjectBranchCoverageReopenedEvent extends DomainEvent {}

// Assignment Events
export class AssignmentCandidateSelectedEvent extends DomainEvent {}
export class AssignmentContactInitiatedEvent extends DomainEvent {}
export class AssignmentNegotiationStartedEvent extends DomainEvent {}
export class OfferAcceptedEvent extends DomainEvent {}
export class OfferRejectedEvent extends DomainEvent {}
export class AuditScheduledEvent extends DomainEvent {}
export class AuditCompletedEvent extends DomainEvent {}
export class AssignmentClosedEvent extends DomainEvent {}
export class AssignmentCancelledEvent extends DomainEvent {}

// Validation Events
export class ValidationApprovedEvent extends DomainEvent {}
export class ValidationCorrectionRequestedEvent extends DomainEvent {}
export class ValidationSubmittedEvent extends DomainEvent {}
export class ValidationMovedToReviewEvent extends DomainEvent {}

// Assayer Events
export class AssayerDocumentVerificationStartedEvent extends DomainEvent {}
export class AssayerBackgroundCheckInitiatedEvent extends DomainEvent {}
export class AssayerTrainingStartedEvent extends DomainEvent {}
export class AssayerActivatedEvent extends DomainEvent {}
export class AssayerOnLeaveEvent extends DomainEvent {}
export class AssayerSuspendedEvent extends DomainEvent {}
export class AssayerDeactivatedEvent extends DomainEvent {}
export class AssayerResignedEvent extends DomainEvent {}
export class AssayerTerminatedEvent extends DomainEvent {}
export class AssayerArchivedEvent extends DomainEvent {}
