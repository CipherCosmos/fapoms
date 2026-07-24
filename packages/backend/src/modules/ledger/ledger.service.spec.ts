import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LedgerService } from './ledger.service';
import { LedgerEntry } from './ledger-entry.entity';

describe('LedgerService', () => {
  let service: LedgerService;

  const mockLedgerRepository = {
    create: jest.fn().mockImplementation((dto) => dto),
    save: jest.fn().mockImplementation((dto) => Promise.resolve({ id: 'led-1', ...dto })),
    findOne: jest.fn(),
    find: jest.fn(),
  };

  beforeEach(async () => {
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
    mockLedgerRepository.findOne.mockResolvedValueOnce(null);
    let entry = await service.addEntry('assayer-1', 'CREDIT', 500);
    expect(entry.runningBalance).toBe(500);

    // 2. Next debit entry
    mockLedgerRepository.findOne.mockResolvedValueOnce({ runningBalance: 500 });
    entry = await service.addEntry('assayer-1', 'DEBIT', 200);
    expect(entry.runningBalance).toBe(300);
  });
});
