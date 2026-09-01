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
import { DocumentType, DocumentStatus, DispatchMethod } from '@fapoms/shared';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { LocalStorageService } from '../../infrastructure/storage/local-storage.service';
import { ValidationService } from '../validation/validation.service';
import { EmailProvider } from '../../infrastructure/notifications/email-provider';
import { BranchEntity } from '../branch/branch.entity';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';

describe('DocumentService', () => {
  let service: DocumentService;

  const mockManagerQuery = jest.fn();
  const mockStorage = { getFileStream: jest.fn(), saveFile: jest.fn(), deleteFile: jest.fn(), statFile: jest.fn() };
  const mockEmailProvider = { isEnabled: jest.fn().mockReturnValue(false), send: jest.fn() };
  // Returns a promise: the write-back is fire-and-forget with a .catch() on it.
  const mockBranchRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }), findOne: jest.fn() };

  const mockDocumentRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    createQueryBuilder: jest.fn(),
    manager: { query: mockManagerQuery },
  };

  const mockAssessmentRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
  };

  const mockAssignmentRepo: any = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
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

  // Defaults to Off — the existing suite exercises no region scoping at all, and Off is the
  // mode where every list/filter helper below returns immediately without even reading scope.
  const mockRegionGuard = {
    stagedMode: jest.fn().mockResolvedValue('off'),
    assertRegionAllowedStaged: jest.fn(),
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
        // Dispatch to a branch reads the file back and emails it; nothing in this file exercises
        // that path, so these stand in rather than being modelled.
        { provide: 'StorageEngine', useValue: mockStorage },
        { provide: EmailProvider, useValue: mockEmailProvider },
        { provide: getRepositoryToken(BranchEntity), useValue: mockBranchRepo },
        { provide: RegionGuardService, useValue: mockRegionGuard },
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
  /**
   * The guard on the status column itself.
   *
   * `updateStatus` is what every transition funnels through, and it used to write whatever it
   * was given. These pin that it now refuses a rewind, and that a retry landing on the state it
   * was aiming for still succeeds — the dispatch worker and the receive path both retry, and
   * treating "already there" as a failure would turn a successful retry into an error.
   */
  describe('updateStatus transition guard', () => {
    const doc = (status: DocumentStatus) => ({
      id: 'doc-1', fileName: 'return.pdf', status, assessmentId: 'as-1', isActive: true,
    });

    beforeEach(() => {
      mockDocumentRepo.save.mockImplementation(async (d: any) => d);
      mockAuditService.recordEvent.mockResolvedValue(undefined);
    });

    it('refuses to send a finished packet back to the start of the pipeline', async () => {
      mockDocumentRepo.findOne.mockResolvedValue(doc(DocumentStatus.COMPLETED));

      await expect(service.updateStatus('doc-1', DocumentStatus.UPLOADED, 'u-1'))
        .rejects.toThrow(BadRequestException);
      // And nothing was written — the refusal has to happen before the save, or the audit
      // trail records a transition that the packet did not make.
      expect(mockDocumentRepo.save).not.toHaveBeenCalled();
    });

    it('refuses to un-receive a packet that is already with data entry', async () => {
      mockDocumentRepo.findOne.mockResolvedValue(doc(DocumentStatus.SENT_TO_DATA_ENTRY));

      await expect(service.updateStatus('doc-1', DocumentStatus.RECEIVED, 'u-1'))
        .rejects.toThrow(/only moves forward/i);
    });

    it('allows the step the pipeline actually takes', async () => {
      mockDocumentRepo.findOne.mockResolvedValue(doc(DocumentStatus.RECEIVED));

      const saved = await service.updateStatus('doc-1', DocumentStatus.SENT_TO_DATA_ENTRY, 'u-1');

      expect(saved.status).toBe(DocumentStatus.SENT_TO_DATA_ENTRY);
      expect(mockDocumentRepo.save).toHaveBeenCalled();
    });

    it('treats a retry onto the same status as done, not as an illegal move', async () => {
      mockDocumentRepo.findOne.mockResolvedValue(doc(DocumentStatus.DISPATCHED));

      const saved = await service.updateStatus('doc-1', DocumentStatus.DISPATCHED, 'u-1');

      expect(saved.status).toBe(DocumentStatus.DISPATCHED);
      // No second save and no second audit row: nothing happened, so nothing is recorded.
      expect(mockDocumentRepo.save).not.toHaveBeenCalled();
      expect(mockAuditService.recordEvent).not.toHaveBeenCalled();
    });
  });

  describe('operationsOverview branch grouping', () => {
    /**
     * Seven queries now, not one.
     *
     * Both lists on this page are windows: the branch list (page, count, never-prepared alerts)
     * and, since the documents list stopped being an unbounded SELECT the browser filtered, the
     * documents page plus the two GROUP BY aggregates that count the whole set behind it, plus
     * the awaiting-dispatch queue with its own cap. They share join shapes, so the mock routes
     * on what makes each distinct — most specific marker first.
     */
    const BRANCH_LIST_SQL = 'LIMIT $';
    const BRANCH_COUNT_SQL = 'COUNT(*)::int';
    const NEVER_PREPARED_SQL = 'gap_total';
    const DOC_PAGE_SQL = 'ORDER BY d.created_at DESC, d.id DESC';
    const STAGE_COUNT_SQL = 'GROUP BY d.status';
    const TYPE_COUNT_SQL = 'GROUP BY d.status, d.type';
    const AWAITING_SQL = 'total_matching';

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
    const mockQueries = (opts: {
      docs?: any[]; branchRows?: any[]; gapRows?: any[]; total?: number;
      /** What the GROUP BY aggregates report for the whole filtered set, page or no page. */
      stageCounts?: Array<{ status: string; n: number }>;
      typeCounts?: Array<{ status: string; type: string; n: number }>;
      awaitingRows?: any[];
    } = {}) => {
      mockManagerQuery.mockImplementation(async (sql: string) => {
        // Order matters: every branch query embeds a `FROM documents d2` subquery, which the
        // flat-documents check below would otherwise swallow. Most specific marker first.
        if (sql.includes(TYPE_COUNT_SQL)) return opts.typeCounts ?? [];
        if (sql.includes(STAGE_COUNT_SQL)) {
          // Default: the counts agree with the page, which is what an un-paged fixture means.
          return opts.stageCounts
            ?? (opts.docs ?? []).map((d: any) => ({ status: d.status, n: 1 }));
        }
        if (sql.includes(AWAITING_SQL)) return opts.awaitingRows ?? [];
        if (sql.includes(BRANCH_COUNT_SQL)) return [{ n: opts.total ?? (opts.branchRows?.length ?? 0) }];
        if (sql.includes(NEVER_PREPARED_SQL)) return opts.gapRows ?? [];
        if (sql.includes(DOC_PAGE_SQL)) return opts.docs ?? [];
        if (sql.includes(BRANCH_LIST_SQL)) return opts.branchRows ?? [];
        if (sql.includes('FROM documents d')) return opts.docs ?? [];
        return [];
      });
    };

    const branchRow = (over: Record<string, any> = {}) => ({
      project_branch_id: 'pb-1', scheduled_date: null,
      branch_name: 'Pune Main Branch', sol_id: 'BR-1',
      project_name: 'P1', client_name: 'SBI', never_prepared: false, ...over,
    });

    beforeEach(() => {
      mockManagerQuery.mockReset();
    });

    /**
     * The documents list is a window now.
     *
     * It used to be every row in `documents` — a table that grows with every audit — shipped to
     * the browser so a `useMemo` could filter it. The console shows one page at a time, so the
     * page is cut in SQL and the figures beside it come from aggregates over the whole set.
     */
    describe('documents paging', () => {
      const docRow = (over: Record<string, any> = {}) => ({
        id: 'doc-1', file_name: 'pre-audit.pdf', file_size: 100, type: 'PRE_FIELD_AUDIT_PDF',
        status: 'DISPATCHED', doc_version: 1, created_at: new Date(), project_branch_id: 'pb-1',
        branch_name: 'Pune Main Branch', sol_id: 'BR-1', project_name: 'P1',
        project_number: 'PRJ-1', client_name: 'SBI', scheduled_date: null, ...over,
      });

      it('cuts the documents list in SQL rather than sending the table', async () => {
        mockQueries({ docs: [docRow()] });

        await service.operationsOverview({ page: 3, limit: 25 });

        const sql = sqlFor(DOC_PAGE_SQL);
        expect(sql).toContain('LIMIT 25');
        expect(sql).toContain('OFFSET 50');
      });

      it('counts the whole set, not the rows that fit on the page', async () => {
        mockQueries({
          docs: [docRow({ id: 'doc-1' }), docRow({ id: 'doc-2' })],
          stageCounts: [
            { status: 'DISPATCHED', n: 400 },
            { status: 'SENT_TO_DATA_ENTRY', n: 60 },
            { status: 'COMPLETED', n: 40 },
          ],
        });

        const result = await service.operationsOverview({ limit: 2 });

        // Two rows on the page; five hundred in the book. The old code answered "2".
        expect(result.documents).toHaveLength(2);
        expect(result.totals.total).toBe(500);
        expect(result.documentPagination.total).toBe(500);
        expect(result.totals.inDataEntry).toBe(60);
        expect(result.totals.completed).toBe(40);
      });

      it('pushes the search into the documents query instead of the browser', async () => {
        mockQueries({ docs: [docRow()] });

        await service.operationsOverview({ search: 'Pune' });

        expect(paramsFor(DOC_PAGE_SQL)).toContain('%Pune%');
      });

      it('leaves the pipeline counts unfiltered by the selected stage, so the other chips survive', async () => {
        mockQueries({ docs: [docRow()] });

        await service.operationsOverview({ stage: DocumentStatus.DISPATCHED });

        // The page shows the chosen stage...
        expect(paramsFor(DOC_PAGE_SQL)).toContain(DocumentStatus.DISPATCHED);
        // ...but every chip still reports its own count, or picking one would zero the rest.
        expect(paramsFor(STAGE_COUNT_SQL)).not.toContain(DocumentStatus.DISPATCHED);
      });

      it('reports the true awaiting-dispatch count even when that queue is capped', async () => {
        mockQueries({
          docs: [docRow()],
          awaitingRows: [
            { id: 'doc-9', file_name: 'a.pdf', file_size: 1, type: 'PRE_FIELD_AUDIT_PDF', status: 'UPLOADED', doc_version: 1, created_at: new Date(), branch_name: 'B', sol_id: 'B1', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', project_branch_id: 'pb-1', scheduled_date: null, total_matching: '137' },
          ],
        });

        const result = await service.operationsOverview();

        expect(result.awaitingDispatch).toHaveLength(1);
        expect(result.totals.awaitingDispatch).toBe(137);
      });
    });

    it("groups a branch's multiple documents under one entry instead of repeating its name", async () => {
      mockQueries({
        docs: [
          { id: 'doc-1', file_name: 'pre-audit.pdf', file_size: 100, type: 'PRE_FIELD_AUDIT_PDF', status: 'DISPATCHED', doc_version: 1, created_at: new Date(), project_branch_id: 'pb-1', branch_name: 'Pune Main Branch', sol_id: 'BR-1', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', scheduled_date: null },
          { id: 'doc-2', file_name: 'return.pdf', file_size: 200, type: 'AUDITED_RETURN_PDF', status: 'RECEIVED', doc_version: 1, created_at: new Date(), project_branch_id: 'pb-1', branch_name: 'Pune Main Branch', sol_id: 'BR-1', project_name: 'P1', project_number: 'PRJ-1', client_name: 'SBI', scheduled_date: null },
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
        projectBranchId: 'pb-1', branchName: 'Pune Main Branch', solId: 'BR-1',
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
      expect(sql).toContain('b.sol_id ILIKE');
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
      { project_branch_id: 'pb-1', branch_name: 'Pune Main Branch', sol_id: 'BR-0010' },
      { project_branch_id: 'pb-2', branch_name: 'Pune Yerwada Branch', sol_id: 'BR-0016' },
      { project_branch_id: 'pb-3', branch_name: 'Nashik Main Branch', sol_id: 'BR-0020' },
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
      expect(r.matches.every((m) => m.matchedOn === 'SOL')).toBe(true);
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

  /**
   * Sending the packet to the branch instead of the assayer.
   *
   * Several clients take the paperwork at the bank branch and have the appraiser collect it
   * there. Before this the desk had no way to say so: it marked the document dispatched and sent
   * it by some other means, leaving the system claiming a delivery it had not made.
   *
   * The rule these hold is that DISPATCHED must mean it went. A document marked sent that never
   * left is the exact failure this route exists to remove, so nothing is recorded until the mail
   * provider has accepted it.
   */
  describe('dispatching to a branch', () => {
    const uploadedDoc = {
      id: 'doc-1', status: DocumentStatus.UPLOADED, isActive: true,
      fileName: 'packet.pdf', filePath: 'uploads/packet.pdf', mimeType: 'application/pdf',
      assessmentId: 'asm-1',
      assessment: { branchId: 'br-1', branch: { name: 'Kolhapur Main' } },
    };

    beforeEach(() => {
      mockDocumentRepo.findOne.mockResolvedValue({ ...uploadedDoc });
      mockDocumentRepo.save.mockImplementation(async (v: any) => v);
      mockAssignmentRepo.findOne.mockResolvedValue(null);
      mockEmailProvider.isEnabled.mockReturnValue(true);
      mockEmailProvider.send.mockResolvedValue({ success: true, messageId: 'm-1' });
      mockStorage.getFileStream.mockResolvedValue(
        (async function* () { yield Buffer.from('%PDF-1.4 fake'); })(),
      );
    });

    it('attaches the file rather than linking to it', async () => {
      await service.dispatchDocument('doc-1', 'user-1', DispatchMethod.MANUAL, {
        branchEmail: 'manager@bank.example',
      });

      const sent = mockEmailProvider.send.mock.calls.at(-1)![0];
      expect(sent.to).toBe('manager@bank.example');
      expect(sent.attachments).toHaveLength(1);
      expect(sent.attachments[0].filename).toBe('packet.pdf');
      // A link to bank customer paperwork survives being forwarded; the file does not need to.
      expect(sent.text).not.toMatch(/https?:\/\//);
    });

    it('names the branch, so the recipient knows what arrived', async () => {
      await service.dispatchDocument('doc-1', 'user-1', DispatchMethod.MANUAL, {
        branchEmail: 'manager@bank.example',
      });
      expect(mockEmailProvider.send.mock.calls.at(-1)![0].subject).toContain('Kolhapur Main');
    });

    it('records where it went', async () => {
      const saved = await service.dispatchDocument('doc-1', 'user-1', DispatchMethod.MANUAL, {
        branchEmail: 'manager@bank.example',
      });
      expect(saved.dispatchedToEmail).toBe('manager@bank.example');
    });

    it('leaves the document unsent when the mail is refused', async () => {
      mockEmailProvider.send.mockResolvedValue({ success: false, error: 'Mailbox unavailable' });

      await expect(
        service.dispatchDocument('doc-1', 'user-1', DispatchMethod.MANUAL, { branchEmail: 'bad@bank.example' }),
      ).rejects.toThrow(/could not be emailed/i);

      // The status must not have moved. "Dispatched" has to mean it went.
      expect(mockDocumentRepo.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: DocumentStatus.DISPATCHED }),
      );
    });

    it('refuses when email is not set up, rather than silently keeping the file', async () => {
      mockEmailProvider.isEnabled.mockReturnValue(false);
      await expect(
        service.dispatchDocument('doc-1', 'user-1', DispatchMethod.MANUAL, { branchEmail: 'a@b.example' }),
      ).rejects.toThrow(/Email is not set up/i);
    });

    it('refuses an address that is not one', async () => {
      await expect(
        service.dispatchDocument('doc-1', 'user-1', DispatchMethod.MANUAL, { branchEmail: 'not-an-address' }),
      ).rejects.toThrow(/is not an email address/i);
      expect(mockEmailProvider.send).not.toHaveBeenCalled();
    });

    it('still dispatches to the assayer when no address is given', async () => {
      const saved = await service.dispatchDocument('doc-1', 'user-1');
      expect(mockEmailProvider.send).not.toHaveBeenCalled();
      expect(saved.dispatchedToEmail).toBeNull();
    });
  });

  describe('getDocumentStats', () => {
    /**
     * The stat tile must count in the database, not hydrate every active document into Node to
     * derive four integers. This pins the aggregate path: it reads a single grouped-count row and
     * never falls back to loading the rows.
     */
    it('returns the four counts from one grouped-count query, never a full find', async () => {
      const qb: any = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        setParameters: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ total: '120', uploaded: '30', dispatched: '50', received: '40' }),
      };
      mockDocumentRepo.createQueryBuilder.mockReturnValue(qb);
      mockDocumentRepo.find.mockClear();

      const stats = await service.getDocumentStats();

      expect(stats).toEqual({ total: 120, uploaded: 30, dispatched: 50, received: 40 });
      expect(qb.getRawOne).toHaveBeenCalledTimes(1);
      // The whole point: no full-table hydration.
      expect(mockDocumentRepo.find).not.toHaveBeenCalled();
    });

    it('reads zero cleanly when the table is empty', async () => {
      const qb: any = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        setParameters: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue(undefined),
      };
      mockDocumentRepo.createQueryBuilder.mockReturnValue(qb);

      expect(await service.getDocumentStats()).toEqual({ total: 0, uploaded: 0, dispatched: 0, received: 0 });
    });
  });

  /**
   * The staged region-scope rollout (`security.regionScope.mode`, read via
   * `RegionGuardService.stagedMode()`): Off and Log must return exactly what the route returned
   * before this rollout existed — Log's only observable difference is a warning log line,
   * computed from rows already in hand rather than a second query — and Enforce is the only mode
   * that actually narrows the result. An unrestricted account (`scope.regions` null/empty) is
   * never filtered or logged against in any mode.
   */
  describe('region scope (staged rollout)', () => {
    const restrictedScope = { regions: ['NORTH'] } as any;

    afterEach(() => {
      // These tests set stagedMode's resolved value explicitly per case; restore the file's
      // shared Off default so later tests (and other describe blocks, which do not expect any
      // region filtering) are unaffected.
      mockRegionGuard.stagedMode.mockResolvedValue('off');
    });

    describe('findByProject', () => {
      const branchDoc = (id: string, region: string | null) => ({
        id, assessment: { branch: { region } },
      });

      beforeEach(() => {
        mockAssessmentRepo.find.mockResolvedValue([{ id: 'a-1' }, { id: 'a-2' }]);
        mockDocumentRepo.find.mockResolvedValue([branchDoc('doc-north', 'NORTH'), branchDoc('doc-south', 'SOUTH')]);
      });

      it('Off: returns everything and never reads the mode', async () => {
        mockRegionGuard.stagedMode.mockResolvedValue('off');
        const result = await service.findByProject('p-1', restrictedScope);
        expect(result).toHaveLength(2);
      });

      it('an unrestricted account (regions: null) is never filtered, even in Enforce', async () => {
        mockRegionGuard.stagedMode.mockResolvedValue('enforce');
        const result = await service.findByProject('p-1', { regions: null } as any);
        expect(result).toHaveLength(2);
        expect(mockRegionGuard.stagedMode).not.toHaveBeenCalled();
      });

      it('Log: returns the FULL unfiltered result and logs, rather than narrowing it', async () => {
        mockRegionGuard.stagedMode.mockResolvedValue('log');
        const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

        const result = await service.findByProject('p-1', restrictedScope);

        expect(result.map((d) => d.id)).toEqual(['doc-north', 'doc-south']);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('would filter 1 of 2'));
      });

      it('Enforce: narrows to the account\'s region(s), leaving a null-region row visible', async () => {
        mockRegionGuard.stagedMode.mockResolvedValue('enforce');
        mockDocumentRepo.find.mockResolvedValue([
          branchDoc('doc-north', 'NORTH'),
          branchDoc('doc-south', 'SOUTH'),
          branchDoc('doc-unresolved', null),
        ]);

        const result = await service.findByProject('p-1', restrictedScope);

        expect(result.map((d) => d.id).sort()).toEqual(['doc-north', 'doc-unresolved']);
      });
    });

    describe('findAll', () => {
      it('Log: returns the FULL unfiltered result and logs the would-be exclusion', async () => {
        mockRegionGuard.stagedMode.mockResolvedValue('log');
        mockDocumentRepo.find.mockResolvedValue([
          { id: 'doc-north', assessment: { branch: { region: 'NORTH' } } },
          { id: 'doc-south', assessment: { branch: { region: 'SOUTH' } } },
        ]);
        const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

        const result = await service.findAll(restrictedScope);

        expect(result).toHaveLength(2);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('document:findAll'));
      });

      it('Enforce: narrows the list', async () => {
        mockRegionGuard.stagedMode.mockResolvedValue('enforce');
        mockDocumentRepo.find.mockResolvedValue([
          { id: 'doc-north', assessment: { branch: { region: 'NORTH' } } },
          { id: 'doc-south', assessment: { branch: { region: 'SOUTH' } } },
        ]);

        const result = await service.findAll(restrictedScope);

        expect(result.map((d: any) => d.id)).toEqual(['doc-north']);
      });
    });

    describe('findDataEntryQueue (grouped by assessment)', () => {
      const doc = (assessmentId: string, region: string | null) => ({
        assessmentId,
        receivedAt: new Date('2026-01-01'),
        createdAt: new Date('2026-01-01'),
        status: 'RECEIVED',
        assessment: { branch: { region }, project: { name: 'Proj' } },
      });

      beforeEach(() => {
        mockAssignmentRepo.find.mockResolvedValue([]);
      });

      it('Log: returns every group unfiltered and logs the would-be exclusion', async () => {
        mockRegionGuard.stagedMode.mockResolvedValue('log');
        mockDocumentRepo.find.mockResolvedValue([doc('a-north', 'NORTH'), doc('a-south', 'SOUTH')]);
        const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

        const result = await service.findDataEntryQueue(restrictedScope);

        expect(result.map((g) => g.assessmentId).sort()).toEqual(['a-north', 'a-south']);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('would filter 1 of 2'));
      });

      it('Enforce: drops the out-of-scope group', async () => {
        mockRegionGuard.stagedMode.mockResolvedValue('enforce');
        mockDocumentRepo.find.mockResolvedValue([doc('a-north', 'NORTH'), doc('a-south', 'SOUTH')]);

        const result = await service.findDataEntryQueue(restrictedScope);

        expect(result.map((g) => g.assessmentId)).toEqual(['a-north']);
      });
    });

    describe('dataEntryQueue (the raw-SQL paginated desk queue)', () => {
      function makeQb(rawManyResults: any[][]) {
        const qb: any = {};
        for (const m of ['leftJoin', 'where', 'andWhere', 'select', 'addSelect', 'groupBy', 'orderBy']) {
          qb[m] = jest.fn().mockReturnValue(qb);
        }
        qb.offset = jest.fn().mockReturnValue(qb);
        qb.limit = jest.fn().mockReturnValue(qb);
        qb.clone = jest.fn().mockReturnValue(qb);
        qb.getCount = jest.fn().mockResolvedValue(0);
        const impl = jest.fn();
        rawManyResults.forEach((r) => impl.mockResolvedValueOnce(r));
        qb.getRawMany = impl;
        return qb;
      }

      it('Off: builds no region clause', async () => {
        mockRegionGuard.stagedMode.mockResolvedValue('off');
        const qb = makeQb([[], []]);
        mockDocumentRepo.createQueryBuilder.mockReturnValue(qb);

        await service.dataEntryQueue({}, restrictedScope);

        expect(qb.andWhere).not.toHaveBeenCalledWith(expect.stringContaining('b.region'), expect.anything());
      });

      it('an unrestricted account is never filtered or logged, even in Enforce', async () => {
        mockRegionGuard.stagedMode.mockResolvedValue('enforce');
        const qb = makeQb([[], []]);
        mockDocumentRepo.createQueryBuilder.mockReturnValue(qb);

        await service.dataEntryQueue({}, { regions: null } as any);

        expect(mockRegionGuard.stagedMode).not.toHaveBeenCalled();
        expect(qb.andWhere).not.toHaveBeenCalledWith(expect.stringContaining('b.region'), expect.anything());
      });

      it('Log: returns the full unfiltered page (computed from rows already fetched, not a second query) and logs', async () => {
        mockRegionGuard.stagedMode.mockResolvedValue('log');
        const page = [
          { id: 'd-1', fileName: 'a.pdf', __region: 'NORTH' },
          { id: 'd-2', fileName: 'b.pdf', __region: 'SOUTH' },
        ];
        const qb = makeQb([[], page]);
        mockDocumentRepo.createQueryBuilder.mockReturnValue(qb);
        const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

        const result = await service.dataEntryQueue({}, restrictedScope);

        // Byte-for-byte: the internal __region field must not leak into the response, and
        // nothing must have been dropped.
        expect(result.items).toEqual([{ id: 'd-1', fileName: 'a.pdf' }, { id: 'd-2', fileName: 'b.pdf' }]);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('would filter 1 of 2'));
        // No second query: exactly the two calls dataEntryQueue always makes (lane counts, page).
        expect(qb.getRawMany).toHaveBeenCalledTimes(2);
      });

      it('Enforce: adds the branch-region predicate to the shared query builder', async () => {
        mockRegionGuard.stagedMode.mockResolvedValue('enforce');
        const qb = makeQb([[], []]);
        mockDocumentRepo.createQueryBuilder.mockReturnValue(qb);

        await service.dataEntryQueue({}, restrictedScope);

        expect(qb.andWhere).toHaveBeenCalledWith(
          '(b.region IS NULL OR b.region = ANY(:regions))',
          { regions: ['NORTH'] },
        );
      });
    });

    describe('getDocumentStats', () => {
      function makeQb() {
        const qb: any = {
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          setParameters: jest.fn().mockReturnThis(),
          leftJoin: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({ total: '10', uploaded: '4', dispatched: '3', received: '3' }),
        };
        return qb;
      }

      it('Off (no scope): unchanged — no join, no region predicate', async () => {
        const qb = makeQb();
        mockDocumentRepo.createQueryBuilder.mockReturnValue(qb);

        await service.getDocumentStats();

        expect(qb.leftJoin).not.toHaveBeenCalled();
        expect(qb.andWhere).not.toHaveBeenCalled();
      });

      it('an unrestricted account never reads the mode and is never filtered', async () => {
        const qb = makeQb();
        mockDocumentRepo.createQueryBuilder.mockReturnValue(qb);

        await service.getDocumentStats({ regions: null } as any);

        expect(mockRegionGuard.stagedMode).not.toHaveBeenCalled();
        expect(qb.andWhere).not.toHaveBeenCalled();
      });

      it('Log: totals are unchanged (no join added) — this route has no fetched row set to log a count from', async () => {
        mockRegionGuard.stagedMode.mockResolvedValue('log');
        const qb = makeQb();
        mockDocumentRepo.createQueryBuilder.mockReturnValue(qb);
        const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

        const stats = await service.getDocumentStats(restrictedScope);

        expect(stats).toEqual({ total: 10, uploaded: 4, dispatched: 3, received: 3 });
        expect(qb.leftJoin).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
      });

      it('Enforce: joins down to the branch and restricts the aggregate to the account\'s region(s)', async () => {
        mockRegionGuard.stagedMode.mockResolvedValue('enforce');
        const qb = makeQb();
        mockDocumentRepo.createQueryBuilder.mockReturnValue(qb);

        await service.getDocumentStats(restrictedScope);

        expect(qb.leftJoin).toHaveBeenCalledWith('assessments', 'a', 'a.id = d.assessment_id');
        expect(qb.leftJoin).toHaveBeenCalledWith('branches', 'b', 'b.id = a.branch_id');
        expect(qb.andWhere).toHaveBeenCalledWith(
          '(b.region IS NULL OR b.region = ANY(:regions))',
          { regions: ['NORTH'] },
        );
      });
    });

    describe('resolveProjectBranchRegion / resolveAssessmentRegion', () => {
      it('resolves a project branch to its branch region', async () => {
        mockProjectBranchRepo.findOne.mockResolvedValue({ id: 'pb-1', branchId: 'br-1' });
        mockBranchRepo.findOne.mockResolvedValue({ id: 'br-1', region: 'NORTH' });

        await expect(service.resolveProjectBranchRegion('pb-1')).resolves.toBe('NORTH');
      });

      it('resolves null when the project branch does not exist', async () => {
        mockProjectBranchRepo.findOne.mockResolvedValue(null);
        await expect(service.resolveProjectBranchRegion('missing')).resolves.toBeNull();
      });

      it('resolves an assessment to its branch region via the branch relation', async () => {
        mockAssessmentRepo.findOne.mockResolvedValue({ id: 'a-1', branch: { region: 'SOUTH' } });
        await expect(service.resolveAssessmentRegion('a-1')).resolves.toBe('SOUTH');
        expect(mockAssessmentRepo.findOne).toHaveBeenCalledWith({ where: { id: 'a-1' }, relations: ['branch'] });
      });

      it('resolves null when the assessment does not exist', async () => {
        mockAssessmentRepo.findOne.mockResolvedValue(null);
        await expect(service.resolveAssessmentRegion('missing')).resolves.toBeNull();
      });
    });
  });
});