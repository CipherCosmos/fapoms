"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const ledger_service_1 = require("./ledger.service");
const ledger_entry_entity_1 = require("./ledger-entry.entity");
describe('LedgerService', () => {
    let service;
    let currentBalance = 0;
    const mockEntityManager = {
        query: jest.fn().mockImplementation((sql) => {
            if (sql.includes('SELECT running_balance')) {
                return Promise.resolve([{ running_balance: currentBalance }]);
            }
            if (sql.includes('UPDATE assayers SET running_balance')) {
                return Promise.resolve();
            }
            return Promise.resolve([]);
        }),
        create: jest.fn().mockImplementation((entity, dto) => dto),
        save: jest.fn().mockImplementation((dto) => {
            currentBalance = dto.runningBalance;
            return Promise.resolve({ id: 'led-1', ...dto });
        }),
    };
    const mockLedgerRepository = {
        manager: {
            transaction: jest.fn().mockImplementation((cb) => cb(mockEntityManager)),
        },
        create: jest.fn().mockImplementation((dto) => dto),
        save: jest.fn().mockImplementation((dto) => Promise.resolve({ id: 'led-1', ...dto })),
        findOne: jest.fn(),
        find: jest.fn(),
    };
    beforeEach(async () => {
        currentBalance = 0;
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
        let entry = await service.addEntry('assayer-1', 'CREDIT', 500);
        expect(entry.runningBalance).toBe(500);
        entry = await service.addEntry('assayer-1', 'DEBIT', 200);
        expect(entry.runningBalance).toBe(300);
    });
});
//# sourceMappingURL=ledger.service.spec.js.map