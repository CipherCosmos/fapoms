"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const ledger_service_1 = require("./ledger.service");
const ledger_entry_entity_1 = require("./ledger-entry.entity");
describe('LedgerService', () => {
    let service;
    const mockLedgerRepository = {
        create: jest.fn().mockImplementation((dto) => dto),
        save: jest.fn().mockImplementation((dto) => Promise.resolve({ id: 'led-1', ...dto })),
        findOne: jest.fn(),
        find: jest.fn(),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                ledger_service_1.LedgerService,
                {
                    provide: (0, typeorm_1.getRepositoryToken)(ledger_entry_entity_1.LedgerEntry),
                    useValue: mockLedgerRepository,
                },
            ],
        }).compile();
        service = module.get(ledger_service_1.LedgerService);
    });
    it('should compute running balances correctly on credit and debit entries', async () => {
        mockLedgerRepository.findOne.mockResolvedValueOnce(null);
        let entry = await service.addEntry('assayer-1', 'CREDIT', 500);
        expect(entry.runningBalance).toBe(500);
        mockLedgerRepository.findOne.mockResolvedValueOnce({ runningBalance: 500 });
        entry = await service.addEntry('assayer-1', 'DEBIT', 200);
        expect(entry.runningBalance).toBe(300);
    });
});
//# sourceMappingURL=ledger.service.spec.js.map