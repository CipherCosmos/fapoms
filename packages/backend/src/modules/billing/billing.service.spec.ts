import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BillingService } from './billing.service';
import { BillingRecord } from './billing-record.entity';

describe('BillingService', () => {
  let service: BillingService;

  const mockBillingRepository = {
    create: jest.fn().mockImplementation((dto) => dto),
    save: jest.fn().mockImplementation((dto) => Promise.resolve({ id: 'bill-1', ...dto })),
    find: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        {
          provide: getRepositoryToken(BillingRecord),
          useValue: mockBillingRepository,
        },
      ],
    }).compile();

    service = module.get<BillingService>(BillingService);
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

    // Taxable: 1000 + 200 - 100 = 1100
    // GST (18%): 198
    // TDS (10%): 110
    // Net Payable: 1100 + 198 - 110 = 1188
    expect(record.gst).toBe(198);
    expect(record.tds).toBe(110);
    expect(record.netPayable).toBe(1188);
  });
});
