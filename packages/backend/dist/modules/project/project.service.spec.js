"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
const project_service_1 = require("./project.service");
const project_entity_1 = require("./project.entity");
const project_branch_entity_1 = require("./project-branch.entity");
const branch_entity_1 = require("../branch/branch.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const workflow_engine_1 = require("../platform/workflow/workflow.engine");
const shared_1 = require("@fapoms/shared");
describe('ProjectService', () => {
    let service;
    let projectRepo;
    let projectBranchRepo;
    const mockProjectRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        findAndCount: jest.fn(),
    };
    const mockProjectBranchRepo = {
        find: jest.fn(),
        findOne: jest.fn(),
        create: jest.fn(),
        save: jest.fn(),
    };
    const mockBranchRepo = {
        findOne: jest.fn(),
    };
    const mockAuditService = {
        recordEvent: jest.fn(),
    };
    const mockWorkflowEngine = {
        registerWorkflow: jest.fn(),
        executeTransition: jest.fn(),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                project_service_1.ProjectService,
                {
                    provide: (0, typeorm_1.getRepositoryToken)(project_entity_1.ProjectEntity),
                    useValue: mockProjectRepo,
                },
                {
                    provide: (0, typeorm_1.getRepositoryToken)(project_branch_entity_1.ProjectBranchEntity),
                    useValue: mockProjectBranchRepo,
                },
                {
                    provide: (0, typeorm_1.getRepositoryToken)(branch_entity_1.BranchEntity),
                    useValue: mockBranchRepo,
                },
                {
                    provide: audit_service_1.AuditService,
                    useValue: mockAuditService,
                },
                {
                    provide: workflow_engine_1.WorkflowEngine,
                    useValue: mockWorkflowEngine,
                },
            ],
        }).compile();
        service = module.get(project_service_1.ProjectService);
        projectRepo = module.get((0, typeorm_1.getRepositoryToken)(project_entity_1.ProjectEntity));
        projectBranchRepo = module.get((0, typeorm_1.getRepositoryToken)(project_branch_entity_1.ProjectBranchEntity));
        jest.clearAllMocks();
    });
    describe('create', () => {
        it('should successfully create a project in DRAFT status', async () => {
            const mockCreated = {
                id: 'p-1',
                projectNumber: 'PROJ-1',
                name: 'Project 1',
                status: shared_1.ProjectStatus.DRAFT,
            };
            mockProjectRepo.create.mockReturnValue(mockCreated);
            mockProjectRepo.save.mockResolvedValue(mockCreated);
            const result = await service.create({
                name: 'Project 1',
                projectNumber: 'PROJ-1',
                clientId: 'c-1',
                priority: 'MEDIUM',
            }, 'user-1');
            expect(result.status).toBe(shared_1.ProjectStatus.DRAFT);
            expect(mockProjectRepo.save).toHaveBeenCalled();
            expect(mockAuditService.recordEvent).toHaveBeenCalled();
        });
    });
    describe('findOne', () => {
        it('should throw NotFoundException if project is missing', async () => {
            mockProjectRepo.findOne.mockResolvedValue(null);
            await expect(service.findOne('p-missing')).rejects.toThrow(common_1.NotFoundException);
        });
    });
});
//# sourceMappingURL=project.service.spec.js.map