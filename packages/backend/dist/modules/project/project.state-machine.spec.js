"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const project_state_machine_1 = require("./project.state-machine");
const shared_1 = require("@fapoms/shared");
const common_1 = require("@nestjs/common");
describe('ProjectStateMachine', () => {
    let project;
    beforeEach(() => {
        project = {
            id: 'proj-1',
            status: shared_1.ProjectStatus.DRAFT,
            isActive: true,
        };
    });
    it('should transition from DRAFT to PLANNING', () => {
        const event = project_state_machine_1.ProjectStateMachine.startPlanning(project, 'user-1');
        expect(project.status).toBe(shared_1.ProjectStatus.PLANNING);
        expect(event.previousState).toBe(shared_1.ProjectStatus.DRAFT);
        expect(event.newState).toBe(shared_1.ProjectStatus.PLANNING);
    });
    it('should throw BadRequestException on invalid transition', () => {
        expect(() => {
            project_state_machine_1.ProjectStateMachine.startExecution(project, 'user-1');
        }).toThrow(common_1.BadRequestException);
    });
    it('should throw BadRequestException on inactive project', () => {
        project.isActive = false;
        expect(() => {
            project_state_machine_1.ProjectStateMachine.startPlanning(project, 'user-1');
        }).toThrow(common_1.BadRequestException);
    });
});
describe('ProjectBranchStateMachine', () => {
    let pb;
    beforeEach(() => {
        pb = {
            id: 'pb-1',
            status: shared_1.ProjectBranchStatus.IMPORTED,
            isActive: true,
        };
    });
    it('should transition from IMPORTED to PLANNING', () => {
        const event = project_state_machine_1.ProjectBranchStateMachine.initiatePlanning(pb, 'user-1');
        expect(pb.status).toBe(shared_1.ProjectBranchStatus.PLANNING);
        expect(event.previousState).toBe(shared_1.ProjectBranchStatus.IMPORTED);
        expect(event.newState).toBe(shared_1.ProjectBranchStatus.PLANNING);
    });
});
//# sourceMappingURL=project.state-machine.spec.js.map