import { BadRequestException } from '@nestjs/common';
import { ProjectEntity } from './project.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { ProjectStatus, ProjectBranchStatus } from '@fapoms/shared';
import {
  ProjectPlanningStartedEvent,
  ProjectSchedulingReadyEvent,
  ProjectExecutionStartedEvent,
  ProjectValidationStartedEvent,
  ProjectCompletedEvent,
  ProjectCancelledEvent,
  ProjectOnHoldEvent,
  ProjectArchivedEvent,
  ProjectBranchPlanningStartedEvent,
  ProjectBranchAssignmentConfirmedEvent,
  ProjectBranchAuditScheduledEvent,
  ProjectBranchAuditCompletedEvent,
  ProjectBranchValidationCompletedEvent,
  ProjectBranchClosedEvent,
  ProjectBranchUnableToCoverEvent,
  ProjectBranchCoverageReopenedEvent,
} from '../../core/events/domain-events';

export class ProjectStateMachine {
  static startPlanning(project: ProjectEntity, userId: string): ProjectPlanningStartedEvent {
    if (!project.isActive) {
      throw new BadRequestException('Cannot start planning on inactive project.');
    }
    if (project.status !== ProjectStatus.DRAFT) {
      throw new BadRequestException(`Cannot transition project from ${project.status} to PLANNING.`);
    }
    const prev = project.status;
    project.status = ProjectStatus.PLANNING;
    return new ProjectPlanningStartedEvent(project.id, prev, project.status, userId);
  }

  static readyForScheduling(project: ProjectEntity, userId: string): ProjectSchedulingReadyEvent {
    if (!project.isActive) {
      throw new BadRequestException('Cannot start scheduling on inactive project.');
    }
    // ON_HOLD is also accepted: resuming a paused project back into SCHEDULING is the same
    // transition as reaching it the first time from PLANNING.
    if (project.status !== ProjectStatus.PLANNING && project.status !== ProjectStatus.ON_HOLD) {
      throw new BadRequestException(`Cannot transition project from ${project.status} to SCHEDULING.`);
    }
    const prev = project.status;
    project.status = ProjectStatus.SCHEDULING;
    return new ProjectSchedulingReadyEvent(project.id, prev, project.status, userId);
  }

  static startExecution(project: ProjectEntity, userId: string): ProjectExecutionStartedEvent {
    if (!project.isActive) {
      throw new BadRequestException('Cannot start execution on inactive project.');
    }
    // ON_HOLD is also accepted: resuming a paused project back into EXECUTION is the same
    // transition as reaching it the first time from SCHEDULING.
    if (project.status !== ProjectStatus.SCHEDULING && project.status !== ProjectStatus.ON_HOLD) {
      throw new BadRequestException(`Cannot transition project from ${project.status} to EXECUTION.`);
    }
    const prev = project.status;
    project.status = ProjectStatus.EXECUTION;
    return new ProjectExecutionStartedEvent(project.id, prev, project.status, userId);
  }

  static startValidation(project: ProjectEntity, userId: string): ProjectValidationStartedEvent {
    if (!project.isActive) {
      throw new BadRequestException('Cannot start validation on inactive project.');
    }
    if (project.status !== ProjectStatus.EXECUTION) {
      throw new BadRequestException(`Cannot transition project from ${project.status} to VALIDATION.`);
    }
    const prev = project.status;
    project.status = ProjectStatus.VALIDATION;
    return new ProjectValidationStartedEvent(project.id, prev, project.status, userId);
  }

  static completeProject(project: ProjectEntity, userId: string): ProjectCompletedEvent {
    if (!project.isActive) {
      throw new BadRequestException('Cannot complete inactive project.');
    }
    if (project.status !== ProjectStatus.VALIDATION) {
      throw new BadRequestException(`Cannot transition project from ${project.status} to COMPLETED.`);
    }
    const prev = project.status;
    project.status = ProjectStatus.COMPLETED;
    return new ProjectCompletedEvent(project.id, prev, project.status, userId);
  }

  static cancelProject(project: ProjectEntity, userId: string): ProjectCancelledEvent {
    if (!project.isActive) {
      throw new BadRequestException('Cannot cancel inactive project.');
    }
    if (project.status === ProjectStatus.COMPLETED) {
      throw new BadRequestException('Cannot cancel a completed project.');
    }
    // ARCHIVED and CANCELLED are terminal. Without this an archived project could
    // be pulled back out into CANCELLED, undoing a closed record.
    if (project.status === ProjectStatus.ARCHIVED) {
      throw new BadRequestException('Cannot cancel an archived project.');
    }
    if (project.status === ProjectStatus.CANCELLED) {
      throw new BadRequestException('Project is already cancelled.');
    }
    const prev = project.status;
    project.status = ProjectStatus.CANCELLED;
    return new ProjectCancelledEvent(project.id, prev, project.status, userId);
  }

  static holdProject(project: ProjectEntity, userId: string): ProjectOnHoldEvent {
    if (!project.isActive) {
      throw new BadRequestException('Cannot put an inactive project on hold.');
    }
    if (project.status !== ProjectStatus.SCHEDULING && project.status !== ProjectStatus.EXECUTION) {
      throw new BadRequestException(`Cannot transition project from ${project.status} to ON_HOLD.`);
    }
    const prev = project.status;
    project.status = ProjectStatus.ON_HOLD;
    return new ProjectOnHoldEvent(project.id, prev, project.status, userId);
  }

