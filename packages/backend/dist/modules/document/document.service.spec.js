"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
const document_service_1 = require("./document.service");
const document_entity_1 = require("./document.entity");
const assessment_entity_1 = require("../project/assessment.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const domain_event_publisher_1 = require("../../core/events/domain-event.publisher");
const notification_service_1 = require("../notifications/notification.service");
const push_notification_service_1 = require("../notifications/push-notification.service");
const shared_1 = require("@fapoms/shared");
const project_branch_entity_1 = require("../project/project-branch.entity");
const local_storage_service_1 = require("../../infrastructure/storage/local-storage.service");
describe('DocumentService', () => {
    let service;
    const mockDocumentRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        find: jest.fn(),
    };
    const mockAssessmentRepo = {
        findOne: jest.fn(),
    };
    const mockAssignmentRepo = {
        findOne: jest.fn().mockResolvedValue(null),
    };
    const mockAuditService = {
        recordEvent: jest.fn(),
    };
    const mockEventPublisher = {
        publish: jest.fn(),
    };
    const mockNotificationService = {
        create: jest.fn(),
    };
    const mockPushNotificationService = {
        sendToUser: jest.fn(),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                document_service_1.DocumentService,
                { provide: (0, typeorm_1.getRepositoryToken)(document_entity_1.DocumentEntity), useValue: mockDocumentRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(assessment_entity_1.AssessmentEntity), useValue: mockAssessmentRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(project_branch_entity_1.ProjectBranchEntity), useValue: { findOne: jest.fn().mockResolvedValue(null) } },
                { provide: (0, typeorm_1.getRepositoryToken)(assignment_entity_1.AssignmentEntity), useValue: mockAssignmentRepo },
                { provide: audit_service_1.AuditService, useValue: mockAuditService },
                { provide: domain_event_publisher_1.DomainEventPublisher, useValue: mockEventPublisher },
                { provide: notification_service_1.NotificationService, useValue: mockNotificationService },
                { provide: push_notification_service_1.PushNotificationService, useValue: mockPushNotificationService },
                { provide: local_storage_service_1.LocalStorageService, useValue: { saveFile: jest.fn(), getFilePath: jest.fn() } },
            ],
        }).compile();
        service = module.get(document_service_1.DocumentService);
        jest.clearAllMocks();
    });
    describe('create', () => {
        it('should throw NotFoundException if assessment does not exist', async () => {
            mockAssessmentRepo.findOne.mockResolvedValue(null);
            await expect(service.create({
                assessmentId: 'asmt-missing',
                fileName: 'test.pdf',
                filePath: '/path/test.pdf',
                fileSize: 1024,
                type: shared_1.DocumentType.PRE_FIELD_AUDIT_PDF,
            }, 'user-1')).rejects.toThrow(common_1.NotFoundException);
        });
    });
});
//# sourceMappingURL=document.service.spec.js.map