import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { AssayerService } from './assayer.service';
import { AssayerEntity } from './assayer.entity';
import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from './workforce-attribute.entity';
import { AssayerRemarkEntity } from './assayer-remark.entity';
import { AssayerActivityEntity } from './assayer-activity.entity';
import { RosterRecordsService } from './roster-records.service';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { NotificationService } from '../notifications/notification.service';
import { EmailProvider } from '../../infrastructure/notifications/email-provider';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';

// The real resolver, observed: rule 1 (a supplied pair) answers without a lookup, so the one test
// that needs it can run it for real, and the others replace it per test.
jest.mock('../geo/coordinate-resolution', () => {
  const actual = jest.requireActual('../geo/coordinate-resolution');
  return { ...actual, resolveCoordinates: jest.fn(actual.resolveCoordinates) };
});
// `assertAddressConsistent` asks Google about a pincode when a key is configured; none of these
// fixtures carries a pincode, but a developer's own key must not make this suite reach out.
jest.mock('../geo/india-geocoder', () => ({
  ...jest.requireActual('../geo/india-geocoder'),
  pincodeAuthority: jest.fn().mockResolvedValue(null),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const resolution = require('../geo/coordinate-resolution');
const resolveCoordinates = resolution.resolveCoordinates as jest.Mock;
const realResolveCoordinates = jest.requireActual('../geo/coordinate-resolution').resolveCoordinates;

/**
 * Where a person is placed on the map when they are admitted — and how long admission waits for it.
 *
 * `create` resolved every new person through the whole free geocoding chain inside the request:
 * India Post, the self-hosted Nominatim, then public Photon, spaced 1.1 s apart across the process
 * with a 12 s timeout. Its only production caller is application approval, which therefore took
 * 2–6 s and could pass the web client's 30 s timeout — and a reviewer who saw that pressed Approve
 * again. Placement for an address a map can read now belongs to the background precision worker,
 * which approval hands the person to once its own writes are done.
 *
 * What must NOT change is also pinned: a pin somebody placed is kept exactly as placed, and an
 * address the worker would refuse still gets the coarse placement it always got.
 */
describe('placing a person on the map when they are admitted', () => {
  let service: AssayerService;

  const mockAssayerManager = { count: jest.fn().mockResolvedValue(0), query: jest.fn().mockResolvedValue([]) };
  const mockAssayerRepo = {
    create: jest.fn((v: any) => v),
    save: jest.fn(async (v: any) => ({ id: v?.id ?? 'asr-new', ...v })),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    manager: mockAssayerManager,
  };
  const mockWorkforceRepo = { create: jest.fn(), save: jest.fn(), findOne: jest.fn(), find: jest.fn().mockResolvedValue([]), delete: jest.fn() };
  const mockActivityRepo = { create: jest.fn((v: any) => v), save: jest.fn().mockResolvedValue({}), find: jest.fn() };
  const mockUow = { run: jest.fn((work: any) => work({ getRepository: () => mockAssayerRepo, query: jest.fn() })) };

  beforeEach(async () => {
    jest.clearAllMocks();
    resolveCoordinates.mockImplementation(realResolveCoordinates);
    mockAssayerRepo.create.mockImplementation((v: any) => v);
    mockAssayerRepo.save.mockImplementation(async (v: any) => ({ id: v?.id ?? 'asr-new', ...v }));
    mockAssayerRepo.find.mockResolvedValue([]);
    mockWorkforceRepo.find.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssayerService,
        { provide: getRepositoryToken(AssayerEntity), useValue: mockAssayerRepo },
        { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(WorkforceAttributeEntity), useValue: mockWorkforceRepo },
        { provide: getRepositoryToken(AssayerRemarkEntity), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(AssayerActivityEntity), useValue: mockActivityRepo },
        { provide: AuditService, useValue: { recordEventSafe: jest.fn().mockResolvedValue(undefined) } },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        { provide: WorkflowEngine, useValue: { registerWorkflow: jest.fn() } },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn() } },
        { provide: NotificationService, useValue: { notifyAssayer: jest.fn() } },
        { provide: EmailProvider, useValue: { send: jest.fn() } },
        { provide: UnitOfWork, useValue: mockUow },
        { provide: getDataSourceToken(), useValue: { query: jest.fn().mockResolvedValue([]) } },
        { provide: CacheService, useValue: { del: jest.fn() } },
        { provide: RosterRecordsService, useValue: { recordDistrictPincodeMismatch: jest.fn() } },
      ],
    }).compile();

    service = module.get<AssayerService>(AssayerService);
  });

  /** A supplied code keeps `create` off the whole-roster scan `allocateAssayerCode` does. */
  const PERSON = {
    assayerCode: 'AS9001', firstName: 'Asha', lastName: 'Nair', state: 'Kerala', district: 'Thiruvananthapuram',
    city: 'Thiruvananthapuram', address: 'TC 12/345, Pattom Palace Road, Pattom',
  };

  it('saves a person whose address a map can read without waiting on the geocoder', async () => {
    resolveCoordinates.mockImplementation(() => new Promise(() => undefined));

    const outcome = await Promise.race([
      service.create({ ...PERSON } as any, 'hr-1').then((saved) => saved),
      new Promise((resolve) => setTimeout(() => resolve('still waiting on the geocoder'), 500)),
    ]);

    expect(outcome).not.toBe('still waiting on the geocoder');
    expect(resolveCoordinates).not.toHaveBeenCalled();
    // Unplaced, and honestly so: no coordinate and no tier, which is what the worker selects on.
    expect((outcome as AssayerEntity).latitude ?? null).toBeNull();
    expect((outcome as AssayerEntity).geoSource ?? null).toBeNull();
  });

  it('keeps a pin the caller supplied, exactly where it was placed and marked as placed by hand', async () => {
    const saved = await service.create({ ...PERSON, latitude: 8.5241, longitude: 76.9366 } as any, 'hr-1');

    expect(Number(saved.latitude)).toBeCloseTo(8.5241, 4);
    expect(Number(saved.longitude)).toBeCloseTo(76.9366, 4);
    expect(saved.geoSource).toBe('manual');
    expect(saved.location).toEqual({ type: 'Point', coordinates: [76.9366, 8.5241] });
  });

  /**
   * The worker declines an address that names no place (`isAddressUsable`), so deferring one would
   * leave the person unplaced for good — and refused at activation for having no coordinates. They
   * still resolve here, on the tiers that never touch the rate-limited public providers.
   */
  it('still places an address no map could read, on the coarse tiers only, because the worker will not', async () => {
    resolveCoordinates.mockResolvedValue({
      latitude: 8.52, longitude: 76.94, location: { type: 'Point', coordinates: [76.94, 8.52] },
      geoSource: 'locality', geoAccuracyMeters: 15000, geoMatchedName: 'Thiruvananthapuram', geoResolvedAt: new Date(),
    });

    const saved = await service.create({ ...PERSON, address: '' } as any, 'hr-1');

    expect(resolveCoordinates).toHaveBeenCalledWith(expect.objectContaining({ precise: false }));
    expect(saved.geoSource).toBe('locality');
    expect(Number(saved.latitude)).toBeCloseTo(8.52, 2);
  });
});
