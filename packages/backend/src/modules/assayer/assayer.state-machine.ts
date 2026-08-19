import { BadRequestException } from '@nestjs/common';
import { AssayerEntity } from './assayer.entity';
import { AssayerLifecycleStatus, AssayerStatus, ASSAYER_LIFECYCLE_TRANSITIONS, assayerLifecyclePath } from '@fapoms/shared';
import {
  AssayerDocumentVerificationStartedEvent,
  AssayerBackgroundCheckInitiatedEvent,
  AssayerTrainingStartedEvent,
  AssayerActivatedEvent,
  AssayerOnLeaveEvent,
  AssayerSuspendedEvent,
  AssayerDeactivatedEvent,
  AssayerResignedEvent,
  AssayerTerminatedEvent,
  AssayerArchivedEvent,
} from '../../core/events/domain-events';

/** The one lifecycle definition, shared with the frontend so the UI cannot offer an edge
 * this machine will refuse. See packages/shared/src/assayer-lifecycle.ts. */
const LIFECYCLE_TRANSITIONS = ASSAYER_LIFECYCLE_TRANSITIONS;

/**
 * The operational status planning reads, derived from the HR lifecycle.
 *
 * `ON_LEAVE` used to fold into ACTIVE. Every planner filters on this projection — the
 * recommendation engine, the day planner, the command centre's daily capacity, the operations
 * snapshot — so marking someone on leave in HR left them in the candidate pool and still
 * counted them as available capacity, while the roster showed them as not active. Two ways to
 * say "away", one of which the planner ignored.
 *
 * Leave now means not available. The dated rows in `leaves` remain the per-date check
 * (`ConstraintEvaluator.checkLeaves`) — they answer "is this person away on the 14th", which is
 * a different question from "is this person away at all".
 */
function mapLifecycleToOperationalStatus(lifecycle: string): AssayerStatus {
  if (lifecycle === AssayerLifecycleStatus.ACTIVE) return AssayerStatus.ACTIVE;
  if (lifecycle === AssayerLifecycleStatus.SUSPENDED) return AssayerStatus.SUSPENDED;
  return AssayerStatus.INACTIVE;
}

export class AssayerStateMachine {
  /**
   * Ordered path of lifecycle states from `from` to `target`, or null when the target is
   * unreachable — used by bulk operations to walk a batch to a single destination without
   * inventing edges.
   *
   * Delegates to the shared implementation, which the roster also uses to decide which bulk
   * targets to offer. This was a second, identical breadth-first search; keeping both meant the
   * screen could offer a destination the server would then decline to reach.
   */
  static findPathTo(from: string, target: string): string[] | null {
    return assayerLifecyclePath(from, target);
  }

