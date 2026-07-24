"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectBranchStateMachine = exports.ProjectStateMachine = void 0;
const common_1 = require("@nestjs/common");
const shared_1 = require("@fapoms/shared");
const domain_events_1 = require("../../core/events/domain-events");
class ProjectStateMachine {
    static startPlanning(project, userId) {
        if (!project.isActive) {
            throw new common_1.BadRequestException('Cannot start planning on inactive project.');
        }
        if (project.status !== shared_1.ProjectStatus.DRAFT) {
            throw new common_1.BadRequestException(`Cannot transition project from ${project.status} to PLANNING.`);
        }
        const prev = project.status;
        project.status = shared_1.ProjectStatus.PLANNING;
        return new domain_events_1.ProjectPlanningStartedEvent(project.id, prev, project.status, userId);
    }
    static readyForScheduling(project, userId) {
        if (!project.isActive) {
            throw new common_1.BadRequestException('Cannot start scheduling on inactive project.');
        }
        if (project.status !== shared_1.ProjectStatus.PLANNING) {
            throw new common_1.BadRequestException(`Cannot transition project from ${project.status} to SCHEDULING.`);
        }
        const prev = project.status;
        project.status = shared_1.ProjectStatus.SCHEDULING;
        return new domain_events_1.ProjectSchedulingReadyEvent(project.id, prev, project.status, userId);
    }
    static startExecution(project, userId) {
        if (!project.isActive) {
            throw new common_1.BadRequestException('Cannot start execution on inactive project.');
        }
        if (project.status !== shared_1.ProjectStatus.SCHEDULING) {
            throw new common_1.BadRequestException(`Cannot transition project from ${project.status} to EXECUTION.`);
        }
        const prev = project.status;
        project.status = shared_1.ProjectStatus.EXECUTION;
        return new domain_events_1.ProjectExecutionStartedEvent(project.id, prev, project.status, userId);
    }
    static startValidation(project, userId) {
        if (!project.isActive) {
            throw new common_1.BadRequestException('Cannot start validation on inactive project.');
        }
        if (project.status !== shared_1.ProjectStatus.EXECUTION) {
            throw new common_1.BadRequestException(`Cannot transition project from ${project.status} to VALIDATION.`);
        }
        const prev = project.status;
        project.status = shared_1.ProjectStatus.VALIDATION;
        return new domain_events_1.ProjectValidationStartedEvent(project.id, prev, project.status, userId);
    }
    static completeProject(project, userId) {
        if (!project.isActive) {
            throw new common_1.BadRequestException('Cannot complete inactive project.');
        }
        if (project.status !== shared_1.ProjectStatus.VALIDATION) {
            throw new common_1.BadRequestException(`Cannot transition project from ${project.status} to COMPLETED.`);
        }
        const prev = project.status;
        project.status = shared_1.ProjectStatus.COMPLETED;
        return new domain_events_1.ProjectCompletedEvent(project.id, prev, project.status, userId);
    }
    static cancelProject(project, userId) {
        if (!project.isActive) {
            throw new common_1.BadRequestException('Cannot cancel inactive project.');
        }
        if (project.status === shared_1.ProjectStatus.COMPLETED) {
            throw new common_1.BadRequestException('Cannot cancel a completed project.');
        }
        const prev = project.status;
        project.status = shared_1.ProjectStatus.CANCELLED;
        return new domain_events_1.ProjectCancelledEvent(project.id, prev, project.status, userId);
    }
}
exports.ProjectStateMachine = ProjectStateMachine;
class ProjectBranchStateMachine {
    static initiatePlanning(pb, userId) {
        if (!pb.isActive) {
            throw new common_1.BadRequestException('Cannot start planning on inactive branch link.');
        }
        const prev = pb.status;
        pb.status = shared_1.ProjectBranchStatus.PLANNING;
        return new domain_events_1.ProjectBranchPlanningStartedEvent(pb.id, prev, pb.status, userId);
    }
    static confirmAssignment(pb, userId) {
        if (!pb.isActive) {
            throw new common_1.BadRequestException('Cannot confirm assignment on inactive branch link.');
        }
        const prev = pb.status;
        pb.status = shared_1.ProjectBranchStatus.ASSIGNMENT_CONFIRMED;
        return new domain_events_1.ProjectBranchAssignmentConfirmedEvent(pb.id, prev, pb.status, userId);
    }
    static scheduleAudit(pb, userId) {
        if (!pb.isActive) {
            throw new common_1.BadRequestException('Cannot schedule audit on inactive branch link.');
        }
        const prev = pb.status;
        pb.status = shared_1.ProjectBranchStatus.SCHEDULED;
        return new domain_events_1.ProjectBranchAuditScheduledEvent(pb.id, prev, pb.status, userId);
    }
    static completeAudit(pb, userId) {
        if (!pb.isActive) {
            throw new common_1.BadRequestException('Cannot complete audit on inactive branch link.');
        }
        const prev = pb.status;
        pb.status = shared_1.ProjectBranchStatus.AUDIT_COMPLETED;
        return new domain_events_1.ProjectBranchAuditCompletedEvent(pb.id, prev, pb.status, userId);
    }
    static completeValidation(pb, userId) {
        if (!pb.isActive) {
            throw new common_1.BadRequestException('Cannot complete validation on inactive branch link.');
        }
        const prev = pb.status;
        pb.status = shared_1.ProjectBranchStatus.VALIDATION_COMPLETED;
        return new domain_events_1.ProjectBranchValidationCompletedEvent(pb.id, prev, pb.status, userId);
    }
    static close(pb, userId) {
        if (!pb.isActive) {
            throw new common_1.BadRequestException('Cannot close inactive branch link.');
        }
        const prev = pb.status;
        pb.status = shared_1.ProjectBranchStatus.CLOSED;
        return new domain_events_1.ProjectBranchClosedEvent(pb.id, prev, pb.status, userId);
    }
}
exports.ProjectBranchStateMachine = ProjectBranchStateMachine;
//# sourceMappingURL=project.state-machine.js.map