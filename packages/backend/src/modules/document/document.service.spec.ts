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
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
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
    find: jest.fn(),
  };

  const mockAssignmentRepo: any = {
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn(),
  };

  const mockProjectBranchRepo = {
    findOne: jest.fn().mockResolvedValue(null),
  };

  const mockAuditService = {
    recordEvent: jest.fn(), recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); }),
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
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn(), emit: jest.fn() } },
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
    /**
     * The branch list is three queries now — the page, its count, and the never-prepared alert
     * list — where it used to be one unbounded SELECT the service filtered in JS. They all read
     * `FROM project_branches pb`, so the mock routes on what makes each distinct.
     */
    const BRANCH_LIST_SQL = 'LIMIT $';
    const BRANCH_COUNT_SQL = 'COUNT(*)::int';
    const NEVER_PREPARED_SQL = 'gap_total';

    /** Captures the SQL the service actually emitted, so a query can be asserted on by name. */
    const emitted = () => mockManagerQuery.mock.calls.map((c) => String(c[0]));
    const sqlFor = (marker: string) => emitted().find((s) => s.includes(marker)) ?? '';
    const paramsFor = (marker: string) =>
      (mockManagerQuery.mock.calls.find((c) => String(c[0]).includes(marker))?.[1] ?? []) as any[];

    /**
     * @param docs        rows for the flat documents query
     * @param branchRows  rows for the branch page
     * @param gapRows     rows for the never-prepared alert list
     * @param total       what COUNT(*) reports for the filtered set
     */
    const mockQueries = (opts: { docs?: any[]; branchRows?: any[]; gapRows?: any[]; total?: number } = {}) => {
      mockManagerQuery.mockImplementation(async (sql: string) => {
        // Order matters: every branch query embeds a `FROM documents d2` subquery, which the
        // flat-documents check below would otherwise swallow. Most specific marker first.
        if (sql.includes(BRANCH_COUNT_SQL)) return [{ n: opts.total ?? (opts.branchRows?.length ?? 0) }];
        if (sql.includes(NEVER_PREPARED_SQL)) return opts.gapRows ?? [];
        if (sql.includes(BRANCH_LIST_SQL)) return opts.branchRows ?? [];
        if (sql.includes('FROM documents d')) return opts.docs ?? [];
        return [];
      });
    };

    const branchRow = (over: Record<string, any> = {}) => ({
      project_branch_id: 'pb-1', scheduled_date: null,
      branch_name: 'Pune Main Branch', branch_code: 'BR-1',
      project_name: 'P1', client_name: 'SBI', never_prepared: false, ...over,
    });

    beforeEach(() => {
      mockManagerQuery.mockReset();
    });

    it("groups a branch's multiple documents under one entry instead of repeating its name", async () => {
      mockQueries({
        docs: [
          { id: 'doc-1', file_name: 'pre-audit.pdf', file_size: 100, type: 'PRE_FIELD_AUDIT_PDF', status: 'DISPATCHED', doc_version: 1, created_at: new Date(), project_branch_id: 'pb-1', branch_name: 'Pune Main Branch', branch_code: 'BR-1', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', scheduled_date: null },
          { id: 'doc-2', file_name: 'return.pdf', file_size: 200, type: 'AUDITED_RETURN_PDF', status: 'RECEIVED', doc_version: 1, created_at: new Date(), project_branch_id: 'pb-1', branch_name: 'Pune Main Branch', branch_code: 'BR-1', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', scheduled_date: null },
        ],
        branchRows: [branchRow()],
      });

      const result = await service.operationsOverview();

      // One branch entry, not two — even though it has two documents.
      expect(result.branches).toHaveLength(1);
      expect(result.branches[0].documentCount).toBe(2);
      expect(Object.keys(result.branches[0].documentsByType).sort()).toEqual(['AUDITED_RETURN_PDF', 'PRE_FIELD_AUDIT_PDF']);
    });

    it('drops the columns nothing renders, and the 200k-row join that fed one of them', async () => {
      mockQueries({ branchRows: [branchRow()] });

      const result = await service.operationsOverview();

      // Every field here was serialised for all 40,087 rows and read by nobody.
      for (const dead of ['branchId', 'projectId', 'projectNumber', 'branchStatus', 'assessmentStatus']) {
        expect(result.branches[0]).not.toHaveProperty(dead);
      }
      // `assessmentStatus` was the only reason the branch query joined `assessments`.
      expect(sqlFor(BRANCH_LIST_SQL)).not.toContain('JOIN assessments a ');
      // What the panel does render must still be there.
      expect(result.branches[0]).toMatchObject({
        projectBranchId: 'pb-1', branchName: 'Pune Main Branch', branchCode: 'BR-1',
        projectName: 'P1', clientName: 'SBI',
      });
    });

    it('windows the branch list and reports the total it was cut from', async () => {
      mockQueries({ branchRows: [branchRow()], total: 40087 });

      const result = await service.operationsOverview({ page: 3, limit: 25 });

      expect(result.branchPagination).toEqual({ page: 3, limit: 25, total: 40087 });
      // 25 rows, skipping the first two pages.
      expect(paramsFor(BRANCH_LIST_SQL).slice(-2)).toEqual([25, 50]);
    });

    it('clamps the window so a caller cannot ask for the whole table back', async () => {
      mockQueries({ branchRows: [] });

      const result = await service.operationsOverview({ page: '-3', limit: '999999' });

      // The ceiling is the entire point: `?limit=999999` must not restore the 17 MB response.
      expect(result.branchPagination).toMatchObject({ page: 1, limit: 100 });
      expect(paramsFor(BRANCH_LIST_SQL).slice(-2)).toEqual([100, 0]);
    });

    it('resolves junk paging input to the default rather than NaN', async () => {
      mockQueries({ branchRows: [] });

      // NaN as an OFFSET makes Postgres reject the statement outright.
      const result = await service.operationsOverview({ page: 'abc', limit: 'xyz' });

      expect(result.branchPagination).toMatchObject({ page: 1, limit: 25 });
      expect(paramsFor(BRANCH_LIST_SQL).slice(-2)).toEqual([25, 0]);
    });

    it('searches in SQL across the same four fields the panel used to filter on', async () => {
      mockQueries({ branchRows: [] });

      await service.operationsOverview({ search: 'Pune' });

      const sql = sqlFor(BRANCH_LIST_SQL);
      expect(sql).toContain('b.name ILIKE');
      expect(sql).toContain('b.branch_code ILIKE');
      expect(sql).toContain('p.name ILIKE');
      expect(sql).toContain('c.name ILIKE');
      expect(paramsFor(BRANCH_LIST_SQL)).toContain('%Pune%');
      // The count has to see the same filter, or the pager reports a total for a different set.
      expect(paramsFor(BRANCH_COUNT_SQL)).toContain('%Pune%');
    });

    it('filters by stage in SQL, so the chips count the book and not the page', async () => {
      mockQueries({ branchRows: [] });

      await service.operationsOverview({ stage: DocumentStatus.DISPATCHED });

      expect(sqlFor(BRANCH_LIST_SQL)).toContain('EXISTS (SELECT 1 FROM documents d2');
      expect(paramsFor(BRANCH_LIST_SQL)).toContain(DocumentStatus.DISPATCHED);
    });

    /**
     * The never-prepared rule — audit confirmed, no packet prepared at all — used to be a JS
     * `.filter()` over every branch in the book. It is a SQL predicate now, so what is left to
     * verify here is that the rule kept its three parts and is applied wherever it is claimed.
     */
    it('keeps the never-prepared rule intact when expressing it as SQL', async () => {
      mockQueries({ branchRows: [branchRow()] });

      await service.operationsOverview();

      const gapSql = sqlFor(NEVER_PREPARED_SQL);
      // A date is set...
      expect(gapSql).toContain('pb.scheduled_date IS NOT NULL');
      // ...an assayer is confirmed (CANDIDATE_SEARCH is a staffing gap, not a document gap)...
      expect(gapSql).toContain("pb.status IN ('ASSIGNMENT_CONFIRMED', 'SCHEDULED')");
      // ...and no audit packet exists.
      expect(gapSql).toContain('NOT EXISTS');
      expect(paramsFor(NEVER_PREPARED_SQL)).toContain(DocumentType.PRE_FIELD_AUDIT_PDF);
    });

    it('reports the true never-prepared count even when the alert list is capped', async () => {
      const gapRows = Array.from({ length: 50 }, (_, i) => branchRow({
        project_branch_id: `pb-gap-${i}`, branch_name: `Untouched ${i}`,
        scheduled_date: '2026-08-20', never_prepared: true, gap_total: '137',
      }));
      mockQueries({ branchRows: [], gapRows });

      const result = await service.operationsOverview();

      // The banner shows 50; it must not claim there are only 50.
      expect(result.neverPrepared).toHaveLength(50);
      expect(result.neverPrepared[0].branchName).toBe('Untouched 0');
      expect(result.totals.neverPrepared).toBe(137);
    });

    it('flags the gap on the branch row itself, so a page can be judged without the gap list', async () => {
      mockQueries({
        branchRows: [
          branchRow({ project_branch_id: 'pb-ok', branch_name: 'Prepared Branch', never_prepared: false }),
          branchRow({ project_branch_id: 'pb-gap', branch_name: 'Untouched Branch', never_prepared: true }),
        ],
      });

      const result = await service.operationsOverview();

      // `neverPrepared.some(...)` in the browser only worked while the browser held every branch.
      expect(result.branches.map((b: any) => b.neverPrepared)).toEqual([false, true]);
    });

    it('leaves the never-prepared banner unfiltered by search, which scopes only the list', async () => {
      mockQueries({ branchRows: [] });

      await service.operationsOverview({ search: 'Pune' });

      // "What has nothing prepared" is a property of the book, not of what was typed.
      expect(paramsFor(NEVER_PREPARED_SQL)).not.toContain('%Pune%');
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

  /**
   * `findByProject` passed the assessment-id array straight into `where` cast to `any`, which
   * TypeORM renders as `assessment_id = $1` with a Postgres array literal — the endpoint 500'd
   * with `invalid input syntax for type uuid: "{...}"` for any project that had assessments.
   * The empty case was worse: `assessmentId: undefined` is dropped from the WHERE clause
   * entirely, so a project with none returned every document in the system.
   */
  describe('findByProject', () => {
    it('filters by assessment ids using In(), not an array equality', async () => {
      mockAssessmentRepo.find.mockResolvedValue([{ id: 'a-1' }, { id: 'a-2' }]);
      mockDocumentRepo.find.mockResolvedValue([]);

      await service.findByProject('p-1');

      const where = mockDocumentRepo.find.mock.calls[0][0].where;
      // A FindOperator, not a bare array — the bare array is what produced invalid SQL.
      expect(Array.isArray(where.assessmentId)).toBe(false);
      expect(where.assessmentId).toEqual(expect.objectContaining({ type: 'in', value: ['a-1', 'a-2'] }));
    });

    it('returns nothing for a project with no assessments, rather than every document', async () => {
      mockAssessmentRepo.find.mockResolvedValue([]);
      mockDocumentRepo.find.mockClear();

      await expect(service.findByProject('empty-project')).resolves.toEqual([]);
      // Must not fall through to an unfiltered query.
      expect(mockDocumentRepo.find).not.toHaveBeenCalled();
    });
  });
});
