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
            status: shared_1.AssignmentStatus.CREATED,
            proposedFee: 1000,
        };
    });
    it('should transition from CREATED to CANDIDATE_SELECTED', () => {
        const event = assignment_state_machine_1.AssignmentStateMachine.selectCandidate(assignment, 'user-1');
        expect(assignment.status).toBe(shared_1.AssignmentStatus.CANDIDATE_SELECTED);
        expect(event.previousState).toBe(shared_1.AssignmentStatus.CREATED);
        expect(event.newState).toBe(shared_1.AssignmentStatus.CANDIDATE_SELECTED);
    });
    it('should throw BadRequestException on invalid transition', () => {
        expect(() => {
            assignment_state_machine_1.AssignmentStateMachine.scheduleAudit(assignment, '2026-08-01', 'user-1');
        }).toThrow(common_1.BadRequestException);
    });
});
//# sourceMappingURL=assignment.state-machine.spec.js.map