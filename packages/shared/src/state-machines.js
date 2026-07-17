"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VALIDATION_TRANSITIONS = exports.SCHEDULE_TRANSITIONS = exports.ASSIGNMENT_TRANSITIONS = exports.PROJECT_BRANCH_TRANSITIONS = exports.PROJECT_TRANSITIONS = void 0;
exports.isValidTransition = isValidTransition;
const enums_1 = require("./enums");
exports.PROJECT_TRANSITIONS = {
    [enums_1.ProjectStatus.DRAFT]: [enums_1.ProjectStatus.PLANNING],
    [enums_1.ProjectStatus.PLANNING]: [enums_1.ProjectStatus.SCHEDULING, enums_1.ProjectStatus.CANCELLED],
    [enums_1.ProjectStatus.SCHEDULING]: [enums_1.ProjectStatus.EXECUTION, enums_1.ProjectStatus.ON_HOLD],
    [enums_1.ProjectStatus.EXECUTION]: [enums_1.ProjectStatus.VALIDATION, enums_1.ProjectStatus.ON_HOLD],
    [enums_1.ProjectStatus.VALIDATION]: [enums_1.ProjectStatus.COMPLETED],
    [enums_1.ProjectStatus.COMPLETED]: [enums_1.ProjectStatus.ARCHIVED],
    [enums_1.ProjectStatus.ON_HOLD]: [enums_1.ProjectStatus.SCHEDULING, enums_1.ProjectStatus.EXECUTION],
};
exports.PROJECT_BRANCH_TRANSITIONS = {
    [enums_1.ProjectBranchStatus.IMPORTED]: [enums_1.ProjectBranchStatus.PLANNING],
    [enums_1.ProjectBranchStatus.PLANNING]: [
        enums_1.ProjectBranchStatus.CANDIDATE_SEARCH,
        enums_1.ProjectBranchStatus.UNABLE_TO_COVER,
    ],
    [enums_1.ProjectBranchStatus.CANDIDATE_SEARCH]: [
        enums_1.ProjectBranchStatus.CONTACT_INITIATED,
        enums_1.ProjectBranchStatus.UNABLE_TO_COVER,
    ],
    [enums_1.ProjectBranchStatus.CONTACT_INITIATED]: [
        enums_1.ProjectBranchStatus.NEGOTIATION,
        enums_1.ProjectBranchStatus.CANDIDATE_SEARCH,
    ],
    [enums_1.ProjectBranchStatus.NEGOTIATION]: [
        enums_1.ProjectBranchStatus.ASSIGNMENT_CONFIRMED,
        enums_1.ProjectBranchStatus.CANDIDATE_SEARCH,
    ],
    [enums_1.ProjectBranchStatus.ASSIGNMENT_CONFIRMED]: [enums_1.ProjectBranchStatus.SCHEDULED],
    [enums_1.ProjectBranchStatus.SCHEDULED]: [enums_1.ProjectBranchStatus.AUDIT_COMPLETED],
    [enums_1.ProjectBranchStatus.AUDIT_COMPLETED]: [enums_1.ProjectBranchStatus.VALIDATION_COMPLETED],
    [enums_1.ProjectBranchStatus.VALIDATION_COMPLETED]: [enums_1.ProjectBranchStatus.CLOSED],
    [enums_1.ProjectBranchStatus.UNABLE_TO_COVER]: [enums_1.ProjectBranchStatus.PLANNING],
    [enums_1.ProjectBranchStatus.ON_HOLD]: [enums_1.ProjectBranchStatus.PLANNING],
};
exports.ASSIGNMENT_TRANSITIONS = {
    [enums_1.AssignmentStatus.CREATED]: [enums_1.AssignmentStatus.CANDIDATE_SELECTED],
    [enums_1.AssignmentStatus.CANDIDATE_SELECTED]: [enums_1.AssignmentStatus.CONTACT_INITIATED],
    [enums_1.AssignmentStatus.CONTACT_INITIATED]: [enums_1.AssignmentStatus.NEGOTIATION],
    [enums_1.AssignmentStatus.NEGOTIATION]: [
        enums_1.AssignmentStatus.ACCEPTED,
        enums_1.AssignmentStatus.REJECTED,
    ],
    [enums_1.AssignmentStatus.ACCEPTED]: [
        enums_1.AssignmentStatus.SCHEDULED,
        enums_1.AssignmentStatus.CANCELLED,
    ],
    [enums_1.AssignmentStatus.SCHEDULED]: [enums_1.AssignmentStatus.AUDIT_COMPLETED],
    [enums_1.AssignmentStatus.AUDIT_COMPLETED]: [enums_1.AssignmentStatus.CLOSED],
};
exports.SCHEDULE_TRANSITIONS = {
    [enums_1.ScheduleStatus.TENTATIVE]: [enums_1.ScheduleStatus.CONFIRMED],
    [enums_1.ScheduleStatus.CONFIRMED]: [
        enums_1.ScheduleStatus.RESCHEDULED,
        enums_1.ScheduleStatus.COMPLETED,
    ],
    [enums_1.ScheduleStatus.RESCHEDULED]: [enums_1.ScheduleStatus.CONFIRMED],
};
exports.VALIDATION_TRANSITIONS = {
    [enums_1.ValidationStatus.PENDING]: [enums_1.ValidationStatus.ASSIGNED],
    [enums_1.ValidationStatus.ASSIGNED]: [enums_1.ValidationStatus.OCR_PROCESSING],
    [enums_1.ValidationStatus.OCR_PROCESSING]: [enums_1.ValidationStatus.HUMAN_REVIEW],
    [enums_1.ValidationStatus.HUMAN_REVIEW]: [
        enums_1.ValidationStatus.APPROVED,
        enums_1.ValidationStatus.CORRECTION_REQUIRED,
    ],
    [enums_1.ValidationStatus.CORRECTION_REQUIRED]: [enums_1.ValidationStatus.HUMAN_REVIEW],
    [enums_1.ValidationStatus.APPROVED]: [enums_1.ValidationStatus.SUBMITTED],
};
function isValidTransition(transitions, currentState, targetState) {
    const allowedTargets = transitions[currentState];
    if (!allowedTargets)
        return false;
    return allowedTargets.includes(targetState);
}
//# sourceMappingURL=state-machines.js.map