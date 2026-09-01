import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { AssayerController } from './assayer.controller';
import { AssayerService } from './assayer.service';
import { RosterImportService } from './roster-import.service';
import { RosterRecordsService } from './roster-records.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { LocationTrailService } from './location-trail.service';
import { QualificationScoreService } from './qualification-score.service';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { FileScanService } from '../../infrastructure/security/file-scan.service';

/**
 * `GET :assayerId/profile` — the profile-read IDOR.
 *
 * `isSelf` used to control only field REDACTION, never whether the read was allowed at all, so
 * any assayer could pull any colleague's profile by id (name, code, phone, email, address,
 * employment status) and get a redacted-but-real record back. These pin the restored
 * `assertSelfOrPrivileged` refusal: an assayer may read only their own profile; staff
 * (ADMIN/OPERATIONS) and the mobile app's own-profile fetch are unaffected.
 */
describe('AssayerController — getProfile', () => {
  let controller: AssayerController;
  let assayerService: { getProfile: jest.Mock };
  let regionGuard: { assertAssayerInScope: jest.Mock };

  const record = {
    id: 'assayer-1',
    assayerCode: 'ASY-0001',
    fullName: 'Test Assayer',
    bankAccountNumber: '123456',
    panNumber: 'ABCDE1234F',
  };

  beforeEach(async () => {
    assayerService = { getProfile: jest.fn().mockResolvedValue(record) };
    regionGuard = { assertAssayerInScope: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AssayerController],
      providers: [
        { provide: AssayerService, useValue: assayerService },
        { provide: RosterImportService, useValue: {} },
        { provide: RosterRecordsService, useValue: {} },
        { provide: 'StorageEngine', useValue: {} },
        { provide: RegionGuardService, useValue: regionGuard },
        { provide: LocationTrailService, useValue: {} },
        { provide: QualificationScoreService, useValue: {} },
        // The document-upload routes carry @UseInterceptors(FileScanInterceptor) at the class
        // level's method decorators; Nest resolves it through DI when the module compiles even
        // though this suite never exercises those routes.
        { provide: FileScanService, useValue: {} },
        FileScanInterceptor,
      ],
    }).compile();

    controller = module.get<AssayerController>(AssayerController);
  });

  it("refuses an assayer reading a colleague's profile", async () => {
    const req = { user: { id: 'assayer-2', roles: [{ name: 'ASSAYER' }] } };

    await expect(controller.getProfile('assayer-1', req)).rejects.toThrow(ForbiddenException);
    expect(assayerService.getProfile).not.toHaveBeenCalled();
    expect(regionGuard.assertAssayerInScope).not.toHaveBeenCalled();
  });

  it('allows an assayer reading their own profile', async () => {
    const req = { user: { id: 'assayer-1', roles: [{ name: 'ASSAYER' }] } };

    const result: any = await controller.getProfile('assayer-1', req);

    expect(result.success).toBe(true);
    expect(assayerService.getProfile).toHaveBeenCalledWith('assayer-1');
  });

  it("allows staff (ADMIN) to read any assayer's profile", async () => {
    const req = { user: { id: 'admin-1', roles: [{ name: 'ADMIN' }] } };

    const result: any = await controller.getProfile('assayer-1', req);

    expect(result.success).toBe(true);
    expect(assayerService.getProfile).toHaveBeenCalledWith('assayer-1');
  });

  it("allows staff (OPERATIONS) to read any assayer's profile", async () => {
    const req = { user: { id: 'ops-1', roles: [{ name: 'OPERATIONS' }] } };

    const result: any = await controller.getProfile('assayer-1', req);

    expect(result.success).toBe(true);
    expect(assayerService.getProfile).toHaveBeenCalledWith('assayer-1');
  });
});
