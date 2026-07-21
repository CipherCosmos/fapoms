"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
const validation_service_1 = require("./validation.service");
const validation_case_entity_1 = require("./validation-case.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
describe('ValidationService', () => {
    let service;
    let validationCaseRepo;
    let projectBranchRepo;
    const mockValidationCaseRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        findAndCount: jest.fn(),
    };
    const mockProjectBranchRepo = {
        findOne: jest.fn(),
        save: jest.fn(),
    };
    const mockAuditService = {
        recordEvent: jest.fn(),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                validation_service_1.ValidationService,
                {
                    provide: (0, typeorm_1.getRepositoryToken)(validation_case_entity_1.ValidationCaseEntity),
                    useValue: mockValidationCaseRepo,
                },
                {
                    provide: (0, typeorm_1.getRepositoryToken)(project_branch_entity_1.ProjectBranchEntity),
                    useValue: mockProjectBranchRepo,
                },
                {
                    provide: audit_service_1.AuditService,
                    useValue: mockAuditService,
                },
            ],
        }).compile();
        service = module.get(validation_service_1.ValidationService);
        validationCaseRepo = module.get((0, typeorm_1.getRepositoryToken)(validation_case_entity_1.ValidationCaseEntity));
        projectBranchRepo = module.get((0, typeorm_1.getRepositoryToken)(project_branch_entity_1.ProjectBranchEntity));
        jest.clearAllMocks();
    });
    describe('create', () => {
        it('should throw NotFoundException if project branch does not exist', async () => {
            mockProjectBranchRepo.findOne.mockResolvedValue(null);
            await expect(service.create({ projectBranchId: 'pb-missing' }, 'user-1')).rejects.toThrow(common_1.NotFoundException);
        });
    });
    describe('assign', () => {
        it('should throw BadRequestException if transition to ASSIGNED is invalid', async () => {
            const mockCase = { id: 'v-1', status: shared_1.ValidationStatus.APPROVED };
            mockValidationCaseRepo.findOne.mockResolvedValue(mockCase);
            await expect(service.assign('v-1', 'reviewer-1', 'user-1')).rejects.toThrow(common_1.BadRequestException);
        });
    });
});
//# sourceMappingURL=validation.service.spec.js.map