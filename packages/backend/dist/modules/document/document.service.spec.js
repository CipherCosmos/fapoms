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
const validation_service_1 = require("../validation/validation.service");
describe('DocumentService', () => {
    let service;
    const mockManagerQuery = jest.fn();
    const mockDocumentRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        find: jest.fn(),
        manager: { query: mockManagerQuery },
    };
    const mockAssessmentRepo = {
        findOne: jest.fn(),
    };
    const mockAssignmentRepo = {
        findOne: jest.fn().mockResolvedValue(null),
        createQueryBuilder: jest.fn(),
    };
    const mockProjectBranchRepo = {
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
                { provide: (0, typeorm_1.getRepositoryToken)(project_branch_entity_1.ProjectBranchEntity), useValue: mockProjectBranchRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(assignment_entity_1.AssignmentEntity), useValue: mockAssignmentRepo },
                { provide: audit_service_1.AuditService, useValue: mockAuditService },
                { provide: domain_event_publisher_1.DomainEventPublisher, useValue: mockEventPublisher },
                { provide: notification_service_1.NotificationService, useValue: mockNotificationService },
                { provide: push_notification_service_1.PushNotificationService, useValue: mockPushNotificationService },
                { provide: local_storage_service_1.LocalStorageService, useValue: { saveFile: jest.fn(), getFilePath: jest.fn() } },
                { provide: validation_service_1.ValidationService, useValue: { getOrAdvanceForHandBack: jest.fn() } },
            ],
        }).compile();
        service = module.get(document_service_1.DocumentService);
        jest.clearAllMocks();
    });
    describe('assayer dispatch gate', () => {
        const branchDoc = (type, status) => ({
            id: `doc-${status}`, type, status, assessmentId: 'asmt-1', dispatchedAt: null,
        });
        beforeEach(() => {
            mockAssessmentRepo.findOne.mockResolvedValue({ id: 'asmt-1', projectId: 'proj-1', branchId: 'br-1' });
            mockProjectBranchRepo.findOne.mockResolvedValue({ id: 'pb-1', projectId: 'proj-1', branchId: 'br-1' });
        });
        it('hides documents that have not been dispatched, and says why', async () => {
            mockDocumentRepo.find.mockResolvedValue([
                branchDoc(shared_1.DocumentType.PRE_FIELD_AUDIT_PDF, shared_1.DocumentStatus.UPLOADED),
            ]);
            const { documents, readiness } = await service.findDispatchedForAssayer('pb-1');
            expect(documents).toHaveLength(0);
            expect(readiness.state).toBe('PREPARING');
            expect(readiness.awaitingDispatchCount).toBe(1);
            expect(readiness.message).toMatch(/will be sent/i);
        });
        it('exposes documents once dispatched', async () => {
            mockDocumentRepo.find.mockResolvedValue([
                { ...branchDoc(shared_1.DocumentType.PRE_FIELD_AUDIT_PDF, shared_1.DocumentStatus.DISPATCHED), dispatchedAt: new Date('2026-07-30T10:00:00Z') },
            ]);
            const { documents, readiness } = await service.findDispatchedForAssayer('pb-1');
            expect(documents).toHaveLength(1);
            expect(readiness.state).toBe('READY');
            expect(readiness.lastDispatchedAt).toEqual(new Date('2026-07-30T10:00:00Z'));
        });
        it('never exposes internal document types even when dispatched', async () => {
            mockDocumentRepo.find.mockResolvedValue([
                branchDoc(shared_1.DocumentType.FINAL_REPORT, shared_1.DocumentStatus.DISPATCHED),
                branchDoc(shared_1.DocumentType.GENERATED_EXCEL, shared_1.DocumentStatus.COMPLETED),
            ]);
            const { documents, readiness } = await service.findDispatchedForAssayer('pb-1');
            expect(documents).toHaveLength(0);
            expect(readiness.state).toBe('NONE');
        });
        it('refuses a download token for an undispatched document', async () => {
            mockDocumentRepo.findOne.mockResolvedValue(branchDoc(shared_1.DocumentType.PRE_FIELD_AUDIT_PDF, shared_1.DocumentStatus.UPLOADED));
            await expect(service.assertAssayerMayDownload('doc-1', 'assayer-1'))
                .rejects.toThrow(common_1.BadRequestException);
        });
        it('refuses a download for a branch the assayer is not assigned to', async () => {
            mockDocumentRepo.findOne.mockResolvedValue(branchDoc(shared_1.DocumentType.PRE_FIELD_AUDIT_PDF, shared_1.DocumentStatus.DISPATCHED));
            mockAssignmentRepo.createQueryBuilder = jest.fn(() => ({
                innerJoin: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
                andWhere: jest.fn().mockReturnThis(), getCount: jest.fn(async () => 0),
            }));
            await expect(service.assertAssayerMayDownload('doc-1', 'assayer-other'))
                .rejects.toThrow(common_1.BadRequestException);
        });
        it('allows a dispatched document for an assigned assayer', async () => {
            mockDocumentRepo.findOne.mockResolvedValue(branchDoc(shared_1.DocumentType.PRE_FIELD_AUDIT_PDF, shared_1.DocumentStatus.DISPATCHED));
            mockAssignmentRepo.createQueryBuilder = jest.fn(() => ({
                innerJoin: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
                andWhere: jest.fn().mockReturnThis(), getCount: jest.fn(async () => 1),
            }));
            await expect(service.assertAssayerMayDownload('doc-1', 'assayer-1')).resolves.toBeUndefined();
        });
    });
    describe('operationsOverview branch grouping', () => {
        beforeEach(() => {
            mockManagerQuery.mockReset();
        });
        it("groups a branch's multiple documents under one entry instead of repeating its name", async () => {
            mockManagerQuery.mockImplementation(async (sql) => {
                if (sql.includes('FROM documents d')) {
                    return [
                        { id: 'doc-1', file_name: 'pre-audit.pdf', file_size: 100, type: 'PRE_FIELD_AUDIT_PDF', status: 'DISPATCHED', doc_version: 1, created_at: new Date(), project_branch_id: 'pb-1', branch_name: 'Pune Main Branch', branch_code: 'BR-1', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', scheduled_date: null },
                        { id: 'doc-2', file_name: 'return.pdf', file_size: 200, type: 'AUDITED_RETURN_PDF', status: 'RECEIVED', doc_version: 1, created_at: new Date(), project_branch_id: 'pb-1', branch_name: 'Pune Main Branch', branch_code: 'BR-1', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', scheduled_date: null },
                    ];
                }
                if (sql.includes('FROM project_branches pb')) {
                    return [
                        { project_branch_id: 'pb-1', pb_status: 'AUDIT_COMPLETED', scheduled_date: null, branch_id: 'br-1', branch_name: 'Pune Main Branch', branch_code: 'BR-1', project_id: 'proj-1', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', assessment_status: 'COMPLETED' },
                    ];
                }
                return [];
            });
            const result = await service.operationsOverview();
            expect(result.branches).toHaveLength(1);
            expect(result.branches[0].documentCount).toBe(2);
            expect(Object.keys(result.branches[0].documentsByType).sort()).toEqual(['AUDITED_RETURN_PDF', 'PRE_FIELD_AUDIT_PDF']);
        });
        it('flags a branch with a confirmed audit date but zero prepared paperwork', async () => {
            mockManagerQuery.mockImplementation(async (sql) => {
                if (sql.includes('FROM documents d'))
                    return [];
                if (sql.includes('FROM project_branches pb')) {
                    return [
                        { project_branch_id: 'pb-2', pb_status: 'SCHEDULED', scheduled_date: '2026-08-20', branch_id: 'br-2', branch_name: 'Untouched Branch', branch_code: 'BR-2', project_id: 'proj-1', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', assessment_status: 'ASSIGNED_AND_SCHEDULED' },
                    ];
                }
                return [];
            });
            const result = await service.operationsOverview();
            expect(result.neverPrepared).toHaveLength(1);
            expect(result.neverPrepared[0].branchName).toBe('Untouched Branch');
            expect(result.totals.neverPrepared).toBe(1);
        });
        it('does not flag a branch whose paperwork already exists', async () => {
            mockManagerQuery.mockImplementation(async (sql) => {
                if (sql.includes('FROM documents d')) {
                    return [
                        { id: 'doc-1', file_name: 'pre-audit.pdf', file_size: 100, type: 'PRE_FIELD_AUDIT_PDF', status: 'UPLOADED', doc_version: 1, created_at: new Date(), project_branch_id: 'pb-3', branch_name: 'Prepared Branch', branch_code: 'BR-3', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', scheduled_date: '2026-08-20' },
                    ];
                }
                if (sql.includes('FROM project_branches pb')) {
                    return [
                        { project_branch_id: 'pb-3', pb_status: 'SCHEDULED', scheduled_date: '2026-08-20', branch_id: 'br-3', branch_name: 'Prepared Branch', branch_code: 'BR-3', project_id: 'proj-1', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', assessment_status: 'READY_FOR_DISPATCH' },
                    ];
                }
                return [];
            });
            const result = await service.operationsOverview();
            expect(result.neverPrepared).toHaveLength(0);
        });
        it('does not flag a branch that has no assayer confirmed yet', async () => {
            mockManagerQuery.mockImplementation(async (sql) => {
                if (sql.includes('FROM documents d'))
                    return [];
                if (sql.includes('FROM project_branches pb')) {
                    return [
                        { project_branch_id: 'pb-4', pb_status: 'CANDIDATE_SEARCH', scheduled_date: '2026-08-20', branch_id: 'br-4', branch_name: 'Unstaffed Branch', branch_code: 'BR-4', project_id: 'proj-1', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', assessment_status: null },
                    ];
                }
                return [];
            });
            const result = await service.operationsOverview();
            expect(result.neverPrepared).toHaveLength(0);
        });
    });
    describe('matchPdfsToBranches', () => {
        const scheduled = [
            { project_branch_id: 'pb-1', branch_name: 'Pune Main Branch', branch_code: 'BR-0010' },
            { project_branch_id: 'pb-2', branch_name: 'Pune Yerwada Branch', branch_code: 'BR-0016' },
            { project_branch_id: 'pb-3', branch_name: 'Nashik Main Branch', branch_code: 'BR-0020' },
        ];
        beforeEach(() => {
            mockManagerQuery.mockReset();
            mockManagerQuery.mockResolvedValue(scheduled);
        });
        it('matches on branch code regardless of punctuation or case', async () => {
            const r = await service.matchPdfsToBranches('proj-1', '2026-08-20', [
                'audit_BR-0010_20Aug.pdf',
                'br0016-packet.pdf',
            ]);
            expect(r.matches.map((m) => m.projectBranchId).sort()).toEqual(['pb-1', 'pb-2']);
            expect(r.matches.every((m) => m.matchedOn === 'CODE')).toBe(true);
            expect(r.unmatched).toHaveLength(0);
        });
        it('falls back to branch name when no code is present', async () => {
            const r = await service.matchPdfsToBranches('proj-1', '2026-08-20', ['Yerwada 20-08.pdf']);
            expect(r.matches).toHaveLength(1);
            expect(r.matches[0].projectBranchId).toBe('pb-2');
            expect(r.matches[0].matchedOn).toBe('NAME');
        });
        it('refuses to place a file that matches more than one branch', async () => {
            const r = await service.matchPdfsToBranches('proj-1', '2026-08-20', ['Main.pdf']);
            expect(r.matches).toHaveLength(0);
            expect(r.unmatched[0].reason).toMatch(/Matches 2 branches/);
        });
        it('refuses an unrecognised filename rather than guessing', async () => {
            const r = await service.matchPdfsToBranches('proj-1', '2026-08-20', ['scan001.pdf']);
            expect(r.matches).toHaveLength(0);
            expect(r.unmatched[0].reason).toMatch(/No scheduled branch matches/);
        });
        it('does not let two files claim the same branch', async () => {
            const r = await service.matchPdfsToBranches('proj-1', '2026-08-20', [
                'BR-0010_v1.pdf',
                'BR-0010_v2.pdf',
            ]);
            expect(r.matches).toHaveLength(1);
            expect(r.unmatched[0].reason).toMatch(/already matched/);
        });
        it('reports scheduled branches the upload did not cover', async () => {
            const r = await service.matchPdfsToBranches('proj-1', '2026-08-20', ['BR-0010.pdf']);
            expect(r.branchesWithoutFile.map((b) => b.projectBranchId).sort()).toEqual(['pb-2', 'pb-3']);
        });
    });
    describe('create', () => {
        it('should throw NotFoundException if assessment does not exist', async () => {
            mockAssessmentRepo.findOne.mockResolvedValue(null);
            mockProjectBranchRepo.findOne.mockResolvedValue(null);
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