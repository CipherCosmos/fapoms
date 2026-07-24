"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const audit_service_1 = require("./audit.service");
const audit_entity_1 = require("./audit.entity");
const billing_service_1 = require("../billing/billing.service");
const ledger_service_1 = require("../ledger/ledger.service");
const audit_history_service_1 = require("../audit-history/audit-history.service");
describe('AuditService', () => {
    let service;
    const mockAuditRepository = {
        create: jest.fn().mockImplementation((dto) => dto),
        save: jest.fn().mockImplementation((dto) => Promise.resolve({ id: 'aud-1', ...dto })),
        findOne: jest.fn(),
    };
    const mockBillingService = {
        createBillingRecord: jest.fn().mockResolvedValue({ id: 'bill-1', netPayable: 1188 }),
    };
    const mockLedgerService = {
        addEntry: jest.fn().mockResolvedValue(undefined),
    };
    const mockHistoryService = {
        createRecord: jest.fn().mockResolvedValue(undefined),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                audit_service_1.AuditService,
                {
                    provide: (0, typeorm_1.getRepositoryToken)(audit_entity_1.AuditEntity),
                    useValue: mockAuditRepository,
                },
                {
                    provide: billing_service_1.BillingService,
                    useValue: mockBillingService,
                },
                {
                    provide: ledger_service_1.LedgerService,
                    useValue: mockLedgerService,
                },
                {
                    provide: audit_history_service_1.AuditHistoryService,
                    useValue: mockHistoryService,
                },
            ],
        }).compile();
        service = module.get(audit_service_1.AuditService);
    });
    it('should start an audit and record operational timeline event', async () => {
        const audit = await service.startAudit('assign-1', 'assayer-1', 'proj-1', 'br-1', new Date());
        expect(audit.status).toBe('IN_PROGRESS');
        expect(mockHistoryService.createRecord).toHaveBeenCalled();
    });
    it('should close audit, compile billing record, and post to financial ledger', async () => {
        mockAuditRepository.findOne.mockResolvedValueOnce({
            id: 'aud-1',
            assayerId: 'assayer-1',
            status: 'IN_PROGRESS',
        });
        const closed = await service.closeAudit('aud-1', 1000, 200);
        expect(closed.status).toBe('CLOSED');
        expect(mockBillingService.createBillingRecord).toHaveBeenCalled();
        expect(mockLedgerService.addEntry).toHaveBeenCalledWith('assayer-1', 'CREDIT', 1188, 'bill-1');
    });
});
//# sourceMappingURL=audit.service.spec.js.map