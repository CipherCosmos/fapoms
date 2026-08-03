"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assignment_state_machine_1 = require("./assignment.state-machine");
const shared_1 = require("@fapoms/shared");
const common_1 = require("@nestjs/common");
describe('AssignmentStateMachine', () => {
    let assignment;
    beforeEach(() => {
        assignment = {
            id: 'assign-1',
            status: shared_1.AssignmentStatus.PENDING,
            proposedFee: 1000,
            isActive: true,
        };
    });
    it('should transition from PENDING to ACCEPTED', () => {
        const event = assignment_state_machine_1.AssignmentStateMachine.acceptOffer(assignment, 'user-1');
        expect(assignment.status).toBe(shared_1.AssignmentStatus.ACCEPTED);
        expect(event.previousState).toBe(shared_1.AssignmentStatus.PENDING);
        expect(event.newState).toBe(shared_1.AssignmentStatus.ACCEPTED);
    });
    it('should transition from PENDING to REJECTED', () => {
        const event = assignment_state_machine_1.AssignmentStateMachine.rejectOffer(assignment, 'user-1', 'Not interested');
        expect(assignment.status).toBe(shared_1.AssignmentStatus.REJECTED);
        expect(assignment.rejectReason).toBe('Not interested');
        expect(event.newState).toBe(shared_1.AssignmentStatus.REJECTED);
    });
    it('should NOT clear isActive when rejecting — terminal state is not a soft delete', () => {
        assignment_state_machine_1.AssignmentStateMachine.rejectOffer(assignment, 'user-1', 'Not interested');
        expect(assignment.isActive).toBe(true);
    });
    it('should NOT clear isActive when cancelling — terminal state is not a soft delete', () => {
        assignment_state_machine_1.AssignmentStateMachine.acceptOffer(assignment, 'user-1');
        assignment_state_machine_1.AssignmentStateMachine.cancel(assignment, 'user-1', 'Admin override');
        expect(assignment.isActive).toBe(true);
    });
    it('should throw BadRequestException on invalid transition from ACCEPTED to REJECTED', () => {
        assignment_state_machine_1.AssignmentStateMachine.acceptOffer(assignment, 'user-1');
        expect(() => {
            assignment_state_machine_1.AssignmentStateMachine.rejectOffer(assignment, 'user-1');
        }).toThrow(common_1.BadRequestException);
    });
    it('should transition from ACCEPTED to CANCELLED', () => {
        assignment_state_machine_1.AssignmentStateMachine.acceptOffer(assignment, 'user-1');
        const event = assignment_state_machine_1.AssignmentStateMachine.cancel(assignment, 'user-1', 'Admin override');
        expect(assignment.status).toBe(shared_1.AssignmentStatus.CANCELLED);
        expect(assignment.cancelReason).toBe('Admin override');
    });
});
//# sourceMappingURL=assignment.state-machine.spec.js.map