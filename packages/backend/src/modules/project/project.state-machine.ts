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
  ProjectBranchPlanningStartedEvent,
  ProjectBranchAssignmentConfirmedEvent,
  ProjectBranchAuditScheduledEvent,
  ProjectBranchAuditCompletedEvent,
  ProjectBranchValidationCompletedEvent,
  ProjectBranchClosedEvent,
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
    if (project.status !== ProjectStatus.PLANNING) {
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
    if (project.status !== ProjectStatus.SCHEDULING) {
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
    const prev = project.status;
    project.status = ProjectStatus.CANCELLED;
    return new ProjectCancelledEvent(project.id, prev, project.status, userId);
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

  static close(pb: ProjectBranchEntity, userId: string): ProjectBranchClosedEvent {
    if (!pb.isActive) {
      throw new BadRequestException('Cannot close inactive branch link.');
    }
    const prev = pb.status;
    pb.status = ProjectBranchStatus.CLOSED;
    return new ProjectBranchClosedEvent(pb.id, prev, pb.status, userId);
  }
}
