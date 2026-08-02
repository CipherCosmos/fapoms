import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { DocumentService } from './document.service';
import { DocumentEntity } from './document.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NotificationService } from '../notifications/notification.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { DocumentType, DocumentStatus } from '@fapoms/shared';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { LocalStorageService } from '../../infrastructure/storage/local-storage.service';
import { ValidationService } from '../validation/validation.service';

describe('DocumentService', () => {
  let service: DocumentService;

  const mockManagerQuery = jest.fn();
  const mockDocumentRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    manager: { query: mockManagerQuery },
  };

  const mockAssessmentRepo = {
    findOne: jest.fn(),
  };

  const mockAssignmentRepo: any = {
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn(),
  };

  const mockProjectBranchRepo = {
    findOne: jest.fn().mockResolvedValue(null),
  };

  const mockAuditService = {
    recordEvent: jest.fn(),
  };

  const mockEventPublisher = {
    publish: jest.fn(),
  };

  const mockNotificationService = {
    create: jest.fn(),
  };

  const mockPushNotificationService = {
    sendToUser: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentService,
        { provide: getRepositoryToken(DocumentEntity), useValue: mockDocumentRepo },
        { provide: getRepositoryToken(AssessmentEntity), useValue: mockAssessmentRepo },
        { provide: getRepositoryToken(ProjectBranchEntity), useValue: mockProjectBranchRepo },
        { provide: getRepositoryToken(AssignmentEntity), useValue: mockAssignmentRepo },
        { provide: AuditService, useValue: mockAuditService },
        { provide: DomainEventPublisher, useValue: mockEventPublisher },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: PushNotificationService, useValue: mockPushNotificationService },
        { provide: LocalStorageService, useValue: { saveFile: jest.fn(), getFilePath: jest.fn() } },
        { provide: ValidationService, useValue: { getOrAdvanceForHandBack: jest.fn() } },
      ],
    }).compile();

    service = module.get<DocumentService>(DocumentService);
    jest.clearAllMocks();
  });

  /**
   * The dispatch gate is a real authorisation boundary: before it, any
   * authenticated assayer could list and download paperwork operations had not
   * released, for any branch.
   */
  describe('assayer dispatch gate', () => {
    const branchDoc = (type: DocumentType, status: DocumentStatus) => ({
      id: `doc-${status}`, type, status, assessmentId: 'asmt-1', dispatchedAt: null,
    });

    beforeEach(() => {
      mockAssessmentRepo.findOne.mockResolvedValue({ id: 'asmt-1', projectId: 'proj-1', branchId: 'br-1' });
      mockProjectBranchRepo.findOne.mockResolvedValue({ id: 'pb-1', projectId: 'proj-1', branchId: 'br-1' });
    });

    it('hides documents that have not been dispatched, and says why', async () => {
      mockDocumentRepo.find.mockResolvedValue([
        branchDoc(DocumentType.PRE_FIELD_AUDIT_PDF, DocumentStatus.UPLOADED),
      ]);

      const { documents, readiness } = await service.findDispatchedForAssayer('pb-1');

      expect(documents).toHaveLength(0);
      expect(readiness.state).toBe('PREPARING');
      expect(readiness.awaitingDispatchCount).toBe(1);
      // The assayer is told paperwork exists and is coming, rather than seeing a
      // bare empty list identical to "nothing prepared".
      expect(readiness.message).toMatch(/will be sent/i);
    });

    it('exposes documents once dispatched', async () => {
      mockDocumentRepo.find.mockResolvedValue([
        { ...branchDoc(DocumentType.PRE_FIELD_AUDIT_PDF, DocumentStatus.DISPATCHED), dispatchedAt: new Date('2026-07-30T10:00:00Z') },
      ]);

      const { documents, readiness } = await service.findDispatchedForAssayer('pb-1');

      expect(documents).toHaveLength(1);
      expect(readiness.state).toBe('READY');
      expect(readiness.lastDispatchedAt).toEqual(new Date('2026-07-30T10:00:00Z'));
    });

    it('never exposes internal document types even when dispatched', async () => {
      mockDocumentRepo.find.mockResolvedValue([
        branchDoc(DocumentType.FINAL_REPORT, DocumentStatus.DISPATCHED),
        branchDoc(DocumentType.GENERATED_EXCEL, DocumentStatus.COMPLETED),
      ]);

      const { documents, readiness } = await service.findDispatchedForAssayer('pb-1');

      expect(documents).toHaveLength(0);
      expect(readiness.state).toBe('NONE');
    });

    it('refuses a download token for an undispatched document', async () => {
      mockDocumentRepo.findOne.mockResolvedValue(
        branchDoc(DocumentType.PRE_FIELD_AUDIT_PDF, DocumentStatus.UPLOADED),
      );
      await expect(service.assertAssayerMayDownload('doc-1', 'assayer-1'))
        .rejects.toThrow(BadRequestException);
    });

    it('refuses a download for a branch the assayer is not assigned to', async () => {
      mockDocumentRepo.findOne.mockResolvedValue(
        branchDoc(DocumentType.PRE_FIELD_AUDIT_PDF, DocumentStatus.DISPATCHED),
      );
      // No assignment links this assayer to the document's branch.
      mockAssignmentRepo.createQueryBuilder = jest.fn(() => ({
        innerJoin: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(), getCount: jest.fn(async () => 0),
      }));
      await expect(service.assertAssayerMayDownload('doc-1', 'assayer-other'))
        .rejects.toThrow(BadRequestException);
    });

    it('allows a dispatched document for an assigned assayer', async () => {
      mockDocumentRepo.findOne.mockResolvedValue(
        branchDoc(DocumentType.PRE_FIELD_AUDIT_PDF, DocumentStatus.DISPATCHED),
      );
      mockAssignmentRepo.createQueryBuilder = jest.fn(() => ({
        innerJoin: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(), getCount: jest.fn(async () => 1),
      }));
      await expect(service.assertAssayerMayDownload('doc-1', 'assayer-1')).resolves.toBeUndefined();
    });
  });

  /**
   * The document console groups by branch (rather than listing one row per
   * file) specifically so a branch with several documents doesn't read as that
   * branch being "listed twice" — and so branches with zero documents, which a
   * flat per-document list can never show, still surface as a gap.
   */
  describe('operationsOverview branch grouping', () => {
    beforeEach(() => {
      mockManagerQuery.mockReset();
    });

    it("groups a branch's multiple documents under one entry instead of repeating its name", async () => {
      mockManagerQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM documents d')) {
          return [
            { id: 'doc-1', file_name: 'pre-audit.pdf', file_size: 100, type: 'PRE_FIELD_AUDIT_PDF', status: 'DISPATCHED', doc_version: 1, created_at: new Date(), project_branch_id: 'pb-1', branch_name: 'Pune Main Branch', branch_code: 'BR-1', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', scheduled_date: null },
            { id: 'doc-2', file_name: 'return.pdf', file_size: 200, type: 'AUDITED_RETURN_PDF', status: 'RECEIVED', doc_version: 1, created_at: new Date(), project_branch_id: 'pb-1', branch_name: 'Pune Main Branch', branch_code: 'BR-1', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', scheduled_date: null },
          ];
        }
        if (sql.includes('FROM project_branches pb')) {
          return [
            { project_branch_id: 'pb-1', pb_status: 'AUDIT_COMPLETED', scheduled_date: null, branch_id: 'br-1', branch_name: 'Pune Main Branch', branch_code: 'BR-1', project_id: 'proj-1', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', assessment_status: 'COMPLETED' },
          ];
        }
        return [];
      });

      const result = await service.operationsOverview();

      // One branch entry, not two — even though it has two documents.
      expect(result.branches).toHaveLength(1);
      expect(result.branches[0].documentCount).toBe(2);
      expect(Object.keys(result.branches[0].documentsByType).sort()).toEqual(['AUDITED_RETURN_PDF', 'PRE_FIELD_AUDIT_PDF']);
    });

    it('flags a branch with a confirmed audit date but zero prepared paperwork', async () => {
      mockManagerQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM documents d')) return [];
        if (sql.includes('FROM project_branches pb')) {
          return [
            { project_branch_id: 'pb-2', pb_status: 'SCHEDULED', scheduled_date: '2026-08-20', branch_id: 'br-2', branch_name: 'Untouched Branch', branch_code: 'BR-2', project_id: 'proj-1', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', assessment_status: 'ASSIGNED_AND_SCHEDULED' },
          ];
        }
        return [];
      });

      const result = await service.operationsOverview();

      expect(result.neverPrepared).toHaveLength(1);
      expect(result.neverPrepared[0].branchName).toBe('Untouched Branch');
      expect(result.totals.neverPrepared).toBe(1);
    });

    it('does not flag a branch whose paperwork already exists', async () => {
      mockManagerQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM documents d')) {
          return [
            { id: 'doc-1', file_name: 'pre-audit.pdf', file_size: 100, type: 'PRE_FIELD_AUDIT_PDF', status: 'UPLOADED', doc_version: 1, created_at: new Date(), project_branch_id: 'pb-3', branch_name: 'Prepared Branch', branch_code: 'BR-3', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', scheduled_date: '2026-08-20' },
          ];
        }
        if (sql.includes('FROM project_branches pb')) {
          return [
            { project_branch_id: 'pb-3', pb_status: 'SCHEDULED', scheduled_date: '2026-08-20', branch_id: 'br-3', branch_name: 'Prepared Branch', branch_code: 'BR-3', project_id: 'proj-1', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', assessment_status: 'READY_FOR_DISPATCH' },
          ];
        }
        return [];
      });

      const result = await service.operationsOverview();

      expect(result.neverPrepared).toHaveLength(0);
    });

    it('does not flag a branch that has no assayer confirmed yet', async () => {
      mockManagerQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM documents d')) return [];
        if (sql.includes('FROM project_branches pb')) {
          return [
            // CANDIDATE_SEARCH: no assayer confirmed, so there is nothing to prepare
            // paperwork *for* yet — this is a staffing gap, not a document gap.
            { project_branch_id: 'pb-4', pb_status: 'CANDIDATE_SEARCH', scheduled_date: '2026-08-20', branch_id: 'br-4', branch_name: 'Unstaffed Branch', branch_code: 'BR-4', project_id: 'proj-1', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', assessment_status: null },
          ];
        }
        return [];
      });

      const result = await service.operationsOverview();

      expect(result.neverPrepared).toHaveLength(0);
    });
  });

  /**
   * Filename matching decides which branch's customers reach which assayer, so a
   * wrong guess is a confidentiality breach, not a UI annoyance. It must place a
   * file only when it is certain.
   */
  describe('matchPdfsToBranches', () => {
    const scheduled = [
      { project_branch_id: 'pb-1', branch_name: 'Pune Main Branch', branch_code: 'BR-0010' },
      { project_branch_id: 'pb-2', branch_name: 'Pune Yerwada Branch', branch_code: 'BR-0016' },
      { project_branch_id: 'pb-3', branch_name: 'Nashik Main Branch', branch_code: 'BR-0020' },
    ];

    beforeEach(() => {
      mockManagerQuery.mockReset();
      mockManagerQuery.mockResolvedValue(scheduled);
    });

    it('matches on branch code regardless of punctuation or case', async () => {
      const r = await service.matchPdfsToBranches('proj-1', '2026-08-20', [
        'audit_BR-0010_20Aug.pdf',
        'br0016-packet.pdf',
      ]);
      expect(r.matches.map((m) => m.projectBranchId).sort()).toEqual(['pb-1', 'pb-2']);
      expect(r.matches.every((m) => m.matchedOn === 'CODE')).toBe(true);
      expect(r.unmatched).toHaveLength(0);
    });

    it('falls back to branch name when no code is present', async () => {
      const r = await service.matchPdfsToBranches('proj-1', '2026-08-20', ['Yerwada 20-08.pdf']);
      expect(r.matches).toHaveLength(1);
      expect(r.matches[0].projectBranchId).toBe('pb-2');
      expect(r.matches[0].matchedOn).toBe('NAME');
    });

    it('refuses to place a file that matches more than one branch', async () => {
      // "Main" appears in both Pune Main and Nashik Main — guessing here would send
      // one branch's customer paperwork to another branch's assayer.
      const r = await service.matchPdfsToBranches('proj-1', '2026-08-20', ['Main.pdf']);
      expect(r.matches).toHaveLength(0);
      expect(r.unmatched[0].reason).toMatch(/Matches 2 branches/);
    });

    it('refuses an unrecognised filename rather than guessing', async () => {
      const r = await service.matchPdfsToBranches('proj-1', '2026-08-20', ['scan001.pdf']);
      expect(r.matches).toHaveLength(0);
      expect(r.unmatched[0].reason).toMatch(/No scheduled branch matches/);
    });

    it('does not let two files claim the same branch', async () => {
      const r = await service.matchPdfsToBranches('proj-1', '2026-08-20', [
        'BR-0010_v1.pdf',
        'BR-0010_v2.pdf',
      ]);
      expect(r.matches).toHaveLength(1);
      expect(r.unmatched[0].reason).toMatch(/already matched/);
    });

    it('reports scheduled branches the upload did not cover', async () => {
      const r = await service.matchPdfsToBranches('proj-1', '2026-08-20', ['BR-0010.pdf']);
      expect(r.branchesWithoutFile.map((b) => b.projectBranchId).sort()).toEqual(['pb-2', 'pb-3']);
    });
  });

  describe('create', () => {
    it('should throw NotFoundException if assessment does not exist', async () => {
      mockAssessmentRepo.findOne.mockResolvedValue(null);
      // Explicit: the dispatch-gate suite above points this at a real branch, and
      // clearAllMocks() does not reset a mockResolvedValue. Without this, create()
      // would find a project branch and auto-create an assessment instead of throwing.
      mockProjectBranchRepo.findOne.mockResolvedValue(null);

      await expect(
        service.create(
          {
            assessmentId: 'asmt-missing',
            fileName: 'test.pdf',
            filePath: '/path/test.pdf',
            fileSize: 1024,
            type: DocumentType.PRE_FIELD_AUDIT_PDF,
          },
          'user-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