  static archiveProject(project: ProjectEntity, userId: string): ProjectArchivedEvent {
    if (!project.isActive) {
      throw new BadRequestException('Cannot archive an inactive project.');
    }
    if (project.status !== ProjectStatus.COMPLETED) {
      throw new BadRequestException(`Cannot transition project from ${project.status} to ARCHIVED.`);
    }
    const prev = project.status;
    project.status = ProjectStatus.ARCHIVED;
    return new ProjectArchivedEvent(project.id, prev, project.status, userId);
  }
}

export class ProjectBranchStateMachine {
  static initiatePlanning(pb: ProjectBranchEntity, userId: string): ProjectBranchPlanningStartedEvent {
    if (!pb.isActive) {
      throw new BadRequestException('Cannot start planning on inactive branch link.');
    }
    const prev = pb.status;
    pb.status = ProjectBranchStatus.PLANNING;
    return new ProjectBranchPlanningStartedEvent(pb.id, prev, pb.status, userId);
  }

  static confirmAssignment(pb: ProjectBranchEntity, userId: string): ProjectBranchAssignmentConfirmedEvent {
    if (!pb.isActive) {
      throw new BadRequestException('Cannot confirm assignment on inactive branch link.');
    }
    const prev = pb.status;
    pb.status = ProjectBranchStatus.ASSIGNMENT_CONFIRMED;
    return new ProjectBranchAssignmentConfirmedEvent(pb.id, prev, pb.status, userId);
  }

  static scheduleAudit(pb: ProjectBranchEntity, userId: string): ProjectBranchAuditScheduledEvent {
    if (!pb.isActive) {
      throw new BadRequestException('Cannot schedule audit on inactive branch link.');
    }
    const prev = pb.status;
    pb.status = ProjectBranchStatus.SCHEDULED;
    return new ProjectBranchAuditScheduledEvent(pb.id, prev, pb.status, userId);
  }

  static completeAudit(pb: ProjectBranchEntity, userId: string): ProjectBranchAuditCompletedEvent {
    if (!pb.isActive) {
      throw new BadRequestException('Cannot complete audit on inactive branch link.');
    }
    const prev = pb.status;
    pb.status = ProjectBranchStatus.AUDIT_COMPLETED;
    return new ProjectBranchAuditCompletedEvent(pb.id, prev, pb.status, userId);
  }

  static completeValidation(pb: ProjectBranchEntity, userId: string): ProjectBranchValidationCompletedEvent {
    if (!pb.isActive) {
      throw new BadRequestException('Cannot complete validation on inactive branch link.');
    }
    const prev = pb.status;
    pb.status = ProjectBranchStatus.VALIDATION_COMPLETED;
    return new ProjectBranchValidationCompletedEvent(pb.id, prev, pb.status, userId);
  }

  /**
   * Record that this branch cannot be staffed.
   *
   * `UNABLE_TO_COVER` has existed in the enum, the assessment-status map, the notification
   * catalogue and the project KPI query since the beginning — but nothing ever set it, so no
   * branch has ever reached it. The practical effect was that a branch nobody could staff sat
   * in `IMPORTED` looking identical to one nobody had looked at yet, which is why 64 of 72
   * branches are indistinguishable today. A coverage failure is a real operational outcome
   * and needs to be recordable, with a reason, so it can be reported against an SLA.
   */
  static markUnableToCover(
    pb: ProjectBranchEntity,
    userId: string,
    reason: string,
  ): ProjectBranchUnableToCoverEvent {
    if (!pb.isActive) {
      throw new BadRequestException('Cannot mark an inactive branch link as unable to cover.');
    }
    if (!reason || !reason.trim()) {
      // A coverage failure without a stated cause is not reportable, and this status exists
      // precisely so the cause is on the record.
      throw new BadRequestException('A reason is required when marking a branch unable to cover.');
    }
    // Terminal and in-flight states are not coverage problems — a branch already audited or
    // closed cannot retroactively become unstaffable.
    const blocked: ProjectBranchStatus[] = [
      ProjectBranchStatus.AUDIT_COMPLETED,
      ProjectBranchStatus.VALIDATION_COMPLETED,
      ProjectBranchStatus.CLOSED,
      ProjectBranchStatus.CANCELLED,
    ];
    if (blocked.includes(pb.status)) {
      throw new BadRequestException(
        `Cannot mark a branch in ${pb.status} as unable to cover — the audit has already progressed past staffing.`,
      );
    }
    const prev = pb.status;
    pb.status = ProjectBranchStatus.UNABLE_TO_COVER;
    return new ProjectBranchUnableToCoverEvent(pb.id, prev, pb.status, userId);
  }

  /**
   * Put an uncoverable branch back into the planning pool — a new assayer became available,
   * the client relaxed a constraint, or the date moved.
   */
  static reopenCoverage(pb: ProjectBranchEntity, userId: string): ProjectBranchCoverageReopenedEvent {
    if (!pb.isActive) {
      throw new BadRequestException('Cannot reopen coverage on an inactive branch link.');
    }
    if (pb.status !== ProjectBranchStatus.UNABLE_TO_COVER) {
      throw new BadRequestException(
        `Only a branch marked UNABLE_TO_COVER can be reopened — this one is ${pb.status}.`,
      );
    }
    const prev = pb.status;
    pb.status = ProjectBranchStatus.PLANNING;
    return new ProjectBranchCoverageReopenedEvent(pb.id, prev, pb.status, userId);
  }

  static close(pb: ProjectBranchEntity, userId: string): ProjectBranchClosedEvent {
    if (!pb.isActive) {
      throw new BadRequestException('Cannot close inactive branch link.');
    }
    const prev = pb.status;
    pb.status = ProjectBranchStatus.CLOSED;
    return new ProjectBranchClosedEvent(pb.id, prev, pb.status, userId);
  }
}
