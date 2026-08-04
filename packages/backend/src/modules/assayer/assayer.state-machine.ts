import { BadRequestException } from '@nestjs/common';
import { AssayerEntity } from './assayer.entity';
import { AssayerLifecycleStatus, AssayerStatus } from '@fapoms/shared';
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

const LIFECYCLE_TRANSITIONS: Record<string, string[]> = {
  [AssayerLifecycleStatus.INVITED]: [AssayerLifecycleStatus.DOCUMENT_VERIFICATION],
  [AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: [AssayerLifecycleStatus.BACKGROUND_VERIFICATION, AssayerLifecycleStatus.INACTIVE],
  [AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: [AssayerLifecycleStatus.TRAINING, AssayerLifecycleStatus.INACTIVE],
  [AssayerLifecycleStatus.TRAINING]: [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.INACTIVE],
  [AssayerLifecycleStatus.ACTIVE]: [AssayerLifecycleStatus.ON_LEAVE, AssayerLifecycleStatus.SUSPENDED, AssayerLifecycleStatus.INACTIVE, AssayerLifecycleStatus.RESIGNED],
  [AssayerLifecycleStatus.ON_LEAVE]: [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.INACTIVE],
  [AssayerLifecycleStatus.SUSPENDED]: [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.TERMINATED],
  [AssayerLifecycleStatus.INACTIVE]: [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.ARCHIVED],
  [AssayerLifecycleStatus.RESIGNED]: [AssayerLifecycleStatus.ARCHIVED],
  [AssayerLifecycleStatus.TERMINATED]: [AssayerLifecycleStatus.ARCHIVED],
};

function mapLifecycleToOperationalStatus(lifecycle: string): AssayerStatus {
  if (lifecycle === AssayerLifecycleStatus.ACTIVE || lifecycle === AssayerLifecycleStatus.ON_LEAVE) return AssayerStatus.ACTIVE;
  if (lifecycle === AssayerLifecycleStatus.SUSPENDED) return AssayerStatus.SUSPENDED;
  return AssayerStatus.INACTIVE;
}

export class AssayerStateMachine {
  /** Ordered path of lifecycle states from `from` to `target`, walking only
   *  allowed transitions (BFS). Returns [] when already there, or null when the
   *  target is unreachable through the state machine — used by bulk operations
   *  to walk a batch forward to a single destination without invalid jumps. */
  static findPathTo(from: string, target: string): string[] | null {
    if (from === target) return [];
    const queue: { stage: string; path: string[] }[] = [{ stage: from, path: [] }];
    const visited = new Set<string>([from]);
    while (queue.length) {
      const { stage, path } = queue.shift()!;
      for (const next of LIFECYCLE_TRANSITIONS[stage] ?? []) {
        if (next === target) return [...path, next];
        if (!visited.has(next)) {
          visited.add(next);
          queue.push({ stage: next, path: [...path, next] });
        }
      }
    }
    return null;
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
