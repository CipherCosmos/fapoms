"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
const document_service_1 = require("./document.service");
const document_entity_1 = require("./document.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
describe('DocumentService', () => {
    let service;
    let documentRepo;
    let projectBranchRepo;
    const mockDocumentRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        find: jest.fn(),
    };
    const mockProjectBranchRepo = {
        findOne: jest.fn(),
    };
    const mockAuditService = {
        recordEvent: jest.fn(),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                document_service_1.DocumentService,
                {
                    provide: (0, typeorm_1.getRepositoryToken)(document_entity_1.DocumentEntity),
                    useValue: mockDocumentRepo,
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
        service = module.get(document_service_1.DocumentService);
        documentRepo = module.get((0, typeorm_1.getRepositoryToken)(document_entity_1.DocumentEntity));
        projectBranchRepo = module.get((0, typeorm_1.getRepositoryToken)(project_branch_entity_1.ProjectBranchEntity));
        jest.clearAllMocks();
    });
    describe('create', () => {
        it('should throw NotFoundException if project branch does not exist', async () => {
            mockProjectBranchRepo.findOne.mockResolvedValue(null);
            await expect(service.create({
                projectBranchId: 'pb-missing',
                fileName: 'test.pdf',
                filePath: '/path/test.pdf',
                fileSize: 1024,
                type: shared_1.DocumentType.GENERATED_PDF,
            }, 'user-1')).rejects.toThrow(common_1.NotFoundException);
        });
    });
});
//# sourceMappingURL=document.service.spec.js.map