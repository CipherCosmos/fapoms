import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from './audit.service';
import { AuditEntity } from './audit.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { BillingEngineService } from '../billing-engine/billing-engine.service';
import { AuditHistoryService } from '../audit-history/audit-history.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

describe('AuditService', () => {
  let service: AuditService;

  const mockAuditRepository = {
    create: jest.fn().mockImplementation((dto) => dto),
    save: jest.fn().mockImplementation((dto) => Promise.resolve({ id: 'aud-1', ...dto })),
    findOne: jest.fn(),
  };

  // Closing an audit books the assayer's payable through the one billing engine.
  // It used to write a separate billing record and hand-credit a running balance
  // in a second module, duplicating the obligation already raised when the
  // assignment completed.
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
    // mockReset (not clearAllMocks) because these mocks queue one-shot values with
    // mockResolvedValueOnce: clearing only wipes call history, so an unconsumed
    // queued value leaks into the next test and silently changes its inputs.
    mockAssignmentRepository.findOne.mockReset();
    mockBillingEngine.syncPayableForAssignment.mockReset();
    mockBillingEngine.syncPayableForAssignment.mockResolvedValue({ created: true, payableId: 'payable-1' });
    mockAuditRepository.findOne.mockReset();
    mockAuditRepository.create.mockImplementation((dto: any) => dto);
    mockAuditRepository.save.mockImplementation((dto: any) => Promise.resolve({ id: 'aud-1', ...dto }));
    mockPublisher.publish.mockReset();
    mockHistoryService.createRecord.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: getRepositoryToken(AuditEntity), useValue: mockAuditRepository },
        { provide: getRepositoryToken(AssignmentEntity), useValue: mockAssignmentRepository },
        { provide: BillingEngineService, useValue: mockBillingEngine },
        { provide: AuditHistoryService, useValue: mockHistoryService },
        { provide: DomainEventPublisher, useValue: mockPublisher },
      ],
    }).compile();

    service = module.get<AuditService>(AuditService);
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
    // Assignment completion already raised the payable; closing the audit must not
    // create a second obligation for the same work.
    mockBillingEngine.syncPayableForAssignment.mockResolvedValueOnce({
      created: false, payableId: 'payable-existing', reason: 'payable already exists',
    });

    await service.closeAudit('aud-3');

    expect(mockBillingEngine.syncPayableForAssignment).toHaveBeenCalledTimes(1);
    expect(mockPublisher.publish).toHaveBeenCalledWith(
      'audit:closed',
      expect.objectContaining({ payableId: 'payable-existing' }),
    );
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
    expect(mockPublisher.publish).toHaveBeenCalledWith(
      'audit:closed',
      expect.objectContaining({ payload: expect.objectContaining({ baseFee: 1500, travelAllowance: 0 }) }),
    );
  });
});
