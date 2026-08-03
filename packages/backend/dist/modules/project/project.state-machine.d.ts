import { ProjectEntity } from './project.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { ProjectPlanningStartedEvent, ProjectSchedulingReadyEvent, ProjectExecutionStartedEvent, ProjectValidationStartedEvent, ProjectCompletedEvent, ProjectCancelledEvent, ProjectOnHoldEvent, ProjectArchivedEvent, ProjectBranchPlanningStartedEvent, ProjectBranchAssignmentConfirmedEvent, ProjectBranchAuditScheduledEvent, ProjectBranchAuditCompletedEvent, ProjectBranchValidationCompletedEvent, ProjectBranchClosedEvent } from '../../core/events/domain-events';
export declare class ProjectStateMachine {
    static startPlanning(project: ProjectEntity, userId: string): ProjectPlanningStartedEvent;
    static readyForScheduling(project: ProjectEntity, userId: string): ProjectSchedulingReadyEvent;
    static startExecution(project: ProjectEntity, userId: string): ProjectExecutionStartedEvent;
    static startValidation(project: ProjectEntity, userId: string): ProjectValidationStartedEvent;
    static completeProject(project: ProjectEntity, userId: string): ProjectCompletedEvent;
    static cancelProject(project: ProjectEntity, userId: string): ProjectCancelledEvent;
    static holdProject(project: ProjectEntity, userId: string): ProjectOnHoldEvent;
    static archiveProject(project: ProjectEntity, userId: string): ProjectArchivedEvent;
}
export declare class ProjectBranchStateMachine {
    static initiatePlanning(pb: ProjectBranchEntity, userId: string): ProjectBranchPlanningStartedEvent;
    static confirmAssignment(pb: ProjectBranchEntity, userId: string): ProjectBranchAssignmentConfirmedEvent;
    static scheduleAudit(pb: ProjectBranchEntity, userId: string): ProjectBranchAuditScheduledEvent;
    static completeAudit(pb: ProjectBranchEntity, userId: string): ProjectBranchAuditCompletedEvent;
    static completeValidation(pb: ProjectBranchEntity, userId: string): ProjectBranchValidationCompletedEvent;
    static close(pb: ProjectBranchEntity, userId: string): ProjectBranchClosedEvent;
}
