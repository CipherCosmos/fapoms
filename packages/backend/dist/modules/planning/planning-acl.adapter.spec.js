"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const planning_acl_adapter_1 = require("./planning-acl.adapter");
const branch_entity_1 = require("../branch/branch.entity");
const assayer_entity_1 = require("../assayer/assayer.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const typeorm_1 = require("@nestjs/typeorm");
const assayer_service_1 = require("../assayer/assayer.service");
describe('PlanningAntiCorruptionLayer', () => {
    let acl;
    const mockAssayerService = {
        hydrateWorkforceAttributes: jest.fn().mockResolvedValue(undefined),
        hydrateAllWorkforceAttributes: jest.fn().mockResolvedValue(undefined),
        findAll: jest.fn().mockResolvedValue({ assayers: [], total: 0 }),
        findOne: jest.fn().mockResolvedValue({ id: 'asr-1', skills: [], certifications: [], languages: [], specializations: [] }),
    };
    const mockBranchRepo = {};
    const mockAssayerRepo = {
        find: jest.fn().mockResolvedValue([
            { id: 'as-1', displayName: 'Vijay Shankar', status: 'ACTIVE', latitude: 19.0, longitude: 72.0, skills: ['Gold'] },
        ]),
    };
    const mockAssignmentRepo = {};
    const mockProjectBranchRepo = {
        find: jest.fn().mockResolvedValue([
            {
                id: 'pb-1',
                branch: { id: 'b-1', branchCode: 'B01', name: 'Pune Central', latitude: 18.5, longitude: 73.8, city: 'Pune', state: 'MH', requiredCompetencies: ['Gold'] },
            },
        ]),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                planning_acl_adapter_1.PlanningAntiCorruptionLayer,
                { provide: (0, typeorm_1.getRepositoryToken)(branch_entity_1.BranchEntity), useValue: mockBranchRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(assayer_entity_1.AssayerEntity), useValue: mockAssayerRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(assignment_entity_1.AssignmentEntity), useValue: mockAssignmentRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(project_branch_entity_1.ProjectBranchEntity), useValue: mockProjectBranchRepo },
                { provide: assayer_service_1.AssayerService, useValue: mockAssayerService },
            ],
        }).compile();
        acl = module.get(planning_acl_adapter_1.PlanningAntiCorruptionLayer);
    });
    it('should map ProjectBranchEntity into PlanningBranch domains', async () => {
        const branches = await acl.getBranchesForPlanning('p-1');
        expect(branches.length).toBe(1);
        expect(branches[0].branchCode).toBe('B01');
        expect(branches[0].location.latitude).toBe(18.5);
        expect(branches[0].requiredSkills.has('Gold')).toBe(true);
    });
    it('should map AssayerEntity into PlanningAssayer domains', async () => {
        const assayers = await acl.getAvailableAssayers(new Date());
        expect(assayers.length).toBe(1);
        expect(assayers[0].displayName).toBe('Vijay Shankar');
        expect(assayers[0].location.latitude).toBe(19.0);
    });
});
//# sourceMappingURL=planning-acl.adapter.spec.js.map