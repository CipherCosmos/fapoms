import { ForbiddenException } from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { DocumentController } from './document.controller';
import { SystemRole } from '@fapoms/shared';
import { MAX_UPLOAD_BYTES, MAX_RESUMABLE_UPLOAD_BYTES } from './upload-validation';

/**
 * Pins two fixes on `document.controller.ts`, following the shape of
 * `validation-query-ownership.spec.ts`.
 *
 * ## `GET :id/download-token` (`issueDownloadToken`)
 *
 * `isPrivileged` used to be `roles.some((r) => r !== SystemRole.ASSAYER)` — true for ANY role
 * set containing so much as one non-ASSAYER role, which is every staff account this route
 * admits (OPERATIONS, DESK, DESK_OPERATOR). "Privileged" then skipped the assayer ownership
 * check with nothing put in its place: any of those roles could mint a download token for ANY
 * document id in the entire system, with zero region/project/client scoping. The fix keeps the
 * assayer-branch trigger condition exactly as strict as before (still only a pure-ASSAYER
 * caller) and replaces the do-nothing `else` with the same region ceiling
 * `branch.controller.ts`/`assignment.controller.ts` already enforce on their own single-record
 * reads (`RegionGuardService.assertRegionAllowed`, fed by `GlobalScopeFilter`/`users.regions`).
 *
 * ## Upload-route multer `limits`
 *
 * Every `FileInterceptor`/`FilesInterceptor` on this controller used to declare no `limits` at
 * all, so multer buffered an entire file into memory before `assertUploadAllowed`'s own size
 * check ever ran. These tests assert the multer-level cap now exists and agrees with the
 * app-level ceiling that governs each route.
 */
