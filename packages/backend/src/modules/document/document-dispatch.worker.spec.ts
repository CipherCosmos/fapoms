import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DocumentDispatchWorker } from './document-dispatch.worker';
import { DocumentEntity } from './document.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { DocumentService } from './document.service';
import { DocumentStatus, DocumentType, AssignmentStatus, DispatchMethod } from '@fapoms/shared';

/**
 * Auto-dispatch is a scheduled job with no one watching it, so a wrong date
 * source fails silently: the packet is simply never sent and the assayer turns
 * up with nothing.
 */
describe('DocumentDispatchWorker', () => {
  let worker: DocumentDispatchWorker;

  const iso = (offsetDays: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().split('T')[0];
  };

  const mockQuery = jest.fn();
  const mockDocumentRepo = { find: jest.fn(), manager: { query: mockQuery } };
  const mockAssignmentRepo = { findOne: jest.fn() };
  const mockDocumentService = { dispatchDocument: jest.fn().mockResolvedValue({}) };

  const doc = (overrides: any = {}) => ({
    id: 'doc-1',
    type: DocumentType.PRE_FIELD_AUDIT_PDF,
    status: DocumentStatus.UPLOADED,
    isActive: true,
    assessment: { id: 'asmt-1', projectId: 'proj-1', branchId: 'br-1', auditDate: null },
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAssignmentRepo.findOne.mockResolvedValue({ id: 'asn-1', status: AssignmentStatus.ACCEPTED });
    mockDocumentService.dispatchDocument.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentDispatchWorker,
        { provide: getRepositoryToken(DocumentEntity), useValue: mockDocumentRepo },
        { provide: getRepositoryToken(AssignmentEntity), useValue: mockAssignmentRepo },
        { provide: DocumentService, useValue: mockDocumentService },
      ],
    }).compile();
    worker = module.get(DocumentDispatchWorker);
  });

  it("dispatches from the branch's scheduled date even when the assessment copy is missing", async () => {
    // This is the real-world case that silently failed: the branch is scheduled,
    // but assessments.audit_date was never populated because the assignment had
    // not gone through a status change, so the packet was never sent.
    mockDocumentRepo.find.mockResolvedValue([doc()]);
    mockQuery.mockResolvedValue([{ project_id: 'proj-1', branch_id: 'br-1', scheduled_date: iso(1) }]);

    const result = await worker.autoDispatch({} as any);

    expect(result.dispatchedCount).toBe(1);
    expect(mockDocumentService.dispatchDocument).toHaveBeenCalledWith('doc-1', 'SYSTEM', DispatchMethod.AUTO);
  });

  it('uses the branch date, not a stale assessment copy pointing at a different day', async () => {
    // Branch was rescheduled forward; the assessment copy still holds the old date.
    // Reading the stale copy would fire days early.
    mockDocumentRepo.find.mockResolvedValue([
      doc({ assessment: { id: 'asmt-1', projectId: 'proj-1', branchId: 'br-1', auditDate: iso(-30) } }),
    ]);
    mockQuery.mockResolvedValue([{ project_id: 'proj-1', branch_id: 'br-1', scheduled_date: iso(10) }]);

    const result = await worker.autoDispatch({} as any);

    expect(result.dispatchedCount).toBe(0);
    expect(mockDocumentService.dispatchDocument).not.toHaveBeenCalled();
  });

  it('does not dispatch a branch with no confirmed date', async () => {
    mockDocumentRepo.find.mockResolvedValue([doc()]);
    mockQuery.mockResolvedValue([]); // nothing scheduled

    const result = await worker.autoDispatch({} as any);

    expect(result.dispatchedCount).toBe(0);
  });

  it('still sends a packet uploaded after its audit date had already arrived', async () => {
    mockDocumentRepo.find.mockResolvedValue([doc()]);
    mockQuery.mockResolvedValue([{ project_id: 'proj-1', branch_id: 'br-1', scheduled_date: iso(0) }]);

    const result = await worker.autoDispatch({} as any);

    expect(result.dispatchedCount).toBe(1);
  });

  it('does not dispatch when no assayer has accepted the assignment', async () => {
    mockDocumentRepo.find.mockResolvedValue([doc()]);
    mockQuery.mockResolvedValue([{ project_id: 'proj-1', branch_id: 'br-1', scheduled_date: iso(1) }]);
    mockAssignmentRepo.findOne.mockResolvedValue(null);

    const result = await worker.autoDispatch({} as any);

    expect(result.dispatchedCount).toBe(0);
  });
});
