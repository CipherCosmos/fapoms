"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AssignmentStateMachine = void 0;
const common_1 = require("@nestjs/common");
const shared_1 = require("@fapoms/shared");
const domain_events_1 = require("../../core/events/domain-events");
class AssignmentStateMachine {
    static validateTransition(current, target) {
        const validPaths = {
            CREATED: ['ACCEPTED', 'REJECTED', 'CANCELLED', 'CANDIDATE_SELECTED'],
            CANDIDATE_SELECTED: ['CONTACT_INITIATED', 'CANCELLED'],
            CONTACT_INITIATED: ['NEGOTIATION', 'CANCELLED'],
            NEGOTIATION: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
            ACCEPTED: ['SCHEDULED', 'CANCELLED'],
            SCHEDULED: ['AUDIT_COMPLETED', 'CANCELLED'],
            AUDIT_COMPLETED: ['CLOSED', 'CANCELLED'],
        };
        const allowed = validPaths[current] || [];
        if (!allowed.includes(target)) {
            throw new common_1.BadRequestException(`Invalid transition path from '${current}' to '${target}'`);
        }
    }
    static selectCandidate(assignment, userId) {
        this.validateTransition(assignment.status, shared_1.AssignmentStatus.CANDIDATE_SELECTED);
        const prev = assignment.status;
        assignment.status = shared_1.AssignmentStatus.CANDIDATE_SELECTED;
        return new domain_events_1.AssignmentCandidateSelectedEvent(assignment.id, prev, assignment.status, userId);
    }
    static initiateContact(assignment, userId) {
        this.validateTransition(assignment.status, shared_1.AssignmentStatus.CONTACT_INITIATED);
        const prev = assignment.status;
        assignment.status = shared_1.AssignmentStatus.CONTACT_INITIATED;
        return new domain_events_1.AssignmentContactInitiatedEvent(assignment.id, prev, assignment.status, userId);
    }
    static negotiate(assignment, fee, userId) {
        this.validateTransition(assignment.status, shared_1.AssignmentStatus.NEGOTIATION);
        if (fee <= 0) {
            throw new common_1.BadRequestException('Agreed fee must be greater than zero.');
        }
        const prev = assignment.status;
        assignment.status = shared_1.AssignmentStatus.NEGOTIATION;
        assignment.proposedFee = fee;
        return new domain_events_1.AssignmentNegotiationStartedEvent(assignment.id, prev, assignment.status, userId, { fee });
    }
    static acceptOffer(assignment, userId, fee) {
        this.validateTransition(assignment.status, shared_1.AssignmentStatus.ACCEPTED);
        const prev = assignment.status;
        assignment.status = shared_1.AssignmentStatus.ACCEPTED;
        if (fee !== undefined) {
            if (fee <= 0)
                throw new common_1.BadRequestException('Fee must be greater than zero.');
            assignment.agreedFee = fee;
        }
        else {
            assignment.agreedFee = assignment.proposedFee;
        }
        return new domain_events_1.OfferAcceptedEvent(assignment.id, prev, assignment.status, userId);
    }
    static rejectOffer(assignment, userId, reason) {
        this.validateTransition(assignment.status, shared_1.AssignmentStatus.REJECTED);
        const prev = assignment.status;
        assignment.status = shared_1.AssignmentStatus.REJECTED;
        assignment.rejectReason = reason ?? 'Rejected';
        return new domain_events_1.OfferRejectedEvent(assignment.id, prev, assignment.status, userId, { reason });
    }
    static scheduleAudit(assignment, scheduledDate, userId) {
        this.validateTransition(assignment.status, shared_1.AssignmentStatus.SCHEDULED);
        const prev = assignment.status;
        assignment.status = shared_1.AssignmentStatus.SCHEDULED;
        assignment.scheduledDate = new Date(scheduledDate);
        return new domain_events_1.AuditScheduledEvent(assignment.id, prev, assignment.status, userId, { scheduledDate });
    }
    static completeAudit(assignment, userId) {
        this.validateTransition(assignment.status, shared_1.AssignmentStatus.AUDIT_COMPLETED);
        const prev = assignment.status;
        assignment.status = shared_1.AssignmentStatus.AUDIT_COMPLETED;
        assignment.completionDate = new Date();
        return new domain_events_1.AuditCompletedEvent(assignment.id, prev, assignment.status, userId);
    }
    static close(assignment, userId) {
        this.validateTransition(assignment.status, shared_1.AssignmentStatus.CLOSED);
        const prev = assignment.status;
        assignment.status = shared_1.AssignmentStatus.CLOSED;
        return new domain_events_1.AssignmentClosedEvent(assignment.id, prev, assignment.status, userId);
    }
    static cancel(assignment, userId, reason) {
        this.validateTransition(assignment.status, shared_1.AssignmentStatus.CANCELLED);
        const prev = assignment.status;
        assignment.status = shared_1.AssignmentStatus.CANCELLED;
        assignment.cancelReason = reason ?? 'Cancelled';
        return new domain_events_1.AssignmentCancelledEvent(assignment.id, prev, assignment.status, userId, { reason });
    }
}
exports.AssignmentStateMachine = AssignmentStateMachine;
//# sourceMappingURL=assignment.state-machine.js.map