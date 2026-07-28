import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LedgerService } from './ledger.service';
import { LedgerEntry } from './ledger-entry.entity';

describe('LedgerService', () => {
  let service: LedgerService;

  let currentBalance = 0;
  const mockEntityManager = {
    query: jest.fn().mockImplementation((sql: string) => {
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
      transaction: jest.fn().mockImplementation((cb: any) => cb(mockEntityManager)),
    },
    create: jest.fn().mockImplementation((dto) => dto),
    save: jest.fn().mockImplementation((dto) => Promise.resolve({ id: 'led-1', ...dto })),
    findOne: jest.fn(),
    find: jest.fn(),
  };

  beforeEach(async () => {
    currentBalance = 0;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LedgerService,
        {
          provide: getRepositoryToken(LedgerEntry),
          useValue: mockLedgerRepository,
        },
      ],
    }).compile();

    service = module.get<LedgerService>(LedgerService);
  });

  it('should compute running balances correctly on credit and debit entries', async () => {
    // 1. Initial credit entry
    let entry = await service.addEntry('assayer-1', 'CREDIT', 500);
    expect(entry.runningBalance).toBe(500);

    // 2. Next debit entry
    entry = await service.addEntry('assayer-1', 'DEBIT', 200);
    expect(entry.runningBalance).toBe(300);
  });
});
