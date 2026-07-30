"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AssignmentStateMachine = void 0;
const common_1 = require("@nestjs/common");
const shared_1 = require("@fapoms/shared");
class AssignmentStateMachine {
    static VALID_PATHS = {
        [shared_1.AssignmentStatus.PENDING]: [shared_1.AssignmentStatus.ACCEPTED, shared_1.AssignmentStatus.REJECTED, shared_1.AssignmentStatus.CANCELLED],
        [shared_1.AssignmentStatus.ACCEPTED]: [shared_1.AssignmentStatus.ACCEPTED, shared_1.AssignmentStatus.CHECKED_IN, shared_1.AssignmentStatus.CANCELLED],
        [shared_1.AssignmentStatus.CHECKED_IN]: [shared_1.AssignmentStatus.CHECKED_IN, shared_1.AssignmentStatus.ACCEPTED, shared_1.AssignmentStatus.IN_PROGRESS, shared_1.AssignmentStatus.COMPLETED, shared_1.AssignmentStatus.CANCELLED],
        [shared_1.AssignmentStatus.IN_PROGRESS]: [shared_1.AssignmentStatus.IN_PROGRESS, shared_1.AssignmentStatus.COMPLETED, shared_1.AssignmentStatus.CANCELLED],
        [shared_1.AssignmentStatus.COMPLETED]: [],
        [shared_1.AssignmentStatus.REJECTED]: [shared_1.AssignmentStatus.PENDING],
        [shared_1.AssignmentStatus.CANCELLED]: [shared_1.AssignmentStatus.PENDING],
    };
    static validateTransition(current, target) {
        const allowed = AssignmentStateMachine.VALID_PATHS[current];
        if (!allowed || !allowed.includes(target)) {
            throw new common_1.BadRequestException(`Invalid transition path from '${current}' to '${target}'`);
        }
    }
    static acceptOffer(assignment, userId) {
        AssignmentStateMachine.validateTransition(assignment.status, shared_1.AssignmentStatus.ACCEPTED);
        const prev = assignment.status;
        assignment.status = shared_1.AssignmentStatus.ACCEPTED;
        return { previousState: prev, newState: assignment.status, userId };
    }
    static rejectOffer(assignment, userId, reason) {
        AssignmentStateMachine.validateTransition(assignment.status, shared_1.AssignmentStatus.REJECTED);
        const prev = assignment.status;
        assignment.status = shared_1.AssignmentStatus.REJECTED;
        assignment.rejectReason = reason ?? 'Rejected';
        assignment.isActive = false;
        return { previousState: prev, newState: assignment.status, userId };
    }
    static cancel(assignment, userId, reason) {
        AssignmentStateMachine.validateTransition(assignment.status, shared_1.AssignmentStatus.CANCELLED);
        const prev = assignment.status;
        assignment.status = shared_1.AssignmentStatus.CANCELLED;
        assignment.cancelReason = reason ?? 'Cancelled';
        assignment.isActive = false;
        return { previousState: prev, newState: assignment.status, userId };
    }
}
exports.AssignmentStateMachine = AssignmentStateMachine;
//# sourceMappingURL=assignment.state-machine.js.map