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
