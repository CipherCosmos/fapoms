import 'reflect-metadata';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { AssayerController } from './assayer.controller';
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
import { SmsProvider } from '../../infrastructure/notifications/sms-provider';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';

// The geocoder is never exercised for real here: `resolveCoordinates` is mocked to "no fix"
// (the ordinary case for a test address) so `create`/`update` never attempt network I/O, and
// `pincodeAuthority` is a plain jest.fn() this suite drives per-test to control the one thing
// `assertAddressConsistent` actually asks it for.
jest.mock('../geo/india-geocoder', () => ({
  pincodeAuthority: jest.fn(),
  geocodeIndia: jest.fn(),
}));
jest.mock('../geo/coordinate-resolution', () => ({
  resolveCoordinates: jest.fn().mockResolvedValue(null),
  needsBetterFix: jest.fn().mockReturnValue(false),
  isPlausibleIndianCoord: jest.fn().mockReturnValue(true),
}));
jest.mock('../geo/osm-geocoder', () => ({
  reverseFreely: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { pincodeAuthority } = require('../geo/india-geocoder');

/**
 * The registration overhaul's write-time rulebook: normalise and help instead of hard-refusing
 * the harmless, and surface the genuinely dangerous instead of letting it through silently.
 *
 * Three live probes of `POST /assayers` motivated this file directly:
 *   - a duplicate phone was accepted with no complaint (see `identifier-check.spec.ts` for the
 *     lookup this drove, and `data-integrity.service.ts`'s `findPhoneMatches`);
 *   - a phone was stored raw as "+91 98765-00011", spaces and dashes intact;
 *   - a lowercase PAN went straight into encryption.
 * Meanwhile the server 400'd on a district-vs-pincode disagreement the wizard's own copy
 * promises will "be saved as entered". This suite pins the fix for all four: the first three now
 * normalise or gate at the DTO layer, and the fourth is reported to a review queue instead of
 * refused.
 */
describe('registration normalisation — the shared rulebook at create AND update', () => {
  let service: AssayerService;

  const NOT_NULL_COLUMNS = new Set(['address', 'city', 'district', 'state', 'employmentType']);
  const mockAssayerManager = { count: jest.fn().mockResolvedValue(0), query: jest.fn().mockResolvedValue([]) };
  const mockAssayerRepo = {
    create: jest.fn((v: any) => v),
    save: jest.fn(async (v: any) => ({ id: v?.id ?? 'asr-new', ...v })),
    findOne: jest.fn().mockResolvedValue(null),
    findAndCount: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    manager: mockAssayerManager,
    metadata: {
      findColumnWithPropertyName: (name: string) => ({
        propertyName: name,
        isNullable: !NOT_NULL_COLUMNS.has(name),
      }),
    },
  };

  const mockWorkforceRepo = { create: jest.fn(), save: jest.fn(), findOne: jest.fn(), find: jest.fn().mockResolvedValue([]), delete: jest.fn() };
  const mockCommercialRepo = { create: jest.fn(), save: jest.fn(), findOne: jest.fn(), find: jest.fn() };
  const mockRemarkRepo = { create: jest.fn(), save: jest.fn(), findOne: jest.fn(), findAndCount: jest.fn(), find: jest.fn() };
  const mockActivityRepo = { create: jest.fn((v: any) => v), save: jest.fn().mockResolvedValue({}), findAndCount: jest.fn(), find: jest.fn() };
  const mockAuditService = { recordEvent: jest.fn(), recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); }) };
  const mockEventPublisher = { publish: jest.fn() };
  const mockWorkflowEngine = {
    registerWorkflow: jest.fn(),
    executeCommand: jest.fn().mockImplementation(async (_key: any, _id: any, _cmd: any, _from: any, _to: any, _uid: any, _role: any, _roles: any, action: any) => action()),
  };
  const mockRosterRecords = { recordDistrictPincodeMismatch: jest.fn().mockResolvedValue({ id: 'issue-1' }) };
  const mockCache = { del: jest.fn().mockResolvedValue(undefined) };
  const mockUow = { run: jest.fn((work: any) => work({ getRepository: () => mockAssayerRepo, query: jest.fn() })) };
  const mockDataSource = { query: jest.fn().mockResolvedValue([]) };

  beforeEach(async () => {
    jest.clearAllMocks();
    (pincodeAuthority as jest.Mock).mockReset();
    mockAssayerRepo.create.mockImplementation((v: any) => v);
    mockAssayerRepo.save.mockImplementation(async (v: any) => ({ id: v?.id ?? 'asr-new', ...v }));
    mockAssayerRepo.findOne.mockResolvedValue(null);
    mockWorkforceRepo.find.mockResolvedValue([]);
    mockAuditService.recordEvent.mockClear();
    mockRosterRecords.recordDistrictPincodeMismatch.mockResolvedValue({ id: 'issue-1' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssayerService,
        { provide: getRepositoryToken(AssayerEntity), useValue: mockAssayerRepo },
        { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: mockCommercialRepo },
        { provide: getRepositoryToken(WorkforceAttributeEntity), useValue: mockWorkforceRepo },
        { provide: getRepositoryToken(AssayerRemarkEntity), useValue: mockRemarkRepo },
        { provide: getRepositoryToken(AssayerActivityEntity), useValue: mockActivityRepo },
        { provide: AuditService, useValue: mockAuditService },
        { provide: DomainEventPublisher, useValue: mockEventPublisher },
        { provide: WorkflowEngine, useValue: mockWorkflowEngine },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn() } },
        { provide: NotificationService, useValue: { notifyAssayer: jest.fn().mockResolvedValue({ inAppDelivered: true }) } },
        { provide: EmailProvider, useValue: { send: jest.fn() } },
        { provide: SmsProvider, useValue: { send: jest.fn() } },
        { provide: UnitOfWork, useValue: mockUow },
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: CacheService, useValue: mockCache },
        { provide: RosterRecordsService, useValue: mockRosterRecords },
      ],
    }).compile();

    service = module.get<AssayerService>(AssayerService);
  });

  /** `assayerCode` supplied on purpose: it routes `create()` past `allocateAssayerCode`'s scan
   * of the whole roster, which this suite has no reason to exercise. */
  const MINIMAL = { assayerCode: 'AS9001', firstName: 'Asha', lastName: 'Nair', state: 'Kerala' };

  describe('phone → stored compact +91 form, at create AND update', () => {
    it("create: the live probe's own example — a raw, messy phone — is stored compact", async () => {
      const saved = await service.create({ ...MINIMAL, phone: '+91 98765-00011' } as any, 'user-1');
      expect(saved.phone).toBe('+919876500011');
    });

    it('update: the same messy phone normalises the same way', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', firstName: 'A', lastName: 'B', isActive: true });

      const saved = await service.update('asr-1', { phone: '+91 98765-00011' } as any, 'user-1');
      expect(saved.phone).toBe('+919876500011');
    });

    it('normalises alternatePhone and emergencyContactPhone the same way', async () => {
      const saved = await service.create({
        ...MINIMAL, alternatePhone: '0 98765 00011', emergencyContactPhone: '91 9876500011',
      } as any, 'user-1');

      expect(saved.alternatePhone).toBe('+919876500011');
      expect(saved.emergencyContactPhone).toBe('+919876500011');
    });

    it('an empty phone still clears to null — unchanged behaviour for the "clear this field" case', async () => {
      const saved = await service.create({ ...MINIMAL, phone: '' } as any, 'user-1');
      expect(saved.phone).toBeNull();
    });

    it('a phone that does not normalise is left exactly as it arrived — no invented refusal here', async () => {
      // The DTO's own `@IsIndianMobile()` validator is what would actually refuse this; calling
      // the service directly (as every test in this file does) bypasses that layer on purpose,
      // to prove THIS function does not add a second opinion of its own.
      const saved = await service.create({ ...MINIMAL, phone: 'not-a-phone' } as any, 'user-1');
      expect(saved.phone).toBe('not-a-phone');
    });
  });

  describe('PAN and IFSC uppercased before they reach encryption, at create AND update', () => {
    it('create: a lowercase PAN is stored uppercase', async () => {
      const saved = await service.create({ ...MINIMAL, panNumber: 'abcde1234f' } as any, 'user-1');
      expect(saved.panNumber).toBe('ABCDE1234F');
    });

    it('update: the same lowercase PAN uppercases the same way', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', firstName: 'A', lastName: 'B', isActive: true });

      const saved = await service.update('asr-1', { panNumber: 'abcde1234f' } as any, 'user-1');
      expect(saved.panNumber).toBe('ABCDE1234F');
    });

    it('a lowercase IFSC uppercases too', async () => {
      const saved = await service.create({ ...MINIMAL, ifscCode: 'sbin0001234' } as any, 'user-1');
      expect(saved.ifscCode).toBe('SBIN0001234');
    });
  });

  /**
   * Pincode format is a DTO-layer gate (`IsPincodeFormat`, assayer.controller.ts), not a
   * service-layer one — so this exercises the REAL class bound to the route, the same technique
   * `assayer-identity-dto.spec.ts` uses for PAN/Aadhaar/IFSC/phone, rather than calling
   * `AssayerService` (which never sees an un-shaped pincode: the pipe refuses it first).
   */
  describe('pincode: friendly refusal on shape, before the request ever reaches the service', () => {
    const CreateDto = Reflect.getMetadata('design:paramtypes', AssayerController.prototype, 'create')?.[0];
    const pipe = new ValidationPipe({
      whitelist: true, forbidNonWhitelisted: true, transform: true,
      transformOptions: { enableImplicitConversion: true },
    });
    const runCreate = (body: Record<string, unknown>) => pipe.transform(body, { type: 'body', metatype: CreateDto });
    const DTO_MINIMAL = { firstName: 'Asha', lastName: 'Nair', state: 'Kerala' };

    const messagesOf = async (body: Record<string, unknown>): Promise<string> => {
      try {
        await runCreate(body);
        return '';
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        const res = (e as BadRequestException).getResponse() as { message: string | string[] };
        return [res.message].flat().join(' ');
      }
    };

    it('binds the expected DTO class (the metadata this test reads)', () => {
      expect(CreateDto?.name).toBe('CreateAssayerRequestDto');
    });

    it('refuses a pincode that is not six digits, in the house style', async () => {
      const messages = await messagesOf({ ...DTO_MINIMAL, pincode: '12345' });
      expect(messages).toMatch(/pincode doesn't look right/);
      expect(messages).toContain('400001');
    });

    it('refuses a civilian-impossible pincode — 9 is the Army Postal Service', async () => {
      const messages = await messagesOf({ ...DTO_MINIMAL, pincode: '900001' });
      expect(messages).toMatch(/pincode doesn't look right/);
    });

    it('accepts a real 6-digit civilian pincode', async () => {
      await expect(runCreate({ ...DTO_MINIMAL, pincode: '411001' })).resolves.toBeInstanceOf(CreateDto);
    });

    it('accepts an empty string as "leave it blank", same convention as PAN/IFSC/phone', async () => {
      await expect(runCreate({ ...DTO_MINIMAL, pincode: '' })).resolves.toBeInstanceOf(CreateDto);
    });
  });

  describe('impossible dates refused with the value named, at create AND update', () => {
    it('refuses a joining date more than a year out, naming the date and how far', async () => {
      const farFuture = new Date();
      farFuture.setFullYear(farFuture.getFullYear() + 5);
      const iso = farFuture.toISOString().slice(0, 10);

      await expect(service.create({ ...MINIMAL, joiningDate: iso } as any, 'user-1'))
        .rejects.toThrow(/The joining date reads .+ — that is \d+ years away; check the year\./);
    });

    it('refuses a joining date before the year 2000', async () => {
      await expect(service.create({ ...MINIMAL, joiningDate: '1998-01-01' } as any, 'user-1'))
        .rejects.toThrow(/The joining date reads .+ — that is before 2000; check the year\./);
    });

    it('does NOT refuse a joining date exactly one year out — only MORE than a year is impossible', async () => {
      const oneYearOut = new Date();
      oneYearOut.setFullYear(oneYearOut.getFullYear() + 1);
      const iso = oneYearOut.toISOString().slice(0, 10);

      await expect(service.create({ ...MINIMAL, joiningDate: iso } as any, 'user-1')).resolves.toBeDefined();
    });

    it('refuses a date of birth in the future', async () => {
      const nextYear = new Date();
      nextYear.setFullYear(nextYear.getFullYear() + 1);
      const iso = nextYear.toISOString().slice(0, 10);

      await expect(service.create({ ...MINIMAL, dateOfBirth: iso } as any, 'user-1'))
        .rejects.toThrow(/The date of birth reads .+ — that is in the future; check the year\./);
    });

    it('refuses a date of birth before 1930', async () => {
      await expect(service.create({ ...MINIMAL, dateOfBirth: '1899-06-15' } as any, 'user-1'))
        .rejects.toThrow(/The date of birth reads .+ — that is before 1930; check the year\./);
    });

    it('accepts an ordinary joining date and date of birth', async () => {
      await expect(
        service.create({ ...MINIMAL, joiningDate: '2024-01-15', dateOfBirth: '1990-05-20' } as any, 'user-1'),
      ).resolves.toBeDefined();
    });

    it('on update, judges only the date the request actually touches', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', firstName: 'A', lastName: 'B', isActive: true });

      await expect(service.update('asr-1', { joiningDate: '1998-01-01' } as any, 'user-1'))
        .rejects.toThrow(/before 2000/);
      await expect(service.update('asr-1', { notes: 'Reachable after 5pm' } as any, 'user-1'))
        .resolves.toBeDefined();
    });
  });

  describe('district-vs-pincode disagreement: saved as entered, filed for review, never thrown', () => {
    beforeEach(() => {
      (pincodeAuthority as jest.Mock).mockResolvedValue({ state: 'Maharashtra', district: 'Pune' });
    });

    it('create: saves the record with the entered district and files a review row instead of 400ing', async () => {
      const saved = await service.create({
        ...MINIMAL, state: 'Maharashtra', district: 'Nashik', pincode: '411001',
      } as any, 'user-1');

      // Saved exactly as entered — not corrected, not blanked, not refused.
      expect(saved.district).toBe('Nashik');
      expect(mockRosterRecords.recordDistrictPincodeMismatch).toHaveBeenCalledWith(
        saved.id,
        expect.objectContaining({
          enteredDistrict: 'Nashik', authorityDistrict: 'Pune', authorityState: 'Maharashtra', pincode: '411001',
        }),
        'user-1',
      );
    });

    it('update: the same behaviour when an edit introduces the disagreement', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', firstName: 'A', lastName: 'B', isActive: true,
        address: 'Some Road', city: 'Pune', district: 'Pune', state: 'Maharashtra', pincode: '411001',
      });

      const saved = await service.update('asr-1', { district: 'Nashik' } as any, 'user-1');

      expect(saved.district).toBe('Nashik');
      expect(mockRosterRecords.recordDistrictPincodeMismatch).toHaveBeenCalledWith(
        'asr-1',
        expect.objectContaining({ enteredDistrict: 'Nashik' }),
        'user-1',
      );
    });

    it('files nothing, and throws nothing, when district and pincode agree', async () => {
      const saved = await service.create({
        ...MINIMAL, state: 'Maharashtra', district: 'Pune', pincode: '411001',
      } as any, 'user-1');

      expect(saved.district).toBe('Pune');
      expect(mockRosterRecords.recordDistrictPincodeMismatch).not.toHaveBeenCalled();
    });

    it('still refuses an unknown state outright — only the district/pincode disagreement was downgraded', async () => {
      await expect(service.create({
        ...MINIMAL, state: 'Freedonia', district: 'Nashik', pincode: '411001',
      } as any, 'user-1')).rejects.toThrow(/not a state we recognise/);

      expect(mockRosterRecords.recordDistrictPincodeMismatch).not.toHaveBeenCalled();
    });
  });

  /**
   * The rehire edge (RESIGNED/TERMINATED → INVITED) exercised end to end through
   * `transitionLifecycle`, using the same harness as the rest of this file. `assayer.state-
   * machine.spec.ts` pins the state machine's OWN contract (the edge is legal; the machine
   * itself touches status only); this pins the service-level consequence the task calls
   * load-bearing — that a rehire actually clears the stale departure dates a `stillWorkable`-
   * style reader elsewhere would otherwise still see.
   */
  describe('rehire — entering INVITED from a departed state clears exit/termination dates', () => {
    const resignedAssayer = () => ({
      id: 'asr-1', lifecycleStatus: 'RESIGNED', status: 'INACTIVE', isActive: true,
      exitDate: new Date('2024-01-01'), terminationDate: null,
    });

    beforeEach(() => {
      mockAssayerRepo.findOne.mockResolvedValue(resignedAssayer());
      mockAssayerRepo.save.mockImplementation(async (a: any) => a);
    });

    it('requires a reason, like every other departure-adjacent move', async () => {
      await expect(service.transitionLifecycle('asr-1', 'INVITED', 'user-1'))
        .rejects.toThrow(/Say why this assayer is being moved/);
    });

    it('moves RESIGNED to INVITED and clears the exit date', async () => {
      const saved = await service.transitionLifecycle('asr-1', 'INVITED', 'user-1', 'Rejoining after a career break');

      expect(saved.lifecycleStatus).toBe('INVITED');
      expect(saved.exitDate).toBeNull();
    });

    it('clears a termination date too, on a terminated rehire', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-2', lifecycleStatus: 'TERMINATED', status: 'INACTIVE', isActive: true,
        exitDate: new Date('2023-06-01'), terminationDate: new Date('2023-06-01'),
      });

      const saved = await service.transitionLifecycle('asr-2', 'INVITED', 'user-1', 'Panel cleared them for rehire');

      expect(saved.exitDate).toBeNull();
      expect(saved.terminationDate).toBeNull();
    });

    it('records the move so the audit trail reads as a rehire, dates and reason both', async () => {
      await service.transitionLifecycle('asr-1', 'INVITED', 'user-1', 'Rejoining after a career break');

      const call = mockAuditService.recordEvent.mock.calls.find((c: any) => c[0].eventType === 'ASSAYER_LIFECYCLE_TRANSITION');
      expect(call).toBeDefined();
      expect(call[0].previousState).toBe('RESIGNED');
      expect(call[0].newState).toBe('INVITED');
      expect(call[0].remarks).toMatch(/Rejoining after a career break/);
      expect(call[0].remarks).toMatch(/exit date .* cleared on rehire/);
    });
  });

  /**
   * India-first naming: `fullName` is the authored truth — stored verbatim as displayName,
   * with first/last demoted to importer-convention tokens (all-but-last / last). Indian names
   * do not split: initial-style ("A K Venkatesan"), father's-name middles, single tokens.
   */
  describe('fullName — the Aadhaar/PAN-printed name, authored whole', () => {
    it('create: stored verbatim, tokens derived the importer\'s way', async () => {
      const saved = await service.create(
        { assayerCode: 'AS9101', fullName: '  Aatish   Anantkumar Pala ', state: 'Gujarat' } as any,
        'user-1',
      );
      expect(saved.displayName).toBe('Aatish Anantkumar Pala');
      expect(saved.firstName).toBe('Aatish Anantkumar');
      expect(saved.lastName).toBe('Pala');
    });

    it('create: a Tamil initial-style name survives untouched', async () => {
      const saved = await service.create(
        { assayerCode: 'AS9102', fullName: 'A K Venkatesan', state: 'Tamil Nadu' } as any,
        'user-1',
      );
      expect(saved.displayName).toBe('A K Venkatesan');
    });

    it('create: a single-token name is legitimate — lastName stays empty', async () => {
      const saved = await service.create(
        { assayerCode: 'AS9103', fullName: 'Ilavarasan', state: 'Tamil Nadu' } as any,
        'user-1',
      );
      expect(saved.displayName).toBe('Ilavarasan');
      expect(saved.firstName).toBe('Ilavarasan');
      expect(saved.lastName).toBe('');
    });

    it('create: with neither fullName nor the legacy pair, refused in plain English', async () => {
      await expect(
        service.create({ assayerCode: 'AS9104', state: 'Kerala' } as any, 'user-1'),
      ).rejects.toThrow(/full name — exactly as printed on their Aadhaar or PAN/);
    });

    it('create: the legacy first/last pair still works (imports, older clients)', async () => {
      const saved = await service.create({ ...MINIMAL } as any, 'user-1');
      expect(saved.displayName).toBe('Asha Nair');
    });

    it('update: fullName rewrites displayName and re-derives the tokens', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'asr-1', firstName: 'Asha', lastName: 'Nair', displayName: 'Asha Nair', isActive: true,
      });
      const saved = await service.update('asr-1', { fullName: 'Asha P Nair' } as any, 'user-1');
      expect(saved.displayName).toBe('Asha P Nair');
      expect(saved.firstName).toBe('Asha P');
      expect(saved.lastName).toBe('Nair');
    });
  });
});
