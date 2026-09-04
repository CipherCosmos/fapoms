import { ForbiddenException } from '@nestjs/common';
import { DocumentController } from './document.controller';

/**
 * The staged region-scope ceiling/filter added to `document.controller.ts` for the six-module
 * rollout described in `region-guard.service.ts` (`security.regionScope.mode`: off/log/enforce).
 *
 * Two shapes are exercised here, matching the pattern `document-controller-ownership.spec.ts`
 * already pins for `issueDownloadToken`:
 *
 *  - Detail-route ceiling (`findOne`, `getTransportTrail`, `findByProjectBranch`,
 *    `downloadBranchPdf`, `assayerBranchDocuments`, `findByAssessment`): resolve the record's (or
 *    project-branch's / assessment's) region, then call
 *    `regionGuard.assertRegionAllowedStaged(region, scope, context)` before returning anything —
 *    a refusal must happen before any data leaves the service.
 *
 *  - List route (`findAll`, `findByProject`, `getStats`, `getDataEntryQueue`, `dataEntryQueue`,
 *    `myDataEntryQueue`): the controller passes `scope` straight through to the service, which
 *    owns the mode-aware filtering (see `document.service.spec.ts`'s "region scope (staged
 *    rollout)" suite for that half).
 */
describe('DocumentController — staged region scope', () => {
  const scope = { regions: ['NORTH'] } as any;

  const mockDocumentService: any = {
    findOne: jest.fn(),
    resolveProjectBranchRegion: jest.fn(),
    resolveAssessmentRegion: jest.fn(),
    findByProjectBranch: jest.fn(),
    findDispatchedForAssayer: jest.fn(),
    assertAssayerAssignedToBranch: jest.fn(),
    findByAssessment: jest.fn(),
    findByProject: jest.fn(),
    findAll: jest.fn(),
    getDocumentStats: jest.fn(),
    findDataEntryQueue: jest.fn(),
    dataEntryQueue: jest.fn(),
    buildTransportTrail: jest.fn().mockReturnValue([]),
  };

  const mockDocumentAccessTokenService = {
    issue: jest.fn().mockReturnValue({ token: 'tok', expiresAt: new Date().toISOString() }),
  };

  const mockRegionGuard = {
    assertRegionAllowed: jest.fn(),
    assertRegionAllowedStaged: jest.fn().mockResolvedValue(undefined),
  };

  const controller = new DocumentController(
    mockDocumentService as any,
    null as any, // storage
    null as any, // ocrProcessingService
    null as any, // assignmentRepository
    null as any, // assessmentRepository
    null as any, // validationService
    null as any, // assignmentService
    mockDocumentAccessTokenService as any,
    null as any, // chunkedUploadService
    null as any, // fileScanner
    mockRegionGuard as any,
  );

  const staffReq = () => ({ user: { id: 'staff-1', roles: [{ name: 'ADMIN' }] } });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRegionGuard.assertRegionAllowedStaged.mockResolvedValue(undefined);
    mockDocumentAccessTokenService.issue.mockReturnValue({ token: 'tok', expiresAt: new Date().toISOString() });
  });

  describe('GET :id (findOne)', () => {
    it('resolves the region from the eager-loaded assessment.branch and asserts it staged', async () => {
      mockDocumentService.findOne.mockResolvedValue({ id: 'doc-1', assessment: { branch: { region: 'SOUTH' } } });

      const res = await controller.findOne('doc-1', scope);

      expect(mockRegionGuard.assertRegionAllowedStaged).toHaveBeenCalledWith('SOUTH', scope, 'document:findOne');
      expect(res).toEqual({ success: true, data: { id: 'doc-1', assessment: { branch: { region: 'SOUTH' } } } });
    });

    it('a null branch region is passed through as null, not swallowed', async () => {
      mockDocumentService.findOne.mockResolvedValue({ id: 'doc-1', assessment: null });
      await controller.findOne('doc-1', scope);
      expect(mockRegionGuard.assertRegionAllowedStaged).toHaveBeenCalledWith(null, scope, 'document:findOne');
    });

    it('propagates a refusal from Enforce mode before returning data', async () => {
      mockDocumentService.findOne.mockResolvedValue({ id: 'doc-1', assessment: { branch: { region: 'SOUTH' } } });
      mockRegionGuard.assertRegionAllowedStaged.mockRejectedValue(new ForbiddenException('nope'));

      await expect(controller.findOne('doc-1', scope)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('GET :id/trail (getTransportTrail)', () => {
    it('asserts the region before assembling the trail', async () => {
      mockDocumentService.findOne.mockResolvedValue({
        id: 'doc-1', fileName: 'f.pdf', type: 'PRE_FIELD_AUDIT_PDF', status: 'UPLOADED',
        assessmentId: 'a-1', assessment: { branch: { region: 'SOUTH', name: 'Br' }, project: { name: 'P' } },
      });

      await controller.getTransportTrail('doc-1', scope);

      expect(mockRegionGuard.assertRegionAllowedStaged).toHaveBeenCalledWith('SOUTH', scope, 'document:trail');
    });
  });

  describe('GET project-branch/:projectBranchId (findByProjectBranch)', () => {
    it('resolves the branch region via the project branch and asserts it staged, before listing', async () => {
      mockDocumentService.resolveProjectBranchRegion.mockResolvedValue('SOUTH');
      mockDocumentService.findByProjectBranch.mockResolvedValue([{ id: 'doc-1' }]);

      const res = await controller.findByProjectBranch('pb-1', staffReq(), scope);

      expect(mockDocumentService.resolveProjectBranchRegion).toHaveBeenCalledWith('pb-1');
      expect(mockRegionGuard.assertRegionAllowedStaged).toHaveBeenCalledWith('SOUTH', scope, 'document:findByProjectBranch');
      expect(res).toEqual({ success: true, data: [{ id: 'doc-1' }] });
    });

    it('a refusal stops the request before the branch is listed', async () => {
      mockDocumentService.resolveProjectBranchRegion.mockResolvedValue('SOUTH');
      mockRegionGuard.assertRegionAllowedStaged.mockRejectedValue(new ForbiddenException('nope'));

      await expect(controller.findByProjectBranch('pb-1', staffReq(), scope)).rejects.toThrow(ForbiddenException);
      expect(mockDocumentService.findByProjectBranch).not.toHaveBeenCalled();
    });
  });

  describe('GET project-branch/:projectBranchId/assayer-view (assayerBranchDocuments)', () => {
    it('asserts the region before returning the dispatch-gated view', async () => {
      mockDocumentService.resolveProjectBranchRegion.mockResolvedValue('SOUTH');
      mockDocumentService.findDispatchedForAssayer.mockResolvedValue({ documents: [], readiness: { message: 'x' } });

      await controller.assayerBranchDocuments('pb-1', staffReq(), scope);

      expect(mockRegionGuard.assertRegionAllowedStaged).toHaveBeenCalledWith(
        'SOUTH', scope, 'document:assayerBranchDocuments',
      );
    });
  });

  describe('GET project-branch/:projectBranchId/download-pdf (downloadBranchPdf)', () => {
    it('mints its own token, so it needs — and runs — its own region check first', async () => {
      mockDocumentService.resolveProjectBranchRegion.mockResolvedValue('SOUTH');
      // No dispatched document: exercises the 404 branch, so the test does not have to model
      // the full downloadFile() streaming path to prove the region check ran first.
      mockDocumentService.findDispatchedForAssayer.mockResolvedValue({
        documents: [], readiness: { message: 'nothing yet' },
      });
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await controller.downloadBranchPdf('pb-1', staffReq(), res, scope);

      expect(mockRegionGuard.assertRegionAllowedStaged).toHaveBeenCalledWith(
        'SOUTH', scope, 'document:downloadBranchPdf',
      );
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('a refusal happens before any dispatched-document lookup, or a token is minted', async () => {
      mockDocumentService.resolveProjectBranchRegion.mockResolvedValue('SOUTH');
      mockRegionGuard.assertRegionAllowedStaged.mockRejectedValue(new ForbiddenException('nope'));
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await expect(controller.downloadBranchPdf('pb-1', staffReq(), res, scope)).rejects.toThrow(ForbiddenException);

      expect(mockDocumentService.findDispatchedForAssayer).not.toHaveBeenCalled();
      expect(mockDocumentAccessTokenService.issue).not.toHaveBeenCalled();
    });
  });

  describe('GET assessment/:assessmentId (findByAssessment)', () => {
    it('resolves the region via the assessment\'s branch relation and asserts it staged', async () => {
      mockDocumentService.resolveAssessmentRegion.mockResolvedValue('SOUTH');
      mockDocumentService.findByAssessment.mockResolvedValue([{ id: 'doc-1' }]);

      await controller.findByAssessment('a-1', scope);

      expect(mockDocumentService.resolveAssessmentRegion).toHaveBeenCalledWith('a-1');
      expect(mockRegionGuard.assertRegionAllowedStaged).toHaveBeenCalledWith('SOUTH', scope, 'document:findByAssessment');
    });
  });

  describe('list routes pass scope straight through to the service (which owns the filtering)', () => {
    it('GET project/:projectId (findByProject)', async () => {
      mockDocumentService.findByProject.mockResolvedValue([]);
      await controller.findByProject('proj-1', scope);
      expect(mockDocumentService.findByProject).toHaveBeenCalledWith('proj-1', scope);
    });

    it('GET (findAll)', async () => {
      mockDocumentService.findAll.mockResolvedValue({ data: [], total: 0, limit: 50, offset: 0 });
      await controller.findAll(scope, 50, undefined);
      expect(mockDocumentService.findAll).toHaveBeenCalledWith(scope, 50, 0);
    });

    it('GET stats/summary (getStats)', async () => {
      mockDocumentService.getDocumentStats.mockResolvedValue({ total: 0, uploaded: 0, dispatched: 0, received: 0 });
      await controller.getStats(scope);
      expect(mockDocumentService.getDocumentStats).toHaveBeenCalledWith(scope);
    });

    it('GET queue/data-entry (getDataEntryQueue)', async () => {
      mockDocumentService.findDataEntryQueue.mockResolvedValue([]);
      await controller.getDataEntryQueue(scope);
      expect(mockDocumentService.findDataEntryQueue).toHaveBeenCalledWith(scope);
    });

    it('GET data-entry/queue (dataEntryQueue)', async () => {
      mockDocumentService.dataEntryQueue.mockResolvedValue({ counts: {}, total: 0, page: 1, limit: 25, items: [] });
      await controller.dataEntryQueue(undefined, undefined, undefined, undefined, undefined, scope);
      expect(mockDocumentService.dataEntryQueue).toHaveBeenCalledWith(
        { assignedTo: undefined, lane: undefined, search: undefined, page: undefined, limit: undefined },
        scope,
      );
    });

    it('GET data-entry/mine (myDataEntryQueue) scopes to the caller\'s own id AND the region', async () => {
      mockDocumentService.dataEntryQueue.mockResolvedValue({ counts: {}, total: 0, page: 1, limit: 25, items: [] });
      await controller.myDataEntryQueue({ user: { id: 'me-1' } } as any, undefined, undefined, undefined, undefined, scope);
      expect(mockDocumentService.dataEntryQueue).toHaveBeenCalledWith(
        { assignedTo: 'me-1', lane: undefined, search: undefined, page: undefined, limit: undefined },
        scope,
      );
    });
  });

  /**
   * Cross-assayer IDOR on the three branch-addressed document routes. CONFIRMED-EXPLOITABLE
   * 2026-09-04 against the live stack: assayer AS-01, with no assignment on the branch, streamed
   * AS-04's completed-branch "SBI Pune Hinjewadi Audit Packet" PDF (HTTP 200) through
   * `download-pdf`, and read the same branch's document metadata through `findByProjectBranch`
   * and the `assayer-view`.
   *
   * Root cause: all three admit `SystemRole.ASSAYER` and were gated only by the staged region
   * ceiling, which refuses nothing in the default `log` rollout mode. `findDispatchedForAssayer`
   * filters by document type/status, never by assayer — its name means "types an assayer may see",
   * not "documents for THIS assayer". The fix is a pure-assayer branch-ownership assertion
   * (`assertAssayerAssignedToBranch`) on each route; staff keep the region ceiling and are
   * unaffected.
   *
   * `assayerReq` is a PURE assayer (the exploitable shape). A caller holding any staff role in
   * addition is not subject to the check — matching `issueDownloadToken`'s `isPureAssayer` test.
   */
  describe('branch routes enforce assayer ownership (cross-assayer IDOR fix)', () => {
    const assayerReq = () => ({ user: { id: 'assayer-1', assayerId: 'assayer-1', roles: [{ name: 'ASSAYER' }] } });

    beforeEach(() => {
      mockDocumentService.resolveProjectBranchRegion.mockResolvedValue('SOUTH');
      mockDocumentService.findDispatchedForAssayer.mockResolvedValue({ documents: [], readiness: { message: 'x' } });
      mockDocumentService.findByProjectBranch.mockResolvedValue([]);
      mockDocumentService.assertAssayerAssignedToBranch.mockResolvedValue(undefined);
    });

    it('download-pdf: a non-owning assayer is refused before any document is resolved or a token minted', async () => {
      mockDocumentService.assertAssayerAssignedToBranch.mockRejectedValue(
        new ForbiddenException('You are not assigned to this branch.'),
      );
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await expect(controller.downloadBranchPdf('pb-victim', assayerReq(), res, scope)).rejects.toThrow(ForbiddenException);

      expect(mockDocumentService.assertAssayerAssignedToBranch).toHaveBeenCalledWith('pb-victim', 'assayer-1');
      expect(mockDocumentService.findDispatchedForAssayer).not.toHaveBeenCalled();
      expect(mockDocumentAccessTokenService.issue).not.toHaveBeenCalled();
    });

    it('download-pdf: an owning assayer passes the check and proceeds to resolve documents', async () => {
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await controller.downloadBranchPdf('pb-mine', assayerReq(), res, scope);
      expect(mockDocumentService.assertAssayerAssignedToBranch).toHaveBeenCalledWith('pb-mine', 'assayer-1');
      expect(mockDocumentService.findDispatchedForAssayer).toHaveBeenCalledWith('pb-mine');
    });

    it('findByProjectBranch: a non-owning assayer is refused', async () => {
      mockDocumentService.assertAssayerAssignedToBranch.mockRejectedValue(new ForbiddenException('nope'));
      await expect(controller.findByProjectBranch('pb-victim', assayerReq(), scope)).rejects.toThrow(ForbiddenException);
      expect(mockDocumentService.findDispatchedForAssayer).not.toHaveBeenCalled();
    });

    it('assayer-view: a non-owning assayer is refused', async () => {
      mockDocumentService.assertAssayerAssignedToBranch.mockRejectedValue(new ForbiddenException('nope'));
      await expect(controller.assayerBranchDocuments('pb-victim', assayerReq(), scope)).rejects.toThrow(ForbiddenException);
      expect(mockDocumentService.findDispatchedForAssayer).not.toHaveBeenCalled();
    });

    it('staff are NOT subjected to the assayer branch-ownership check on any of the three routes', async () => {
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await controller.downloadBranchPdf('pb-1', staffReq(), res, scope);
      await controller.findByProjectBranch('pb-1', staffReq(), scope);
      await controller.assayerBranchDocuments('pb-1', staffReq(), scope);
      expect(mockDocumentService.assertAssayerAssignedToBranch).not.toHaveBeenCalled();
    });
  });
});
