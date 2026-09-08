import { BadRequestException } from '@nestjs/common';
import { AssayerEntity } from './assayer.entity';
import { AssayerLifecycleStatus, AssayerStatus, ASSAYER_LIFECYCLE_TRANSITIONS, assayerLifecyclePath, operationalStatusFor } from '@fapoms/shared';
import {
  DomainEvent,
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
    // Derived, not decided. `AssayerEntity.deriveOperationalStatus` applies the same rule on
    // every save, so this is belt-and-braces for a caller that inspects the entity before it is
    // persisted — the two must never be able to disagree.
    assayer.status = operationalStatusFor(targetStatus) as AssayerStatus;
    assayer.updatedBy = userId;
    assayer.isActive = targetStatus !== AssayerLifecycleStatus.ARCHIVED;

    /**
     * Departure dates are deliberately NOT stamped here any more.
     *
     * They used to be — RESIGNED set `exitDate`, TERMINATED set `terminationDate` — and the
     * service's `reconcileDepartureDates` then stamped whatever was still missing. Two writers
     * for one column, and the split defeated the service's own guard: by the time reconcile ran,
     * this method had already filled `exitDate`, so reconcile recorded no correction, skipped
     * `assertEmploymentDatesArePossible`, and a resignation stamped onto somebody whose joining
     * date lies in the future sailed through — the exact impossible pair the guard exists to
     * refuse. It also silenced the audit remark ("exit date recorded as …"), because the remark
     * only names corrections reconcile itself made.
     *
     * `reconcileDepartureDates` (assayer.service.ts) is now the single writer: it stamps BOTH
     * dates on the way out, asserts the result is a possible pair, and puts what it did on the
     * record. This method changes status only.
     */
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

  /**
   * Re-entering the workforce after resigning or being terminated (2026-09-07).
   *
   * What makes RESIGNED/TERMINATED → INVITED legal at all is the shared lifecycle map
   * (`@fapoms/shared/assayer-lifecycle.ts`) — see its own comment on why a rehire restarts
   * onboarding from INVITED rather than snapping straight back to ACTIVE. This method only
   * validates and applies that edge, exactly like every other method on this class.
   *
   * Departure dates are NOT cleared here, for the same reason `applyTransition` above stamps no
   * dates for any move: `AssayerService.reconcileDepartureDates` is the single writer for
   * `exit_date`/`termination_date`, and clearing them here too would be the same two-writers
   * defect that comment already describes for the outbound moves.
   *
   * Returns a plain `DomainEvent` rather than a new named subtype. Every subtype above exists
   * because something already publishes and, in principle, could listen for it; nothing listens
   * for a rehire yet. Add a dedicated `AssayerRehiredEvent` to `domain-events.ts` the day a real
   * consumer needs to tell this apart from another transition by type rather than by `newState`.
   */
  static rehire(assayer: AssayerEntity, userId: string): DomainEvent {
    this.validateTransition(assayer, AssayerLifecycleStatus.INVITED);
    const prev = assayer.lifecycleStatus;
    this.applyTransition(assayer, AssayerLifecycleStatus.INVITED, userId);
    return new DomainEvent(assayer.id, prev, assayer.lifecycleStatus, userId);
  }
}
