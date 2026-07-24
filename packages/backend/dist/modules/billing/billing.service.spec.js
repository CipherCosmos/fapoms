"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const billing_service_1 = require("./billing.service");
const billing_record_entity_1 = require("./billing-record.entity");
describe('BillingService', () => {
    let service;
    const mockBillingRepository = {
        create: jest.fn().mockImplementation((dto) => dto),
        save: jest.fn().mockImplementation((dto) => Promise.resolve({ id: 'bill-1', ...dto })),
        find: jest.fn(),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                billing_service_1.BillingService,
                {
                    provide: (0, typeorm_1.getRepositoryToken)(billing_record_entity_1.BillingRecord),
                    useValue: mockBillingRepository,
                },
            ],
        }).compile();
        service = module.get(billing_service_1.BillingService);
    });
    it('should compile billing fees including GST & TDS correctly', async () => {
        const record = await service.createBillingRecord({
            auditId: 'audit-123',
            assayerId: 'assayer-456',
            baseFee: 1000,
            travelAllowance: 200,
            penalties: 100,
        });
        expect(record.baseFee).toBe(1000);
        expect(record.travelAllowance).toBe(200);
        expect(record.penalties).toBe(100);
        expect(record.gst).toBe(198);
        expect(record.tds).toBe(110);
        expect(record.netPayable).toBe(1188);
    });
});
//# sourceMappingURL=billing.service.spec.js.map