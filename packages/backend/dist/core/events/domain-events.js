"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AssayerArchivedEvent = exports.AssayerTerminatedEvent = exports.AssayerResignedEvent = exports.AssayerDeactivatedEvent = exports.AssayerSuspendedEvent = exports.AssayerOnLeaveEvent = exports.AssayerActivatedEvent = exports.AssayerTrainingStartedEvent = exports.AssayerBackgroundCheckInitiatedEvent = exports.AssayerDocumentVerificationStartedEvent = exports.ValidationSubmittedEvent = exports.ValidationCorrectionRequestedEvent = exports.ValidationApprovedEvent = exports.AssignmentCancelledEvent = exports.AssignmentClosedEvent = exports.AuditCompletedEvent = exports.AuditScheduledEvent = exports.OfferRejectedEvent = exports.OfferAcceptedEvent = exports.AssignmentNegotiationStartedEvent = exports.AssignmentContactInitiatedEvent = exports.AssignmentCandidateSelectedEvent = exports.ProjectBranchClosedEvent = exports.ProjectBranchValidationCompletedEvent = exports.ProjectBranchAuditCompletedEvent = exports.ProjectBranchAuditScheduledEvent = exports.ProjectBranchAssignmentConfirmedEvent = exports.ProjectBranchPlanningStartedEvent = exports.ProjectCancelledEvent = exports.ProjectCompletedEvent = exports.ProjectValidationStartedEvent = exports.ProjectExecutionStartedEvent = exports.ProjectSchedulingReadyEvent = exports.ProjectPlanningStartedEvent = exports.DomainEvent = void 0;
class DomainEvent {
    aggregateId;
    previousState;
    newState;
    timestamp;
    userId;
    metadata;
    constructor(aggregateId, previousState, newState, userId, metadata) {
        this.aggregateId = aggregateId;
        this.previousState = previousState;
        this.newState = newState;
        this.userId = userId;
        this.timestamp = new Date();
        this.metadata = metadata;
    }
}
exports.DomainEvent = DomainEvent;
class ProjectPlanningStartedEvent extends DomainEvent {
}
exports.ProjectPlanningStartedEvent = ProjectPlanningStartedEvent;
class ProjectSchedulingReadyEvent extends DomainEvent {
}
exports.ProjectSchedulingReadyEvent = ProjectSchedulingReadyEvent;
class ProjectExecutionStartedEvent extends DomainEvent {
}
exports.ProjectExecutionStartedEvent = ProjectExecutionStartedEvent;
class ProjectValidationStartedEvent extends DomainEvent {
}
exports.ProjectValidationStartedEvent = ProjectValidationStartedEvent;
class ProjectCompletedEvent extends DomainEvent {
}
exports.ProjectCompletedEvent = ProjectCompletedEvent;
class ProjectCancelledEvent extends DomainEvent {
}
exports.ProjectCancelledEvent = ProjectCancelledEvent;
class ProjectBranchPlanningStartedEvent extends DomainEvent {
}
exports.ProjectBranchPlanningStartedEvent = ProjectBranchPlanningStartedEvent;
class ProjectBranchAssignmentConfirmedEvent extends DomainEvent {
}
exports.ProjectBranchAssignmentConfirmedEvent = ProjectBranchAssignmentConfirmedEvent;
class ProjectBranchAuditScheduledEvent extends DomainEvent {
}
exports.ProjectBranchAuditScheduledEvent = ProjectBranchAuditScheduledEvent;
class ProjectBranchAuditCompletedEvent extends DomainEvent {
}
exports.ProjectBranchAuditCompletedEvent = ProjectBranchAuditCompletedEvent;
class ProjectBranchValidationCompletedEvent extends DomainEvent {
}
exports.ProjectBranchValidationCompletedEvent = ProjectBranchValidationCompletedEvent;
class ProjectBranchClosedEvent extends DomainEvent {
}
exports.ProjectBranchClosedEvent = ProjectBranchClosedEvent;
class AssignmentCandidateSelectedEvent extends DomainEvent {
}
exports.AssignmentCandidateSelectedEvent = AssignmentCandidateSelectedEvent;
class AssignmentContactInitiatedEvent extends DomainEvent {
}
exports.AssignmentContactInitiatedEvent = AssignmentContactInitiatedEvent;
class AssignmentNegotiationStartedEvent extends DomainEvent {
}
exports.AssignmentNegotiationStartedEvent = AssignmentNegotiationStartedEvent;
class OfferAcceptedEvent extends DomainEvent {
}
exports.OfferAcceptedEvent = OfferAcceptedEvent;
class OfferRejectedEvent extends DomainEvent {
}
exports.OfferRejectedEvent = OfferRejectedEvent;
class AuditScheduledEvent extends DomainEvent {
}
exports.AuditScheduledEvent = AuditScheduledEvent;
class AuditCompletedEvent extends DomainEvent {
}
exports.AuditCompletedEvent = AuditCompletedEvent;
class AssignmentClosedEvent extends DomainEvent {
}
exports.AssignmentClosedEvent = AssignmentClosedEvent;
class AssignmentCancelledEvent extends DomainEvent {
}
exports.AssignmentCancelledEvent = AssignmentCancelledEvent;
class ValidationApprovedEvent extends DomainEvent {
}
exports.ValidationApprovedEvent = ValidationApprovedEvent;
class ValidationCorrectionRequestedEvent extends DomainEvent {
}
exports.ValidationCorrectionRequestedEvent = ValidationCorrectionRequestedEvent;
class ValidationSubmittedEvent extends DomainEvent {
}
exports.ValidationSubmittedEvent = ValidationSubmittedEvent;
class AssayerDocumentVerificationStartedEvent extends DomainEvent {
}
exports.AssayerDocumentVerificationStartedEvent = AssayerDocumentVerificationStartedEvent;
class AssayerBackgroundCheckInitiatedEvent extends DomainEvent {
}
exports.AssayerBackgroundCheckInitiatedEvent = AssayerBackgroundCheckInitiatedEvent;
class AssayerTrainingStartedEvent extends DomainEvent {
}
exports.AssayerTrainingStartedEvent = AssayerTrainingStartedEvent;
class AssayerActivatedEvent extends DomainEvent {
}
exports.AssayerActivatedEvent = AssayerActivatedEvent;
class AssayerOnLeaveEvent extends DomainEvent {
}
exports.AssayerOnLeaveEvent = AssayerOnLeaveEvent;
class AssayerSuspendedEvent extends DomainEvent {
}
exports.AssayerSuspendedEvent = AssayerSuspendedEvent;
class AssayerDeactivatedEvent extends DomainEvent {
}
exports.AssayerDeactivatedEvent = AssayerDeactivatedEvent;
class AssayerResignedEvent extends DomainEvent {
}
exports.AssayerResignedEvent = AssayerResignedEvent;
class AssayerTerminatedEvent extends DomainEvent {
}
exports.AssayerTerminatedEvent = AssayerTerminatedEvent;
class AssayerArchivedEvent extends DomainEvent {
}
exports.AssayerArchivedEvent = AssayerArchivedEvent;
//# sourceMappingURL=domain-events.js.map