describe('DocumentController — download-token region scope, and upload multer limits', () => {
  const REGION_A = 'NORTH';
  const REGION_B = 'SOUTH';

  const mockDocumentService = {
    findOne: jest.fn(),
    assertAssayerMayDownload: jest.fn(),
  };

  const mockDocumentAccessTokenService = {
    issue: jest.fn().mockReturnValue({ token: 'tok', expiresAt: new Date().toISOString() }),
  };

  const mockRegionGuard = {
    assertRegionAllowed: jest.fn(),
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

  const docWithRegion = (region: string | null) => ({
    id: 'doc-1',
    assessment: { branch: { region } },
  });

  const staffReq = (role: SystemRole) => ({ user: { id: 'staff-1', roles: [role] } });
  const assayerReq = () => ({ user: { id: 'assayer-1', assayerId: 'assayer-1', roles: [SystemRole.ASSAYER] } });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDocumentAccessTokenService.issue.mockReturnValue({ token: 'tok', expiresAt: new Date().toISOString() });
  });

  describe('GET :id/download-token (issueDownloadToken)', () => {
    it.each([SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR])(
      'region-scopes a %s caller instead of waving them through',
      async (role) => {
        mockDocumentService.findOne.mockResolvedValue(docWithRegion(REGION_A));

        await controller.issueDownloadToken('doc-1', staffReq(role) as any, { regions: [REGION_A] } as any);

        expect(mockRegionGuard.assertRegionAllowed).toHaveBeenCalledWith(REGION_A, { regions: [REGION_A] });
        expect(mockDocumentService.assertAssayerMayDownload).not.toHaveBeenCalled();
        expect(mockDocumentAccessTokenService.issue).toHaveBeenCalledWith('doc-1');
      },
    );

    it('refuses a staff caller scoped to a different region, before a token is minted', async () => {
      mockDocumentService.findOne.mockResolvedValue(docWithRegion(REGION_B));
      mockRegionGuard.assertRegionAllowed.mockImplementationOnce(() => {
        throw new ForbiddenException('That record belongs to a region your account is not assigned to.');
      });

      await expect(
        controller.issueDownloadToken('doc-1', staffReq(SystemRole.DESK_OPERATOR) as any, { regions: [REGION_A] } as any),
      ).rejects.toThrow(ForbiddenException);
      expect(mockDocumentAccessTokenService.issue).not.toHaveBeenCalled();
    });

    it('leaves an unrestricted ADMIN caller unaffected (no region assignment => no refusal)', async () => {
      mockDocumentService.findOne.mockResolvedValue(docWithRegion(REGION_B));

      const res = await controller.issueDownloadToken('doc-1', staffReq(SystemRole.ADMIN) as any, { regions: null } as any);

      expect(mockRegionGuard.assertRegionAllowed).toHaveBeenCalledWith(REGION_B, { regions: null });
      expect(res.success).toBe(true);
    });

    it('still runs the unchanged ownership check for a pure-ASSAYER caller, not the region check', async () => {
      mockDocumentService.findOne.mockResolvedValue(docWithRegion(REGION_A));

      await controller.issueDownloadToken('doc-1', assayerReq() as any, { regions: null } as any);

      expect(mockDocumentService.assertAssayerMayDownload).toHaveBeenCalledWith('doc-1', 'assayer-1');
      expect(mockRegionGuard.assertRegionAllowed).not.toHaveBeenCalled();
    });

    it('still refuses a pure assayer whose ownership check fails, exactly as before', async () => {
      mockDocumentService.findOne.mockResolvedValue(docWithRegion(REGION_A));
      mockDocumentService.assertAssayerMayDownload.mockRejectedValue(
        new ForbiddenException('You can only submit paperwork for an assignment that is assigned to you.'),
      );

      await expect(controller.issueDownloadToken('doc-1', assayerReq() as any, { regions: null } as any))
        .rejects.toThrow(ForbiddenException);
      expect(mockDocumentAccessTokenService.issue).not.toHaveBeenCalled();
    });
  });

  /**
   * Audited-return completion ownership — the money-bearing IDOR.
   *
   * `completeAssignmentForReturn` (reached by `mobileUpload`, `mobileUploadBinary` and the resumable
   * `completeUpload`) drives `AssignmentService.completeAssignment`, which books the assayer payable
   * AND the client invoice line and records the branch as audited. The two mobile paths pre-checked
   * ownership on the client-supplied `assignmentId`, but the method then resolves a target through
   * two further fallbacks (by assessment, then by project branch), and the chunked `completeUpload`
   * had no check at all — so a pure assayer could complete SOMEONE ELSE'S assignment. The fix
   * enforces ownership on the RESOLVED assignment inside the shared method. Same class as the
   * branch-PDF IDOR confirmed live 2026-09-04.
   *
   * Exercised through the public `completeUpload` handler (the path that had no pre-check), driving
   * the private method with a fully mocked service graph.
   */
  describe('audited-return completion enforces ownership on the resolved assignment (completeUpload)', () => {
    const VICTIM_ASN = 'asn-victim';
    const victimAssignment = { id: VICTIM_ASN, assayerId: 'assayer-OTHER', status: 'PENDING', projectBranch: {} };

    const svc: any = {
      create: jest.fn(async () => ({ id: 'doc-new', assessmentId: 'assess-1' })),
      receiveDocument: jest.fn(async () => ({ id: 'doc-new', assessmentId: 'assess-1' })),
    };
    const chunked: any = {
      assemble: jest.fn(async () => ({ s3Key: 'k', session: { assessmentId: 'assess-1', fileName: 'r.pdf', fileSize: 10 } })),
      discard: jest.fn(async () => undefined),
    };
    const storage: any = { getFileStream: jest.fn(async () => [Buffer.from('%PDF-1.4')]), deleteFile: jest.fn() };
    const scanner: any = { scanOrThrow: jest.fn(async () => undefined) };
    const assignmentRepo: any = { findOne: jest.fn(async () => victimAssignment) };
    const assignmentService: any = { completeAssignment: jest.fn(async () => undefined) };

    const ctrl = new DocumentController(
      svc,            // documentService
      storage,        // storage
      null as any,    // ocrProcessingService
      assignmentRepo, // assignmentRepository
      null as any,    // assessmentRepository
      null as any,    // validationService
      assignmentService, // assignmentService
      { issue: jest.fn().mockReturnValue({ token: 't', expiresAt: '' }) } as any,
      chunked,        // chunkedUploadService
      scanner,        // fileScanner
      { assertRegionAllowed: jest.fn(), assertRegionAllowedStaged: jest.fn() } as any,
    );

    beforeEach(() => {
      jest.clearAllMocks();
      assignmentRepo.findOne.mockResolvedValue(victimAssignment);
    });

    const req = (roles: any[], id: string) => ({ user: { id, assayerId: id, roles } });

    it('refuses a pure assayer completing another assayer\'s assignment — and does NOT book money', async () => {
      await expect(
        ctrl.completeUpload('sess-1', { type: 'AUDITED_RETURN_PDF', assignmentId: VICTIM_ASN } as any, req([{ name: SystemRole.ASSAYER }], 'assayer-ME')),
      ).rejects.toThrow(ForbiddenException);
      expect(assignmentService.completeAssignment).not.toHaveBeenCalled();
    });

    it('refuses even when assignmentId is omitted and the assessment fallback resolves to another\'s assignment', async () => {
      await expect(
        ctrl.completeUpload('sess-1', { type: 'AUDITED_RETURN_PDF' } as any, req([{ name: SystemRole.ASSAYER }], 'assayer-ME')),
      ).rejects.toThrow(ForbiddenException);
      expect(assignmentService.completeAssignment).not.toHaveBeenCalled();
    });

    it('allows the owning assayer to complete their own assignment (books money)', async () => {
      assignmentRepo.findOne.mockResolvedValue({ ...victimAssignment, assayerId: 'assayer-ME' });
      await ctrl.completeUpload('sess-1', { type: 'AUDITED_RETURN_PDF', assignmentId: VICTIM_ASN } as any, req([{ name: SystemRole.ASSAYER }], 'assayer-ME'));
      expect(assignmentService.completeAssignment).toHaveBeenCalledWith(VICTIM_ASN, 'assayer-ME', expect.stringContaining('Audited return'));
    });

    it('allows staff to complete on an assayer\'s behalf (back-office scan-by-email workflow)', async () => {
      await ctrl.completeUpload('sess-1', { type: 'AUDITED_RETURN_PDF', assignmentId: VICTIM_ASN } as any, req([{ name: SystemRole.OPERATIONS }], 'staff-1'));
      expect(assignmentService.completeAssignment).toHaveBeenCalledWith(VICTIM_ASN, 'staff-1', expect.any(String));
    });
  });

  describe('upload routes cap the multer-level file size, agreeing with assertUploadAllowed', () => {
    function multerLimitsFor(method: Function): { fileSize?: number; files?: number } | undefined {
      const interceptors: any[] = Reflect.getMetadata(INTERCEPTORS_METADATA, method) || [];
      // The File(s)Interceptor mixin is always the first argument to @UseInterceptors on these
      // routes; FileScanInterceptor (which carries no multer options) follows it.
      const FileInterceptorClass = interceptors[0];
      if (!FileInterceptorClass) return undefined;
      const instance = new FileInterceptorClass();
      return instance.multer?.limits;
    }

    it.each([
      ['uploadFile', MAX_UPLOAD_BYTES],
      ['mobileUploadBinary', MAX_UPLOAD_BYTES],
      ['validateCustomerExcel', MAX_UPLOAD_BYTES],
      ['uploadExcelReport', MAX_UPLOAD_BYTES],
      ['uploadChunk', MAX_RESUMABLE_UPLOAD_BYTES],
    ])('%s caps multer fileSize at %d bytes', (methodName, expectedBytes) => {
      const limits = multerLimitsFor((DocumentController.prototype as any)[methodName]);
      expect(limits).toBeDefined();
      expect(limits?.fileSize).toBe(expectedBytes);
    });

    it('uploadGeneratedBatch caps both per-file size and the file count at the multer level', () => {
      const limits = multerLimitsFor((DocumentController.prototype as any).uploadGeneratedBatch);
      expect(limits).toBeDefined();
      expect(limits?.fileSize).toBe(MAX_UPLOAD_BYTES);
      expect(limits?.files).toBe(100);
    });
  });
});
