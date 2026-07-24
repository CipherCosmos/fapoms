import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from './audit.service';
import { AuditEntity } from './audit.entity';
import { BillingService } from '../billing/billing.service';
import { LedgerService } from '../ledger/ledger.service';
import { AuditHistoryService } from '../audit-history/audit-history.service';

describe('AuditService', () => {
  let service: AuditService;

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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        {
          provide: getRepositoryToken(AuditEntity),
          useValue: mockAuditRepository,
        },
        {
          provide: BillingService,
          useValue: mockBillingService,
        },
        {
          provide: LedgerService,
          useValue: mockLedgerService,
        },
        {
          provide: AuditHistoryService,
          useValue: mockHistoryService,
        },
      ],
    }).compile();

    service = module.get<AuditService>(AuditService);
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
