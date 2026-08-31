import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { QualificationScoreService } from './qualification-score.service';
import { AssayerEntity } from './assayer.entity';
import { AssayerScoreOverrideEntity } from './assayer-score-override.entity';
import { AssayerRemarkEntity } from './assayer-remark.entity';
import { AssayerReferenceEntity } from './assayer-reference.entity';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { ClientEntity } from '../client/client.entity';
import { AssayerService } from './assayer.service';
import { RosterRecordsService } from './roster-records.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';

/**
 * Wiring tests for the qualification service. The formulas themselves are pinned in
 * qualification-score.contract.spec.ts; what is asserted here is the service's promises:
 * an override annotates (computed survives beside it), a cleared override restores the
 * computed number, every override write is audited, and a barred assayer is 0 for that
 * partner no matter how strong their profile.
 */
describe('QualificationScoreService', () => {
  const repo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn((x: any) => Promise.resolve({ id: 'ov-1', ...x })),
    create: jest.fn((x: any) => x),
    manager: { query: jest.fn().mockResolvedValue([]) },
  });

  let service: QualificationScoreService;
  let assayers: any, overrides: any, clients: any, docs: any, refs: any, checks: any, emp: any, remarks: any;
  let assayerService: any;

  const ASSAYER = {
    id: 'a-1', displayName: 'Test Person', assayerCode: 'AS0001',
    phone: '9999999999', panNumber: 'ABCDE1234F', bankAccountNumber: '1', ifscCode: 'HDFC0000001',
    joiningDate: '2024-01-01', emergencyContactPhone: '8', latitude: 19.1,
    totalAssignments: 0, completedAssignments: 0, onTimeCompletions: 0,
    city: 'Pune', district: 'Pune', state: 'Maharashtra', lifecycleStatus: 'ACTIVE',
    email: 'x@y.z', experienceYears: 3, aadhaarNumber: '123456789012',
  };

  beforeEach(async () => {
    assayers = repo(); overrides = repo(); clients = repo();
    docs = repo(); refs = repo(); checks = repo(); emp = repo(); remarks = repo();
    assayers.findOne.mockResolvedValue({ ...ASSAYER });
    assayerService = {
      hydrateWorkforceAttributes: jest.fn(async (a: any) => { a.skills = []; a.certifications = []; return a; }),
      hydrateAllWorkforceAttributes: jest.fn(async () => undefined),
      recordActivity: jest.fn().mockResolvedValue(undefined),
    };

    const mod = await Test.createTestingModule({
      providers: [
        QualificationScoreService,
        { provide: getRepositoryToken(AssayerEntity), useValue: assayers },
        { provide: getRepositoryToken(AssayerScoreOverrideEntity), useValue: overrides },
        { provide: getRepositoryToken(AssayerRemarkEntity), useValue: remarks },
        { provide: getRepositoryToken(AssayerReferenceEntity), useValue: refs },
        { provide: getRepositoryToken(AssayerBackgroundCheckEntity), useValue: checks },
        { provide: getRepositoryToken(AssayerDocumentEntity), useValue: docs },
        { provide: getRepositoryToken(AssayerClientEmpanelmentEntity), useValue: emp },
        { provide: getRepositoryToken(ClientEntity), useValue: clients },
        { provide: AssayerService, useValue: assayerService },
        { provide: RosterRecordsService, useValue: {} },
        { provide: PlatformSettingsService, useValue: { getNumber: jest.fn((_k: string, d: number) => Promise.resolve(d)) } },
      ],
    }).compile();
    service = mod.get(QualificationScoreService);
  });

  it('serves computed and override side by side — an adjusted score is never mistaken for a measured one', async () => {
    overrides.find.mockResolvedValue([
      { id: 'ov-1', dimension: 'payability', value: 10, reason: 'documents faked', setBy: null, setAt: new Date(), clientId: null },
    ]);
    const view = await service.qualification('a-1');
    const pay = view.dimensions.find((d) => d.key === 'payability')!;
    expect(pay.computed).toBe(100); // the record is complete — the data still says so
    expect(pay.effective).toBe(10); // the human's number is what downstream uses
    expect(pay.override?.reason).toBe('documents faked');
    // and the effective overall reflects the overridden dimension, not the computed one
    expect(view.overall.effective).toBeLessThan(view.overall.computed!);
  });

  it('masks PAN and Aadhaar in the print summary — full numbers never reach the page', async () => {
    const view = await service.qualification('a-1');
    expect(view.printSummary.panMasked).toBe('******234F');
    expect(view.printSummary.aadhaarMasked).toBe('********9012');
    expect(JSON.stringify(view.printSummary)).not.toContain('ABCDE1234F');
  });

  it('refuses an override without a reason, an unknown dimension, or an out-of-range value', async () => {
    await expect(service.setOverride('a-1', { dimension: 'payability', value: 50, reason: '  ' }, 'u-1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.setOverride('a-1', { dimension: 'vibes', value: 50, reason: 'x' }, 'u-1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.setOverride('a-1', { dimension: 'payability', value: 101, reason: 'x' }, 'u-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('supersedes the previous live override and audits the write', async () => {
    overrides.find.mockResolvedValue([{ id: 'old', value: 70, isActive: true }]);
    await service.setOverride('a-1', { dimension: 'payability', value: 40, reason: 'site visit found gaps' }, 'u-1');
    // old row soft-deleted, new row saved, activity recorded with the reason
    expect(overrides.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'old', isActive: false }));
    expect(overrides.save).toHaveBeenCalledWith(expect.objectContaining({ value: 40, reason: 'site visit found gaps' }));
    expect(assayerService.recordActivity).toHaveBeenCalledWith(
      'a-1', 'SCORE_OVERRIDE_SET', '70', '40', 'u-1', expect.stringContaining('site visit found gaps'),
    );
  });

  it('clearing an override soft-deletes it and audits the restoration', async () => {
    overrides.findOne.mockResolvedValue({ id: 'ov-9', assayerId: 'a-1', dimension: 'overall', clientId: null, value: 88, isActive: true });
    await service.clearOverride('ov-9', 'u-2');
    expect(overrides.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'ov-9', isActive: false }));
    expect(assayerService.recordActivity).toHaveBeenCalledWith(
      'a-1', 'SCORE_OVERRIDE_CLEARED', '88', null, 'u-2', expect.any(String),
    );
  });

  it('a barred assayer is 0 for that partner, however strong the profile', async () => {
    clients.find.mockResolvedValue([
      { id: 'c-1', name: 'Axis', clientCode: 'AXIS', isActive: true, planningPreferences: {}, restrictedAssayers: ['a-1'] },
    ]);
    const views = await service.partnerQualifications('a-1');
    expect(views).toHaveLength(1);
    expect(views[0].barred).toBe(true);
    expect(views[0].effective).toBe(0);
  });

  it('an empanelment REJECTED standing caps the partner score at 25', async () => {
    clients.find.mockResolvedValue([
      { id: 'c-2', name: 'IDFC', clientCode: 'IDFC', isActive: true, planningPreferences: {}, restrictedAssayers: [] },
    ]);
    emp.find.mockResolvedValue([{ clientId: 'c-2', assayerId: 'a-1', status: 'REJECTED', statusReason: 'client declined', isActive: true }]);
    const views = await service.partnerQualifications('a-1');
    expect(views[0].standing).toBe('REJECTED');
    expect(views[0].standingCap).toBe(25);
    expect(views[0].effective).toBeLessThanOrEqual(25);
    expect(views[0].standingReason).toBe('client declined');
  });
});