  private static validateTransition(assayer: AssayerEntity, targetStatus: AssayerLifecycleStatus) {
    const currentStatus = assayer.lifecycleStatus;
    const allowed = LIFECYCLE_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(targetStatus)) {
      throw new BadRequestException(`Invalid lifecycle transition from '${currentStatus}' to '${targetStatus}'`);
    }
  }

  private static applyTransition(assayer: AssayerEntity, targetStatus: AssayerLifecycleStatus, userId: string) {
    assayer.lifecycleStatus = targetStatus;
    assayer.status = mapLifecycleToOperationalStatus(targetStatus);
    assayer.updatedBy = userId;
    if (targetStatus === AssayerLifecycleStatus.ARCHIVED) assayer.isActive = false;

    /**
     * Record the day someone left, on the way out.
     *
     * Leaving was recorded only in `lifecycleStatus`, while every count and filter of departures
     * reads `exitDate`/`terminationDate` — which nothing set. So the roster's "Exited" chip and
     * the workforce header's "0 exited" stayed at zero however many people left, and a resigned
     * assayer was counted in neither Active nor Exited while plainly showing RESIGNED on screen.
     *
     * An existing date is never overwritten: HR may already have entered the real last working
     * day, and that is better information than the day the record was updated.
     */
    if (targetStatus === AssayerLifecycleStatus.RESIGNED && !assayer.exitDate) {
      assayer.exitDate = new Date();
    }
    if (targetStatus === AssayerLifecycleStatus.TERMINATED && !assayer.terminationDate) {
      assayer.terminationDate = new Date();
    }
  }

  static verifyDocuments(assayer: AssayerEntity, userId: string): AssayerDocumentVerificationStartedEvent {
    this.validateTransition(assayer, AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
    const prev = assayer.lifecycleStatus;
    this.applyTransition(assayer, AssayerLifecycleStatus.DOCUMENT_VERIFICATION, userId);
    return new AssayerDocumentVerificationStartedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
  }

  static initiateBackgroundCheck(assayer: AssayerEntity, userId: string): AssayerBackgroundCheckInitiatedEvent {
    this.validateTransition(assayer, AssayerLifecycleStatus.BACKGROUND_VERIFICATION);
    const prev = assayer.lifecycleStatus;
    this.applyTransition(assayer, AssayerLifecycleStatus.BACKGROUND_VERIFICATION, userId);
    return new AssayerBackgroundCheckInitiatedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
  }

  static startTraining(assayer: AssayerEntity, userId: string): AssayerTrainingStartedEvent {
    this.validateTransition(assayer, AssayerLifecycleStatus.TRAINING);
    const prev = assayer.lifecycleStatus;
    this.applyTransition(assayer, AssayerLifecycleStatus.TRAINING, userId);
    return new AssayerTrainingStartedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
  }

  static activate(assayer: AssayerEntity, userId: string): AssayerActivatedEvent {
    this.validateTransition(assayer, AssayerLifecycleStatus.ACTIVE);
    const prev = assayer.lifecycleStatus;
    this.applyTransition(assayer, AssayerLifecycleStatus.ACTIVE, userId);
    return new AssayerActivatedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
  }

  static putOnLeave(assayer: AssayerEntity, userId: string): AssayerOnLeaveEvent {
    this.validateTransition(assayer, AssayerLifecycleStatus.ON_LEAVE);
    const prev = assayer.lifecycleStatus;
    this.applyTransition(assayer, AssayerLifecycleStatus.ON_LEAVE, userId);
    return new AssayerOnLeaveEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
  }

  static suspend(assayer: AssayerEntity, userId: string): AssayerSuspendedEvent {
    this.validateTransition(assayer, AssayerLifecycleStatus.SUSPENDED);
    const prev = assayer.lifecycleStatus;
    this.applyTransition(assayer, AssayerLifecycleStatus.SUSPENDED, userId);
    return new AssayerSuspendedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
  }

  static deactivate(assayer: AssayerEntity, userId: string): AssayerDeactivatedEvent {
    this.validateTransition(assayer, AssayerLifecycleStatus.INACTIVE);
    const prev = assayer.lifecycleStatus;
    this.applyTransition(assayer, AssayerLifecycleStatus.INACTIVE, userId);
    return new AssayerDeactivatedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
  }

  static acceptResignation(assayer: AssayerEntity, userId: string): AssayerResignedEvent {
    this.validateTransition(assayer, AssayerLifecycleStatus.RESIGNED);
    const prev = assayer.lifecycleStatus;
    this.applyTransition(assayer, AssayerLifecycleStatus.RESIGNED, userId);
    return new AssayerResignedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
  }

  static terminate(assayer: AssayerEntity, userId: string): AssayerTerminatedEvent {
    this.validateTransition(assayer, AssayerLifecycleStatus.TERMINATED);
    const prev = assayer.lifecycleStatus;
    this.applyTransition(assayer, AssayerLifecycleStatus.TERMINATED, userId);
    return new AssayerTerminatedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
  }

  static archive(assayer: AssayerEntity, userId: string): AssayerArchivedEvent {
    this.validateTransition(assayer, AssayerLifecycleStatus.ARCHIVED);
    const prev = assayer.lifecycleStatus;
    this.applyTransition(assayer, AssayerLifecycleStatus.ARCHIVED, userId);
    return new AssayerArchivedEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
  }
}
