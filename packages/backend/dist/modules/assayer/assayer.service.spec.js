"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
const assayer_service_1 = require("./assayer.service");
const assayer_entity_1 = require("./assayer.entity");
const assayer_commercial_profile_entity_1 = require("./assayer-commercial-profile.entity");
const workforce_attribute_entity_1 = require("./workforce-attribute.entity");
const assayer_government_document_entity_1 = require("./assayer-government-document.entity");
const assayer_document_entity_1 = require("./assayer-document.entity");
const assayer_remark_entity_1 = require("./assayer-remark.entity");
const assayer_activity_entity_1 = require("./assayer-activity.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
describe('AssayerService', () => {
    let service;
    const mockAssayerRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        findAndCount: jest.fn(),
    };
    const mockCommercialRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        find: jest.fn(),
        findAndCount: jest.fn(),
    };
    const mockWorkforceRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        findAndCount: jest.fn(),
        find: jest.fn(),
    };
    const mockGovDocRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        find: jest.fn(),
    };
    const mockAssayerDocRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        find: jest.fn(),
    };
    const mockRemarkRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
        findAndCount: jest.fn(),
        find: jest.fn(),
    };
    const mockActivityRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findAndCount: jest.fn(),
        find: jest.fn(),
    };
    const mockAuditService = {
        recordEvent: jest.fn(),
    };
    function setupModule() {
        return testing_1.Test.createTestingModule({
            providers: [
                assayer_service_1.AssayerService,
                { provide: (0, typeorm_1.getRepositoryToken)(assayer_entity_1.AssayerEntity), useValue: mockAssayerRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(assayer_commercial_profile_entity_1.AssayerCommercialProfileEntity), useValue: mockCommercialRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(workforce_attribute_entity_1.WorkforceAttributeEntity), useValue: mockWorkforceRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(assayer_government_document_entity_1.AssayerGovernmentDocumentEntity), useValue: mockGovDocRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(assayer_document_entity_1.AssayerDocumentEntity), useValue: mockAssayerDocRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(assayer_remark_entity_1.AssayerRemarkEntity), useValue: mockRemarkRepo },
                { provide: (0, typeorm_1.getRepositoryToken)(assayer_activity_entity_1.AssayerActivityEntity), useValue: mockActivityRepo },
                { provide: audit_service_1.AuditService, useValue: mockAuditService },
            ],
        }).compile();
    }
    beforeEach(async () => {
        const module = await setupModule();
        service = module.get(assayer_service_1.AssayerService);
        jest.clearAllMocks();
    });
    describe('create', () => {
        it('should create an assayer with INVITED lifecycle status', async () => {
            mockAssayerRepo.findOne.mockResolvedValue(null);
            const saved = { id: 'asr-1', assayerCode: 'AS-01', firstName: 'John', lastName: 'Doe',
                displayName: 'John Doe', lifecycleStatus: shared_1.AssayerLifecycleStatus.INVITED, status: 'INACTIVE' };
            mockAssayerRepo.create.mockReturnValue(saved);
            mockAssayerRepo.save.mockResolvedValue(saved);
            const result = await service.create({
                assayerCode: 'AS-01', firstName: 'John', lastName: 'Doe',
                phone: '9999999999', address: 'Addr', state: 'MH', district: 'Pune', city: 'Pune',
            }, 'user-1');
            expect(result.lifecycleStatus).toBe(shared_1.AssayerLifecycleStatus.INVITED);
            expect(mockAuditService.recordEvent).toHaveBeenCalled();
        });
        it('should throw ConflictException for duplicate assayer code', async () => {
            mockAssayerRepo.findOne.mockResolvedValue({ id: 'existing', assayerCode: 'AS-01' });
            await expect(service.create({
                assayerCode: 'AS-01', firstName: 'J', lastName: 'D',
                phone: '9999999999', address: 'Addr', state: 'MH', district: 'Pune', city: 'Pune',
            }, 'user-1')).rejects.toThrow(common_1.ConflictException);
        });
    });
    describe('findOne', () => {
        it('should throw NotFoundException if assayer does not exist', async () => {
            mockAssayerRepo.findOne.mockResolvedValue(null);
            await expect(service.findOne('bad-id')).rejects.toThrow(common_1.NotFoundException);
        });
    });
    describe('transitionLifecycle', () => {
        const assayer = { id: 'asr-1', assayerCode: 'AS-01', lifecycleStatus: shared_1.AssayerLifecycleStatus.INVITED,
            status: 'INACTIVE', isActive: true };
        it('should transition from INVITED to DOCUMENT_VERIFICATION', async () => {
            mockAssayerRepo.findOne.mockResolvedValue({ ...assayer });
            mockAssayerRepo.save.mockImplementation((e) => Promise.resolve(e));
            const result = await service.transitionLifecycle('asr-1', shared_1.AssayerLifecycleStatus.DOCUMENT_VERIFICATION, 'user-1');
            expect(result.lifecycleStatus).toBe(shared_1.AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
            expect(mockAuditService.recordEvent).toHaveBeenCalled();
        });
        it('should reject invalid transition from INVITED to ACTIVE', async () => {
            mockAssayerRepo.findOne.mockResolvedValue({ ...assayer });
            await expect(service.transitionLifecycle('asr-1', shared_1.AssayerLifecycleStatus.ACTIVE, 'user-1')).rejects.toThrow(common_1.BadRequestException);
        });
        it('should set isActive false when transitioning to ARCHIVED', async () => {
            const activeAssayer = { ...assayer, lifecycleStatus: shared_1.AssayerLifecycleStatus.RESIGNED };
            mockAssayerRepo.findOne.mockResolvedValue(activeAssayer);
            mockAssayerRepo.save.mockImplementation((e) => Promise.resolve(e));
            const result = await service.transitionLifecycle('asr-1', shared_1.AssayerLifecycleStatus.ARCHIVED, 'user-1');
            expect(result.isActive).toBe(false);
        });
        it('should sync operational status on transition', async () => {
            const testAssayer = { ...assayer, lifecycleStatus: shared_1.AssayerLifecycleStatus.TRAINING };
            mockAssayerRepo.findOne.mockResolvedValue(testAssayer);
            mockAssayerRepo.save.mockImplementation((e) => Promise.resolve(e));
            const result = await service.transitionLifecycle('asr-1', shared_1.AssayerLifecycleStatus.ACTIVE, 'user-1');
            expect(result.status).toBe('ACTIVE');
        });
    });
    describe('addGovernmentDocument', () => {
        it('should reject duplicate active document type', async () => {
            mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isActive: true });
            mockGovDocRepo.findOne.mockResolvedValue({ id: 'existing', documentType: 'AADHAAR' });
            await expect(service.addGovernmentDocument('asr-1', { documentType: 'AADHAAR', documentNumber: '1234' }, 'user-1')).rejects.toThrow(common_1.ConflictException);
        });
        it('should add document if no duplicate exists', async () => {
            mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isActive: true });
            mockGovDocRepo.findOne.mockResolvedValue(null);
            const saved = { id: 'doc-1', documentType: 'PAN', documentNumber: 'ABCDE1234F', verificationStatus: 'PENDING' };
            mockGovDocRepo.create.mockReturnValue(saved);
            mockGovDocRepo.save.mockResolvedValue(saved);
            const result = await service.addGovernmentDocument('asr-1', { documentType: 'PAN', documentNumber: 'ABCDE1234F' }, 'user-1');
            expect(result.verificationStatus).toBe('PENDING');
            expect(mockAuditService.recordEvent).toHaveBeenCalled();
        });
    });
    describe('removeGovernmentDocument', () => {
        it('should soft delete and audit', async () => {
            mockGovDocRepo.findOne.mockResolvedValue({ id: 'doc-1', assayerId: 'asr-1', documentType: 'PAN', isActive: true });
            mockGovDocRepo.save.mockImplementation((e) => Promise.resolve(e));
            await service.removeGovernmentDocument('doc-1', 'user-1');
            expect(mockAuditService.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'GOVERNMENT_DOCUMENT_REMOVED' }));
        });
    });
    describe('addAssayerDocument', () => {
        it('should create v1 document without parent', async () => {
            mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isActive: true });
            const saved = { id: 'doc-1', documentType: 'RESUME', fileName: 'resume.pdf', docVersion: 1 };
            mockAssayerDocRepo.create.mockReturnValue(saved);
            mockAssayerDocRepo.save.mockResolvedValue(saved);
            const result = await service.addAssayerDocument('asr-1', {
                documentType: 'RESUME', fileName: 'resume.pdf', filePath: '/resume.pdf', fileSize: 1000,
            }, 'user-1');
            expect(result.docVersion).toBe(1);
        });
        it('should increment version with parentDocumentId', async () => {
            mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isActive: true });
            mockAssayerDocRepo.findOne.mockResolvedValue({ id: 'parent', docVersion: 2 });
            const saved = { id: 'doc-2', documentType: 'RESUME', fileName: 'resume-v3.pdf', docVersion: 3 };
            mockAssayerDocRepo.create.mockReturnValue(saved);
            mockAssayerDocRepo.save.mockResolvedValue(saved);
            const result = await service.addAssayerDocument('asr-1', {
                documentType: 'RESUME', fileName: 'resume-v3.pdf', filePath: '/resume-v3.pdf', fileSize: 1000,
                parentDocumentId: 'parent',
            }, 'user-1');
            expect(result.docVersion).toBe(3);
        });
    });
    describe('updateAssayerDocument', () => {
        it('should update document metadata', async () => {
            mockAssayerDocRepo.findOne.mockResolvedValue({ id: 'doc-1', assayerId: 'asr-1', documentType: 'RESUME', docVersion: 1 });
            mockAssayerDocRepo.save.mockImplementation((e) => Promise.resolve(e));
            const result = await service.updateAssayerDocument('doc-1', { remarks: 'Updated remarks' }, 'user-1');
            expect(mockAuditService.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ASSAYER_DOCUMENT_UPDATED' }));
        });
    });
    describe('addRemark', () => {
        it('should create remark with author attribution', async () => {
            mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isActive: true });
            const saved = { id: 'rem-1', content: 'Good work', authorId: 'user-1', authorName: 'Admin', category: 'PERFORMANCE' };
            mockRemarkRepo.create.mockReturnValue(saved);
            mockRemarkRepo.save.mockResolvedValue(saved);
            const result = await service.addRemark('asr-1', {
                content: 'Good work', category: 'PERFORMANCE', visibility: 'PUBLIC',
            }, 'user-1', 'Admin');
            expect(result.authorName).toBe('Admin');
            expect(mockAuditService.recordEvent).toHaveBeenCalled();
        });
    });
    describe('updateRemark', () => {
        it('should update remark content', async () => {
            mockRemarkRepo.findOne.mockResolvedValue({ id: 'rem-1', assayerId: 'asr-1', content: 'Old', isActive: true });
            mockRemarkRepo.save.mockImplementation((e) => Promise.resolve(e));
            const result = await service.updateRemark('rem-1', { content: 'Updated content' }, 'user-1');
            expect(mockAuditService.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ASSAYER_REMARK_UPDATED' }));
        });
    });
    describe('removeRemark', () => {
        it('should soft delete remark and preserve audit', async () => {
            mockRemarkRepo.findOne.mockResolvedValue({ id: 'rem-1', assayerId: 'asr-1', content: 'Some remark', isActive: true });
            mockRemarkRepo.save.mockImplementation((e) => Promise.resolve(e));
            await service.removeRemark('rem-1', 'user-1');
            expect(mockAuditService.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ASSAYER_REMARK_REMOVED' }));
        });
    });
    describe('getRemarks pagination', () => {
        it('should return paginated remarks', async () => {
            const remarks = [{ id: 'rem-1', content: 'Remark 1' }];
            mockRemarkRepo.findAndCount.mockResolvedValue([remarks, 1]);
            const result = await service.getRemarks('asr-1', undefined, 1, 20);
            expect(result.remarks).toHaveLength(1);
            expect(result.total).toBe(1);
        });
    });
    describe('getActivityTimeline pagination', () => {
        it('should return paginated timeline', async () => {
            const activities = [{ id: 'act-1', eventType: 'ASSAYER_CREATED' }];
            mockActivityRepo.findAndCount.mockResolvedValue([activities, 1]);
            const result = await service.getActivityTimeline('asr-1', 1, 20);
            expect(result.activities).toHaveLength(1);
            expect(result.total).toBe(1);
        });
        it('should not have hard-coded limits', async () => {
            const activities = Array.from({ length: 50 }, (_, i) => ({ id: `act-${i}` }));
            mockActivityRepo.findAndCount.mockResolvedValue([activities, 50]);
            const result = await service.getActivityTimeline('asr-1', 1, 50);
            expect(result.activities).toHaveLength(50);
        });
    });
    describe('activity timeline records', () => {
        it('should create activity on assayer creation', async () => {
            mockAssayerRepo.findOne.mockResolvedValue(null);
            const saved = { id: 'asr-1', assayerCode: 'AS-01', firstName: 'J', lastName: 'D',
                displayName: 'J D', lifecycleStatus: shared_1.AssayerLifecycleStatus.INVITED, status: 'INACTIVE' };
            mockAssayerRepo.create.mockReturnValue(saved);
            mockAssayerRepo.save.mockResolvedValue(saved);
            mockActivityRepo.create.mockReturnValue({});
            mockActivityRepo.save.mockResolvedValue({});
            await service.create({
                assayerCode: 'AS-01', firstName: 'J', lastName: 'D',
                phone: '9999999999', address: 'Addr', state: 'MH', district: 'Pune', city: 'Pune',
            }, 'user-1');
            expect(mockActivityRepo.save).toHaveBeenCalled();
        });
    });
    describe('createCommercialProfile', () => {
        it('should create and audit', async () => {
            mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isActive: true });
            const saved = { id: 'prof-1', assayerId: 'asr-1', baseFee: 1000 };
            mockCommercialRepo.create.mockReturnValue(saved);
            mockCommercialRepo.save.mockResolvedValue(saved);
            const result = await service.createCommercialProfile('asr-1', {
                baseFee: 1000, hourlyRate: 100, dailyRate: 500,
                travelReimbursement: 200, accommodationAllowance: 300, mealAllowance: 50,
                effectiveStartDate: '2026-01-01', currency: 'INR',
            }, 'user-1');
            expect(mockAuditService.recordEvent).toHaveBeenCalled();
        });
    });
    describe('addWorkforceAttribute', () => {
        it('should create and audit', async () => {
            mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isActive: true });
            const saved = { id: 'attr-1', type: 'SKILL', name: 'Communication' };
            mockWorkforceRepo.create.mockReturnValue(saved);
            mockWorkforceRepo.save.mockResolvedValue(saved);
            const result = await service.addWorkforceAttribute('asr-1', { type: 'SKILL', name: 'Communication' }, 'user-1');
            expect(mockAuditService.recordEvent).toHaveBeenCalled();
        });
    });
});
//# sourceMappingURL=assayer.service.spec.js.map