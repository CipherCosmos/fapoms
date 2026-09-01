import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { ValidationQueryController } from './validation-query.controller';
import { ValidationQueryService } from './validation-query.service';
import { QueryThreadService } from './query-thread.service';
import { DocumentAccessTokenService } from '../document/document-access-token.service';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { FileScanService } from '../../infrastructure/security/file-scan.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { SystemRole, Region } from '@fapoms/shared';

/**
 * The staff-side staged region ceiling on the detail-shaped routes: `listMessages`,
 * `respondToQuery`, `resolveQuery`, `reopenQuery`, `findByValidationCase`. An assayer caller is
 * already object-scoped elsewhere in this controller (`assertAssayerOwnsQuery`), so these tests
 * are specifically about the STAFF path, which previously had no region check at all.
 *
 * These wire the controller directly to a mocked `RegionGuardService` — `assertRegionAllowedStaged`
 * itself (the off/log/enforce behaviour) is `RegionGuardService`'s own responsibility and is
 * tested there; what matters here is that this controller resolves the right region and calls it
 * at the right time, for the right (staff-only) callers.
 */
describe('ValidationQueryController — staged region ceiling on detail routes', () => {
  let controller: ValidationQueryController;

  const mockService = {
    resolveRegion: jest.fn(),
    validationCaseRegion: jest.fn(),
    respondToQuery: jest.fn(),
    resolveQuery: jest.fn(),
    reopenQuery: jest.fn(),
    findByValidationCase: jest.fn(),
    ownerAssayerId: jest.fn(),
  };
  const mockThreadService = { listMessages: jest.fn(), getQueryDocumentId: jest.fn() };
  const mockDocumentAccessTokenService = { issue: jest.fn() };
  const mockRegionGuard = { assertRegionAllowedStaged: jest.fn(), stagedMode: jest.fn() };

  const staffReq = () => ({ user: { id: 'staff-1', roles: [SystemRole.DESK] } });
  const assayerReq = () => ({ user: { id: 'assayer-1', roles: [SystemRole.ASSAYER] } });
  const NORTH_SCOPE = { regions: [Region.NORTH] as any };
  const NATIONAL_SCOPE = { regions: null };

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ValidationQueryController],
      providers: [
        { provide: ValidationQueryService, useValue: mockService },
        { provide: QueryThreadService, useValue: mockThreadService },
        { provide: 'StorageEngine', useValue: {} },
        { provide: DocumentAccessTokenService, useValue: mockDocumentAccessTokenService },
        { provide: RegionGuardService, useValue: mockRegionGuard },
        { provide: FileScanService, useValue: {} },
        FileScanInterceptor,
      ],
    }).compile();
    controller = module.get<ValidationQueryController>(ValidationQueryController);
  });

  describe('resolveQuery / reopenQuery (staff-only routes)', () => {
    it('skips the region lookup entirely for an unrestricted account', async () => {
      mockService.resolveQuery.mockResolvedValue({ id: 'q-1' });

      await controller.resolveQuery('q-1', staffReq() as any, NATIONAL_SCOPE as any);

      expect(mockService.resolveRegion).not.toHaveBeenCalled();
      expect(mockRegionGuard.assertRegionAllowedStaged).not.toHaveBeenCalled();
      expect(mockService.resolveQuery).toHaveBeenCalledWith('q-1', 'staff-1');
    });

    it('resolves the region and runs it through the staged assert for a region-restricted caller', async () => {
      mockService.resolveRegion.mockResolvedValue('SOUTH');
      mockService.resolveQuery.mockResolvedValue({ id: 'q-1' });

      await controller.resolveQuery('q-1', staffReq() as any, NORTH_SCOPE as any);

      expect(mockService.resolveRegion).toHaveBeenCalledWith('q-1');
      expect(mockRegionGuard.assertRegionAllowedStaged).toHaveBeenCalledWith(
        'SOUTH',
        NORTH_SCOPE,
        'validation-query:resolveQuery',
      );
    });

    it('propagates a refusal from the staged assert and never calls the mutation', async () => {
      mockService.resolveRegion.mockResolvedValue('SOUTH');
      mockRegionGuard.assertRegionAllowedStaged.mockRejectedValue(
        new ForbiddenException('out of region'),
      );

      await expect(controller.resolveQuery('q-1', staffReq() as any, NORTH_SCOPE as any)).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockService.resolveQuery).not.toHaveBeenCalled();
    });

    it('reopenQuery follows the identical shape', async () => {
      mockService.resolveRegion.mockResolvedValue('SOUTH');
      mockService.reopenQuery.mockResolvedValue({ id: 'q-1' });

      await controller.reopenQuery('q-1', staffReq() as any, NORTH_SCOPE as any);

      expect(mockRegionGuard.assertRegionAllowedStaged).toHaveBeenCalledWith(
        'SOUTH',
        NORTH_SCOPE,
        'validation-query:reopenQuery',
      );
    });
  });

  describe('respondToQuery / listMessages (assayer-admitting routes)', () => {
    it('never resolves a region for an assayer caller — they are already object-scoped', async () => {
      mockService.ownerAssayerId.mockResolvedValue('assayer-1');
      mockService.respondToQuery.mockResolvedValue({ id: 'q-1' });

      await controller.respondToQuery('q-1', { response: 'ok' } as any, assayerReq() as any, NORTH_SCOPE as any);

      expect(mockService.resolveRegion).not.toHaveBeenCalled();
      expect(mockRegionGuard.assertRegionAllowedStaged).not.toHaveBeenCalled();
    });

    it('runs the staged region check for a staff caller who is region-restricted', async () => {
      mockService.resolveRegion.mockResolvedValue('SOUTH');
      mockService.respondToQuery.mockResolvedValue({ id: 'q-1' });

      await controller.respondToQuery('q-1', { response: 'ok' } as any, staffReq() as any, NORTH_SCOPE as any);

      expect(mockService.resolveRegion).toHaveBeenCalledWith('q-1');
      expect(mockRegionGuard.assertRegionAllowedStaged).toHaveBeenCalledWith(
        'SOUTH',
        NORTH_SCOPE,
        'validation-query:respondToQuery',
      );
    });

    it('listMessages: skips the lookup for an unrestricted staff caller', async () => {
      mockThreadService.listMessages.mockResolvedValue([]);
      mockThreadService.getQueryDocumentId.mockResolvedValue(null);

      await controller.listMessages('q-1', staffReq() as any, NATIONAL_SCOPE as any);

      expect(mockService.resolveRegion).not.toHaveBeenCalled();
      expect(mockRegionGuard.assertRegionAllowedStaged).not.toHaveBeenCalled();
    });

    it('listMessages: runs the staged check for a region-restricted staff caller', async () => {
      mockService.resolveRegion.mockResolvedValue('SOUTH');
      mockThreadService.listMessages.mockResolvedValue([]);
      mockThreadService.getQueryDocumentId.mockResolvedValue(null);

      await controller.listMessages('q-1', staffReq() as any, NORTH_SCOPE as any);

      expect(mockRegionGuard.assertRegionAllowedStaged).toHaveBeenCalledWith(
        'SOUTH',
        NORTH_SCOPE,
        'validation-query:listMessages',
      );
    });
  });

  describe('findByValidationCase', () => {
    it('resolves the case (not the row-by-row) region and checks it once for staff', async () => {
      mockService.validationCaseRegion.mockResolvedValue('SOUTH');
      mockService.findByValidationCase.mockResolvedValue([]);

      await controller.findByValidationCase('case-1', staffReq() as any, NORTH_SCOPE as any);

      expect(mockService.validationCaseRegion).toHaveBeenCalledWith('case-1');
      expect(mockRegionGuard.assertRegionAllowedStaged).toHaveBeenCalledWith(
        'SOUTH',
        NORTH_SCOPE,
        'validation-query:findByValidationCase',
      );
    });

    it('never resolves a region for an assayer caller', async () => {
      mockService.findByValidationCase.mockResolvedValue([]);

      await controller.findByValidationCase('case-1', assayerReq() as any, NORTH_SCOPE as any);

      expect(mockService.validationCaseRegion).not.toHaveBeenCalled();
    });
  });
});
