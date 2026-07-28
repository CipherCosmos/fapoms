import { BadRequestException } from '@nestjs/common';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentStatus } from '@fapoms/shared';
import {
  AssignmentCandidateSelectedEvent,
  AssignmentContactInitiatedEvent,
  AssignmentNegotiationStartedEvent,
  OfferAcceptedEvent,
  OfferRejectedEvent,
  AuditScheduledEvent,
  AuditCompletedEvent,
  AssignmentClosedEvent,
  AssignmentCancelledEvent,
} from '../../core/events/domain-events';

export class AssignmentStateMachine {
  private static validateTransition(current: AssignmentStatus, target: AssignmentStatus) {
    const validPaths: Record<string, string[]> = {
      CREATED: ['ACCEPTED', 'REJECTED', 'CANCELLED', 'CANDIDATE_SELECTED'],
      CANDIDATE_SELECTED: ['CONTACT_INITIATED', 'CANCELLED'],
      CONTACT_INITIATED: ['NEGOTIATION', 'ACCEPTED', 'REJECTED', 'CANCELLED'],
      NEGOTIATION: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
      ACCEPTED: ['SCHEDULED', 'CANCELLED'],
      SCHEDULED: ['AUDIT_COMPLETED', 'CANCELLED'],
      AUDIT_COMPLETED: ['CLOSED', 'CANCELLED'],
    };

    const allowed = validPaths[current] || [];
    if (!allowed.includes(target)) {
      throw new BadRequestException(`Invalid transition path from '${current}' to '${target}'`);
    }
  }

  static selectCandidate(assignment: AssignmentEntity, userId: string): AssignmentCandidateSelectedEvent {
    this.validateTransition(assignment.status, AssignmentStatus.CANDIDATE_SELECTED);
    const prev = assignment.status;
    assignment.status = AssignmentStatus.CANDIDATE_SELECTED;
    return new AssignmentCandidateSelectedEvent(assignment.id, prev, assignment.status, userId);
  }

  static initiateContact(assignment: AssignmentEntity, userId: string): AssignmentContactInitiatedEvent {
    this.validateTransition(assignment.status, AssignmentStatus.CONTACT_INITIATED);
    const prev = assignment.status;
    assignment.status = AssignmentStatus.CONTACT_INITIATED;
    return new AssignmentContactInitiatedEvent(assignment.id, prev, assignment.status, userId);
  }

  static negotiate(assignment: AssignmentEntity, fee: number, userId: string): AssignmentNegotiationStartedEvent {
    this.validateTransition(assignment.status, AssignmentStatus.NEGOTIATION);
    if (fee <= 0) {
      throw new BadRequestException('Agreed fee must be greater than zero.');
    }
    const prev = assignment.status;
    assignment.status = AssignmentStatus.NEGOTIATION;
    assignment.proposedFee = fee;
    return new AssignmentNegotiationStartedEvent(assignment.id, prev, assignment.status, userId, { fee });
  }

  static acceptOffer(assignment: AssignmentEntity, userId: string, fee?: number): OfferAcceptedEvent {
    this.validateTransition(assignment.status, AssignmentStatus.ACCEPTED);
    const prev = assignment.status;
    assignment.status = AssignmentStatus.ACCEPTED;
    if (fee !== undefined) {
      if (fee <= 0) throw new BadRequestException('Fee must be greater than zero.');
      assignment.agreedFee = fee;
    } else {
      assignment.agreedFee = assignment.proposedFee;
    }
    return new OfferAcceptedEvent(assignment.id, prev, assignment.status, userId);
  }

  static rejectOffer(assignment: AssignmentEntity, userId: string, reason?: string): OfferRejectedEvent {
    this.validateTransition(assignment.status, AssignmentStatus.REJECTED);
    const prev = assignment.status;
    assignment.status = AssignmentStatus.REJECTED;
    assignment.rejectReason = reason ?? 'Rejected';
    return new OfferRejectedEvent(assignment.id, prev, assignment.status, userId, { reason });
  }

  static scheduleAudit(assignment: AssignmentEntity, scheduledDate: string, userId: string): AuditScheduledEvent {
    this.validateTransition(assignment.status, AssignmentStatus.SCHEDULED);
    const prev = assignment.status;
    assignment.status = AssignmentStatus.SCHEDULED;
    assignment.scheduledDate = new Date(scheduledDate);
    return new AuditScheduledEvent(assignment.id, prev, assignment.status, userId, { scheduledDate });
  }

  static completeAudit(assignment: AssignmentEntity, userId: string): AuditCompletedEvent {
    this.validateTransition(assignment.status, AssignmentStatus.AUDIT_COMPLETED);
    const prev = assignment.status;
    assignment.status = AssignmentStatus.AUDIT_COMPLETED;
    assignment.completionDate = new Date();
    return new AuditCompletedEvent(assignment.id, prev, assignment.status, userId);
  }

  static close(assignment: AssignmentEntity, userId: string): AssignmentClosedEvent {
    this.validateTransition(assignment.status, AssignmentStatus.CLOSED);
    const prev = assignment.status;
    assignment.status = AssignmentStatus.CLOSED;
    return new AssignmentClosedEvent(assignment.id, prev, assignment.status, userId);
  }

  static cancel(assignment: AssignmentEntity, userId: string, reason?: string): AssignmentCancelledEvent {
    this.validateTransition(assignment.status, AssignmentStatus.CANCELLED);
    const prev = assignment.status;
    assignment.status = AssignmentStatus.CANCELLED;
    assignment.cancelReason = reason ?? 'Cancelled';
    return new AssignmentCancelledEvent(assignment.id, prev, assignment.status, userId, { reason });
  }
}
