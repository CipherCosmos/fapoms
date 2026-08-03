"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const audit_service_1 = require("./audit.service");
const audit_entity_1 = require("./audit.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const billing_engine_service_1 = require("../billing-engine/billing-engine.service");
const audit_history_service_1 = require("../audit-history/audit-history.service");
const domain_event_publisher_1 = require("../../core/events/domain-event.publisher");
describe('AuditService', () => {
    let service;
    const mockAuditRepository = {
        create: jest.fn().mockImplementation((dto) => dto),
        save: jest.fn().mockImplementation((dto) => Promise.resolve({ id: 'aud-1', ...dto })),
        findOne: jest.fn(),
    };
    const mockBillingEngine = {
        syncPayableForAssignment: jest.fn().mockResolvedValue({ created: true, payableId: 'payable-1' }),
    };
    const mockHistoryService = {
        createRecord: jest.fn().mockResolvedValue(undefined),
    };
    const mockAssignmentRepository = {
        findOne: jest.fn(),
    };
    const mockPublisher = { publish: jest.fn() };
    beforeEach(async () => {
        mockAssignmentRepository.findOne.mockReset();
        mockBillingEngine.syncPayableForAssignment.mockReset();
        mockBillingEngine.syncPayableForAssignment.mockResolvedValue({ created: true, payableId: 'payable-1' });
        mockAuditRepository.findOne.mockReset();
        mockAuditRepository.create.mockImplementation((dto) => dto);
        mockAuditRepository.save.mockImplementation((dto) => Promise.resolve({ id: 'aud-1', ...dto }));
        mockPublisher.publish.mockReset();
        mockHistoryService.createRecord.mockReset();
        const module = await testing_1.Test.createTestingModule({
            providers: [
                audit_service_1.AuditService,
                { provide: (0, typeorm_1.getRepositoryToken)(audit_entity_1.AuditEntity), useValue: mockAuditRepository },
                { provide: (0, typeorm_1.getRepositoryToken)(assignment_entity_1.AssignmentEntity), useValue: mockAssignmentRepository },
                { provide: billing_engine_service_1.BillingEngineService, useValue: mockBillingEngine },
                { provide: audit_history_service_1.AuditHistoryService, useValue: mockHistoryService },
                { provide: domain_event_publisher_1.DomainEventPublisher, useValue: mockPublisher },
            ],
        }).compile();
        service = module.get(audit_service_1.AuditService);
    });
    it('should start an audit and record operational timeline event', async () => {
        const audit = await service.startAudit('assign-1', 'assayer-1', 'proj-1', 'br-1', new Date());
        expect(audit.status).toBe('IN_PROGRESS');
        expect(mockHistoryService.createRecord).toHaveBeenCalled();
    });
    it('books the assayer payable through the billing engine on close', async () => {
        mockAuditRepository.findOne.mockResolvedValueOnce({
            id: 'aud-1',
            assayerId: 'assayer-1',
            assignmentId: 'assign-1',
            status: 'IN_PROGRESS',
        });
        mockAssignmentRepository.findOne.mockResolvedValueOnce({ id: 'assign-1', agreedFee: 1000 });
        const closed = await service.closeAudit('aud-1', 1000, 200);
        expect(closed.status).toBe('CLOSED');
        expect(mockBillingEngine.syncPayableForAssignment).toHaveBeenCalledWith('assign-1', 'system');
        expect(mockPublisher.publish).toHaveBeenCalledWith('audit:closed', expect.objectContaining({ payableId: 'payable-1' }));
    });
    it('does not double-book when the payable already exists for the assignment', async () => {
        mockAuditRepository.findOne.mockResolvedValueOnce({
            id: 'aud-3',
            assayerId: 'assayer-1',
            assignmentId: 'assign-3',
            status: 'IN_PROGRESS',
        });
        mockAssignmentRepository.findOne.mockResolvedValueOnce({ id: 'assign-3', agreedFee: 900 });
        mockBillingEngine.syncPayableForAssignment.mockResolvedValueOnce({
            created: false, payableId: 'payable-existing', reason: 'payable already exists',
        });
        await service.closeAudit('aud-3');
        expect(mockBillingEngine.syncPayableForAssignment).toHaveBeenCalledTimes(1);
        expect(mockPublisher.publish).toHaveBeenCalledWith('audit:closed', expect.objectContaining({ payableId: 'payable-existing' }));
    });
    it('should default the payout to the assignment agreed fee when baseFee/travelAllowance are omitted', async () => {
        mockAuditRepository.findOne.mockResolvedValueOnce({
            id: 'aud-2',
            assayerId: 'assayer-1',
            assignmentId: 'assign-1',
            status: 'IN_PROGRESS',
        });
        mockAssignmentRepository.findOne.mockResolvedValueOnce({
            id: 'assign-1',
            agreedFee: 1500,
            proposedFee: 1400,
        });
        await service.closeAudit('aud-2');
        expect(mockAssignmentRepository.findOne).toHaveBeenCalledWith({ where: { id: 'assign-1' } });
        expect(mockPublisher.publish).toHaveBeenCalledWith('audit:closed', expect.objectContaining({ payload: expect.objectContaining({ baseFee: 1500, travelAllowance: 0 }) }));
    });
});
//# sourceMappingURL=audit.service.spec.js.map