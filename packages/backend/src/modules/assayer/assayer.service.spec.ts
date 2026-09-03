import { readFileSync } from 'fs';
import { join } from 'path';
import * as xlsx from 'xlsx';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AssayerService } from './assayer.service';
import { AssayerEntity } from './assayer.entity';
import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from './workforce-attribute.entity';
import { AssayerRemarkEntity } from './assayer-remark.entity';
import { AssayerActivityEntity } from './assayer-activity.entity';
import { TEMP_PASSWORD_WORDS } from './temp-password-words';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { rbacPrincipalCacheKey } from '../auth/auth.service';
import { EventCategory, AssayerLifecycleStatus } from '@fapoms/shared';
import * as bcrypt from 'bcrypt';

describe('AssayerService', () => {
  let service: AssayerService;

  /**
   * The columns `update()` consults to decide what an emptied field means.
   *
   * It reads nullability off the entity metadata rather than carrying its own list, so the mock
   * has to carry the handful of columns these tests touch. `address` and `city` are the NOT NULL
   * ones — an empty string is right for them and null is refused; the rest take null.
   */
  const NOT_NULL_COLUMNS = new Set(['address', 'city', 'district', 'state', 'employmentType']);
  const mockAssayerRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    find: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    metadata: {
      findColumnWithPropertyName: (name: string) => ({
        propertyName: name,
        isNullable: !NOT_NULL_COLUMNS.has(name),
      }),
    },
  };

  const mockCommercialRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
  };

  const mockWorkforceRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    delete: jest.fn(),
  };

  const mockRemarkRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    find: jest.fn(),
  };

  const mockActivityRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findAndCount: jest.fn(),
    find: jest.fn(),
  };

  const mockAuditService = {
    recordEvent: jest.fn(), recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); }),
  };

  const mockDomainEventPublisher = {
    publish: jest.fn(),
  };

  /** Raw-SQL seam. `hasActiveAssignment` reads through this, so tests drive it from here. */
  const mockDataSource = { query: jest.fn().mockResolvedValue([]) };

  // Tracks whether the cache invalidation has actually COMPLETED (not merely been kicked off) —
  // same seam as UserService's password tests. A macrotask delay means this only flips `true`
  // after a full turn of the event loop, so a regression to a fire-and-forget
  // (`void this.cache.del(...)`) implementation would not have completed it by the time the
  // surrounding service method's promise resolves.
  let cacheInvalidated = false;
  const mockCache = {
    del: jest.fn().mockImplementation(
      (..._keys: string[]) => new Promise<void>((resolve) => setTimeout(() => { cacheInvalidated = true; resolve(); }, 10)),
    ),
  };

  const mockWorkflowEngine = {
    registerWorkflow: jest.fn(),
    executeCommand: jest.fn().mockImplementation(async (key, id, cmd, from, to, uid, role, roles, action) => action()),
  };

  function setupModule() {
    return Test.createTestingModule({
      providers: [
        AssayerService,
        { provide: getRepositoryToken(AssayerEntity), useValue: mockAssayerRepo },
        { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: mockCommercialRepo },
        { provide: getRepositoryToken(WorkforceAttributeEntity), useValue: mockWorkforceRepo },
        { provide: getRepositoryToken(AssayerRemarkEntity), useValue: mockRemarkRepo },
        { provide: getRepositoryToken(AssayerActivityEntity), useValue: mockActivityRepo },
        { provide: AuditService, useValue: mockAuditService },
        { provide: DomainEventPublisher, useValue: mockDomainEventPublisher },
        { provide: WorkflowEngine, useValue: mockWorkflowEngine },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn() } },
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: CacheService, useValue: mockCache },
      ],
    }).compile();
  }

  beforeEach(async () => {
    const module = await setupModule();
    service = module.get<AssayerService>(AssayerService);
    jest.clearAllMocks();
    mockWorkforceRepo.find.mockResolvedValue([]);
    cacheInvalidated = false;
  });

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  /**
   * Skills, certifications, languages and specializations are replaced wholesale by whatever the
   * caller sends. That is fine for the kind the caller sent, and destructive for the ones it did
   * not — which is what an edit form offering one field at a time inevitably does.
   */
  describe('getRosterCommercialProfiles', () => {
    const onDate = new Date('2026-08-20');

    it('reports the profile in force on the date and flags a future one', async () => {
      mockAssayerRepo.find.mockResolvedValue([{ id: 'a-current' }, { id: 'a-future' }, { id: 'a-none' }]);
      mockCommercialRepo.find.mockResolvedValue([
        // a-current: one profile started this year — in force.
        { id: 'p1', assayerId: 'a-current', baseFee: 2000, effectiveStartDate: new Date('2026-01-01'), effectiveEndDate: null },
        // a-future: only a profile starting in December — not yet in force.
        { id: 'p2', assayerId: 'a-future', baseFee: 3000, effectiveStartDate: new Date('2026-12-01'), effectiveEndDate: null },
      ]);

      const rows = await service.getRosterCommercialProfiles(onDate);
      const byId = Object.fromEntries(rows.map((r) => [r.assayerId, r]));

      expect(byId['a-current'].profile?.id).toBe('p1');
      expect(byId['a-future'].profile).toBeNull();
      expect(byId['a-future'].hasFutureProfile).toBe(true);
      // Every assayer appears, including one with no profile at all — it is priced at the default.
      expect(byId['a-none'].profile).toBeNull();
      expect(byId['a-none'].hasFutureProfile).toBe(false);
    });

    it('does not treat an expired profile as in force', async () => {
      mockAssayerRepo.find.mockResolvedValue([{ id: 'a-1' }]);
      mockCommercialRepo.find.mockResolvedValue([
        { id: 'p-old', assayerId: 'a-1', baseFee: 1500, effectiveStartDate: new Date('2025-01-01'), effectiveEndDate: new Date('2025-12-31') },
      ]);

      const [row] = await service.getRosterCommercialProfiles(onDate);
      expect(row.profile).toBeNull();
    });
  });

  /**
   * Sharing has to stay on for the duration of a job, because the movement trail is what confirms
   * the travel that job is paid for — and a control someone can switch off for the very journey
   * they are about to claim for is not a control.
   *
   * The scope of that obligation is the point of these tests: it starts when work is accepted and
   * ends when the work does. Between assignments it is an ordinary setting, which is the line
   * between verifying work and following a person around.
   */
  describe('setLiveTracking — the obligation while holding work', () => {
    beforeEach(() => {
      // Reset rather than clear: a queued `mockResolvedValueOnce` survives clearAllMocks, and a
      // test whose code path short-circuits before querying would leak its value into the next.
      mockDataSource.query.mockReset();
      mockDataSource.query.mockResolvedValue([]); // default: no active work
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isLiveEnabled: true });
      mockAssayerRepo.update.mockResolvedValue({ affected: 1 });
      mockActivityRepo.create.mockImplementation((v: any) => v);
      mockActivityRepo.save.mockResolvedValue({});
    });

    it('refuses to switch sharing off while an assignment is open', async () => {
      mockDataSource.query.mockResolvedValue([{ '?column?': 1 }]); // holds active work

      await expect(service.setLiveTracking('asr-1', false, 'asr-1')).rejects.toThrow(BadRequestException);
      expect(mockAssayerRepo.update).not.toHaveBeenCalled();
    });

    it('explains why, and when they can turn it off', async () => {
      mockDataSource.query.mockResolvedValue([{ '?column?': 1 }]);

      await expect(service.setLiveTracking('asr-1', false, 'asr-1')).rejects.toThrow(
        /confirms your travel .* switch it off once the job is completed/s,
      );
    });

    it('lets them switch it off once no work is open', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isLiveEnabled: true });

      await service.setLiveTracking('asr-1', false, 'asr-1');

      expect(mockAssayerRepo.update).toHaveBeenCalledWith('asr-1', expect.objectContaining({ isLiveEnabled: false }));
    });

    it('never blocks switching sharing on', async () => {
      mockDataSource.query.mockResolvedValue([{ '?column?': 1 }]); // even while holding work
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isLiveEnabled: false });

      await service.setLiveTracking('asr-1', true, 'asr-1');

      expect(mockAssayerRepo.update).toHaveBeenCalledWith('asr-1', expect.objectContaining({ isLiveEnabled: true }));
      // The obligation only ever restricts turning it off, so the check is not even reached.
      expect(mockDataSource.query).not.toHaveBeenCalled();
    });

    it('records the change, so a gap in the trail can be told from a lost signal', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isLiveEnabled: true });

      await service.setLiveTracking('asr-1', false, 'asr-1');

      expect(mockActivityRepo.save).toHaveBeenCalled();
      expect(mockActivityRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'LOCATION_SHARING_DISABLED' }),
      );
    });

    it('does not record an activity when nothing actually changed', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isLiveEnabled: false });

      await service.setLiveTracking('asr-1', false, 'asr-1');

      expect(mockActivityRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('enableLiveTrackingForActiveWork', () => {
    it('turns sharing on when an assayer takes on work', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isLiveEnabled: false });
      mockAssayerRepo.update.mockResolvedValue({ affected: 1 });
      mockActivityRepo.create.mockImplementation((v: any) => v);
      mockActivityRepo.save.mockResolvedValue({});

      await service.enableLiveTrackingForActiveWork('asr-1', 'user-1');

      expect(mockAssayerRepo.update).toHaveBeenCalledWith('asr-1', expect.objectContaining({ isLiveEnabled: true }));
    });

    it('does nothing when sharing is already on', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isLiveEnabled: true });

      await service.enableLiveTrackingForActiveWork('asr-1', 'user-1');

      expect(mockAssayerRepo.update).not.toHaveBeenCalled();
    });

    /**
     * Losing an acceptance because a flag would not flip is a far worse outcome than a trail that
     * starts late — and a late start is visible in the assessment anyway.
     */
    it('never throws, so it cannot fail the acceptance it accompanies', async () => {
      mockAssayerRepo.findOne.mockRejectedValue(new Error('db down'));

      await expect(service.enableLiveTrackingForActiveWork('asr-1', 'user-1')).resolves.toBeUndefined();
    });
  });

  describe('resetPasswordByStaff', () => {
    beforeEach(() => {
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1' });
      mockAssayerRepo.update.mockResolvedValue({ affected: 1 });
    });

    it('generates a temporary password and returns it once when HR supplies none', async () => {
      const result = await service.resetPasswordByStaff('asr-1', undefined, 'hr-1');

      expect(result.generatedPassword).toBeDefined();
      expect(result.generatedPassword!.length).toBeGreaterThanOrEqual(8);
      // The stored hash is of the generated password, not the password itself.
      const { passwordHash, mustChangePassword } = mockAssayerRepo.update.mock.calls.at(-1)![1] as any;
      expect(passwordHash).not.toEqual(result.generatedPassword);
      // A staff-set credential is temporary — the holder must choose their own next sign-in.
      expect(mustChangePassword).toBe(true);
    });

    it('uses the password HR supplied, and returns nothing to echo', async () => {
      const result = await service.resetPasswordByStaff('asr-1', 'chosen-strong-pw', 'hr-1');
      expect(result.generatedPassword).toBeUndefined();
    });

    it('refuses a known shared default even from staff', async () => {
      await expect(service.resetPasswordByStaff('asr-1', 'assayer123', 'hr-1')).rejects.toThrow();
    });

    it('records who reset whose credential', async () => {
      await service.resetPasswordByStaff('asr-1', undefined, 'hr-1');
      expect(mockAuditService.recordEventSafe).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'ASSAYER_PASSWORD_RESET', entityId: 'asr-1', userId: 'hr-1' }),
      );
    });

    /**
     * The assayer-mobile-principal equivalent of UserService.resetPassword's cache/session
     * invalidation (see user.service.password.spec.ts). Without this, an assayer reset by HR —
     * the standard response to "this account is locked out or compromised" — would keep every
     * existing session, including a stolen refresh token, alive for the full refresh TTL.
     */
    it("drops the target assayer's cached RBAC principal, fully awaited, before returning", async () => {
      await service.resetPasswordByStaff('asr-1', 'a-brand-new-password', 'hr-1');

      expect(cacheInvalidated).toBe(true);
      expect(mockCache.del).toHaveBeenCalledWith(rbacPrincipalCacheKey('asr-1'));
    });

    it('publishes user:password-changed so a stolen session cannot survive the reset', async () => {
      await service.resetPasswordByStaff('asr-1', 'a-brand-new-password', 'hr-1');

      expect(mockDomainEventPublisher.publish).toHaveBeenCalledWith('user:password-changed', { userId: 'asr-1' });
    });
  });

  /**
   * The generator used to draw two words from a hardcoded 12-word list (1,320 possible
   * passwords — guessable within the account-lockout budget). It now draws 4 distinct words
   * from the 2048-word BIP-39 list, which is what these tests exist to protect: they would have
   * caught the original keyspace bug via the "distinct across 10,000 draws" assertion below.
   */
  describe('generateTemporaryPassword', () => {
    const generate = (): string => (service as any).generateTemporaryPassword();

    it('joins 4 distinct words from TEMP_PASSWORD_WORDS, plus a trailing digit', () => {
      const password = generate();
      const match = password.match(/^([a-z]+)-([a-z]+)-([a-z]+)-([a-z]+)(\d)$/);
      expect(match).not.toBeNull();

      const [, w1, w2, w3, w4] = match!;
      const drawnWords = [w1, w2, w3, w4];

      for (const word of drawnWords) {
        expect(TEMP_PASSWORD_WORDS).toContain(word);
      }
      expect(new Set(drawnWords).size).toBe(4);
    });

    it('never repeats a word within a single password, across many draws', () => {
      for (let i = 0; i < 500; i++) {
        const words = generate().replace(/\d$/, '').split('-');
        expect(new Set(words).size).toBe(words.length);
      }
    });

    /**
     * The regression test for the original bug: the 12-word, two-word format only had
     * 12 x 11 = 132 orderings (1,320 counting the digit/symbol slots) — generating 10,000
     * passwords would collide constantly. The new 2048-word, 4-word format has ~1.75e13
     * possibilities, so collisions across 10,000 draws should be effectively unseen.
     */
    it('produces overwhelmingly distinct passwords across 10,000 draws', () => {
      const passwords = new Set<string>();
      for (let i = 0; i < 10_000; i++) {
        passwords.add(generate());
      }
      expect(passwords.size).toBeGreaterThan(9990);
    });
  });

  describe('changeOwnPassword', () => {
    const currentPassword = 'current-password-1';

    beforeEach(async () => {
      const hash = await bcrypt.hash(currentPassword, 4);
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', passwordHash: hash });
      mockAssayerRepo.update.mockResolvedValue({ affected: 1 });
    });

    /**
     * Mirrors UserService.changePassword's cache/session invalidation (see
     * user.service.password.spec.ts). Without it, an assayer who just changed their own
     * password — the standard response to "I think someone else has my credential" — would
     * keep every other session, including a stolen refresh token, alive for the full refresh
     * TTL: exactly the bug this closes on the assayer-mobile-principal side.
     */
    it("drops the caller's cached RBAC principal, fully awaited, before returning", async () => {
      await service.changeOwnPassword('asr-1', currentPassword, 'brand-new-password-1');

      expect(cacheInvalidated).toBe(true);
      expect(mockCache.del).toHaveBeenCalledWith(rbacPrincipalCacheKey('asr-1'));
    });

    it('publishes user:password-changed so every other session is revoked', async () => {
      await service.changeOwnPassword('asr-1', currentPassword, 'brand-new-password-1');

      expect(mockDomainEventPublisher.publish).toHaveBeenCalledWith('user:password-changed', { userId: 'asr-1' });
    });

    it('never invalidates the cache when the current password is wrong', async () => {
      await expect(
        service.changeOwnPassword('asr-1', 'totally-wrong', 'brand-new-password-1'),
      ).rejects.toThrow();

      expect(mockCache.del).not.toHaveBeenCalled();
      expect(mockDomainEventPublisher.publish).not.toHaveBeenCalled();
    });
  });

  /**
   * What an emptied box means, decided against the schema.
   *
   * Forms send `''` for a field the operator cleared, and whether that is storable depends
   * entirely on the column. `manager_id` is a uuid and `''` is not one; `employee_id` is unique,
   * so two records cleared to `''` collide on the second; `address` and `city` are NOT NULL and
   * `''` is exactly right for them. All three used to surface as a bare 500 with a Postgres
   * message in it, which is what "the save failed and I don't know why" was.
   */
  describe('clearing a field', () => {
    const existing = () => ({
      id: 'as-1', firstName: 'Rajesh', lastName: 'Gupta', displayName: 'Rajesh Gupta',
      address: 'Nashik Road', city: 'Nashik', district: 'Nashik', state: 'Maharashtra',
      pincode: '422101', managerId: 'mgr-1', employeeId: 'EMP-9', panNumber: 'PQRST2345M',
      isActive: true,
    });

    beforeEach(() => {
      mockAssayerRepo.findOne.mockResolvedValue(existing());
      mockAssayerRepo.save.mockImplementation(async (a: any) => a);
    });

    it('stores null for a nullable column, so a uuid never receives an empty string', async () => {
      const saved = await service.update('as-1', { managerId: '' } as any, 'u-1');
      expect(saved.managerId).toBeNull();
    });

    it('stores null for a unique column, so two cleared records cannot collide', async () => {
      const saved = await service.update('as-1', { employeeId: '' } as any, 'u-1');
      expect(saved.employeeId).toBeNull();
    });

    it('keeps an empty string where the column refuses null', async () => {
      const saved = await service.update('as-1', { address: '' } as any, 'u-1');
      expect(saved.address).toBe('');
    });

    it('refuses an explicit null on a NOT NULL column, and says which field', async () => {
      await expect(service.update('as-1', { city: null } as any, 'u-1'))
        .rejects.toThrow(/city cannot be emptied/);
    });

    it('leaves a field the caller did not mention alone', async () => {
      const saved = await service.update('as-1', { panNumber: '' } as any, 'u-1');
      expect(saved.address).toBe('Nashik Road');
      expect(saved.panNumber).toBeNull();
    });
  });

  /**
   * A coordinate somebody placed by hand must survive the nightly geocoder.
   *
   * The sweep skips `geo_source = 'manual'`, so everything turns on the ordinary profile update
   * marking a supplied pair that way. It does — `suppliedIsManual: coordsSupplied` — but nothing
   * held the wiring down, and in the gap a comment in the mobile client came to claim the
   * opposite: that saving a coordinate through this route left it re-geocodable and the next
   * sweep would move the person back to the wrong place. That comment was written two weeks
   * AFTER the code that contradicts it, and an audit of the app later reported the phantom
   * asymmetry as a live defect on the strength of it.
   *
   * The behaviour was right the whole time. These tests exist so the next person reads a fact
   * instead of a guess — the assayer who drags their pin to their actual house on the Profile →
   * Address screen keeps it, exactly like the one who taps the home-screen banner.
   */
  describe('a coordinate placed by hand', () => {
    const existing = () => ({
      id: 'as-9', assayerCode: 'AS0009', displayName: 'Meera Iyer',
      address: 'Kothrud', city: 'Pune', district: 'Pune', state: 'Maharashtra',
      pincode: '411038', isActive: true,
      latitude: 18.9, longitude: 73.1, geoSource: 'pincode', geoAccuracyMeters: 3000,
    });

    beforeEach(() => {
      mockAssayerRepo.findOne.mockResolvedValue(existing());
      mockAssayerRepo.save.mockImplementation(async (a: any) => a);
    });

    it('is stored as manual when the profile update carries a coordinate pair', async () => {
      const saved: any = await service.update(
        'as-9', { latitude: 18.5074, longitude: 73.8077 } as any, 'u-1',
      );

      expect(saved.geoSource).toBe('manual');
      expect(Number(saved.latitude)).toBeCloseTo(18.5074, 4);
      expect(Number(saved.longitude)).toBeCloseTo(73.8077, 4);
    });

    it('is not re-geocoded when a later edit changes only the address text', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({ ...existing(), geoSource: 'manual' });

      const saved: any = await service.update(
        'as-9', { address: 'Flat 4, Kothrud' } as any, 'u-1',
      );

      // resolveCoordinates returns null for a manual pin with no new pair, so the geo columns
      // are left exactly as they were — the address text moves, the pin does not.
      expect(saved.geoSource).toBe('manual');
      expect(Number(saved.latitude)).toBeCloseTo(18.9, 4);
      expect(saved.address).toBe('Flat 4, Kothrud');
    });
  });

  describe('workforce attributes are replaced per kind, not wholesale', () => {
    const existing = { id: 'asr-1', assayerCode: 'AS-01', displayName: 'John Doe' };

    beforeEach(() => {
      mockAssayerRepo.findOne.mockResolvedValue(existing);
      mockAssayerRepo.save.mockImplementation(async (a: any) => a);
      mockWorkforceRepo.delete.mockResolvedValue({ affected: 0 });
      mockWorkforceRepo.save.mockResolvedValue([]);
    });

    it('touches only the kind supplied, leaving certifications and languages alone', async () => {
      await service.update('asr-1', { skills: ['Gold Assaying'] } as any, 'user-1');

      expect(mockWorkforceRepo.delete).toHaveBeenCalledWith(
        expect.objectContaining({ assayerId: 'asr-1' }),
      );
      const { type } = mockWorkforceRepo.delete.mock.calls.at(-1)![0] as any;
      // In(['SKILL']) — the operator carries its values under _value.
      expect(type._value ?? type).toEqual(['SKILL']);
    });

    it('replaces several kinds when several are supplied', async () => {
      await service.update('asr-1', { skills: ['Gold'], languages: ['Tamil'] } as any, 'user-1');

      const { type } = mockWorkforceRepo.delete.mock.calls.at(-1)![0] as any;
      expect((type._value ?? type).sort()).toEqual(['LANGUAGE', 'SKILL']);
    });

    it('deletes nothing at all when none is supplied', async () => {
      await service.update('asr-1', { firstName: 'Jonathan' } as any, 'user-1');
      expect(mockWorkforceRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('should create an assayer with INVITED lifecycle status', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(null);
      const saved = { id: 'asr-1', assayerCode: 'AS-01', firstName: 'John', lastName: 'Doe',
        displayName: 'John Doe', lifecycleStatus: AssayerLifecycleStatus.INVITED, status: 'INACTIVE' };
      mockAssayerRepo.create.mockReturnValue(saved);
      mockAssayerRepo.save.mockResolvedValue(saved);

      const result = await service.create({
        assayerCode: 'AS-01', firstName: 'John', lastName: 'Doe',
        phone: '9999999999', address: 'Addr', state: 'MH', district: 'Pune', city: 'Pune',
      }, 'user-1');

      expect(result.lifecycleStatus).toBe(AssayerLifecycleStatus.INVITED);
      expect(mockAuditService.recordEvent).toHaveBeenCalled();
    });

    it('should throw ConflictException for duplicate assayer code', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'existing', assayerCode: 'AS-01' });

      await expect(service.create({
        assayerCode: 'AS-01', firstName: 'J', lastName: 'D',
        phone: '9999999999', address: 'Addr', state: 'MH', district: 'Pune', city: 'Pune',
      }, 'user-1')).rejects.toThrow(ConflictException);
    });

    /**
     * Admission asks who this is and where they work. The client rosters this product is fed have
     * seven columns — name, code, residence address, location, district, state, zone — and no
     * phone at all, so requiring one to create the record meant a real roster admitted nobody.
     */
    it('admits an assayer with no phone number, storing null rather than refusing', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(null);
      mockAssayerRepo.create.mockImplementation((v: any) => v);
      mockAssayerRepo.save.mockImplementation((v: any) => Promise.resolve({ id: 'asr-2', ...v }));

      const result = await service.create({
        assayerCode: 'AS-02', firstName: 'Shinil', lastName: 'T',
        state: 'Kerala', district: 'Calicut', city: 'Kunnamangalam', address: 'Thykkattu',
      }, 'user-1');

      expect(result.phone).toBeNull();
      // Still INVITED/INACTIVE, so the recommendation engine's deployability filter keeps an
      // unreachable person off plans until someone completes and activates the record.
      expect(result.lifecycleStatus).toBe(AssayerLifecycleStatus.INVITED);
    });

    it('admits an assayer with no address, city or district — the columns stay non-null', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(null);
      mockAssayerRepo.create.mockImplementation((v: any) => v);
      mockAssayerRepo.save.mockImplementation((v: any) => Promise.resolve({ id: 'asr-3', ...v }));

      const result = await service.create({
        assayerCode: 'AS-03', firstName: 'A', lastName: 'K', state: 'Kerala',
      }, 'user-1');

      // Empty, not null: these are NOT NULL columns, and blank is what `missingCriticalFields`
      // reads as missing — so the gap still shows on the record instead of failing the insert.
      expect(result.address).toBe('');
      expect(result.city).toBe('');
      expect(result.district).toBe('');
    });
  });

  describe('findOne', () => {
    it('should throw NotFoundException if assayer does not exist', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne('bad-id')).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle Transitions
  // ---------------------------------------------------------------------------

  describe('transitionLifecycle', () => {
    const assayer = { id: 'asr-1', assayerCode: 'AS-01', lifecycleStatus: AssayerLifecycleStatus.INVITED,
      status: 'INACTIVE', isActive: true };

    it('should transition from INVITED to DOCUMENT_VERIFICATION', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({ ...assayer });
      mockAssayerRepo.save.mockImplementation((e) => Promise.resolve(e));

      const result = await service.verifyDocuments('asr-1', 'user-1');

      expect(result.lifecycleStatus).toBe(AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
      expect(mockAuditService.recordEvent).toHaveBeenCalled();
    });

    it('should reject invalid transition from INVITED to ACTIVE', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({ ...assayer });

      await expect(
        service.activateAssayer('asr-1', 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should set isActive false when transitioning to ARCHIVED', async () => {
      const activeAssayer = { ...assayer, lifecycleStatus: AssayerLifecycleStatus.RESIGNED };
      mockAssayerRepo.findOne.mockResolvedValue(activeAssayer);
      mockAssayerRepo.save.mockImplementation((e) => Promise.resolve(e));

      const result = await service.archiveAssayer('asr-1', 'user-1');

      expect(result.isActive).toBe(false);
    });

    it('should sync operational status on transition', async () => {
      const testAssayer = { ...assayer, lifecycleStatus: AssayerLifecycleStatus.TRAINING };
      mockAssayerRepo.findOne.mockResolvedValue(testAssayer);
      mockAssayerRepo.save.mockImplementation((e) => Promise.resolve(e));

      const result = await service.activateAssayer('asr-1', 'user-1');

      expect(result.status).toBe('ACTIVE');
    });
  });

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  describe('getActivityTimeline pagination', () => {
    it('should return paginated timeline', async () => {
      const activities = [{ id: 'act-1', eventType: 'ASSAYER_CREATED' }];
      mockActivityRepo.findAndCount.mockResolvedValue([activities, 1]);

      const result = await service.getActivityTimeline('asr-1', 1, 20);

      expect(result.activities).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should not have hard-coded limits', async () => {
      const activities = Array.from({ length: 50 }, (_, i) => ({ id: `act-${i}` }));
      mockActivityRepo.findAndCount.mockResolvedValue([activities, 50]);

      const result = await service.getActivityTimeline('asr-1', 1, 50);

      expect(result.activities).toHaveLength(50);
    });
  });

  // ---------------------------------------------------------------------------
  // Activity Timeline Coverage
  // ---------------------------------------------------------------------------

  describe('activity timeline records', () => {
    it('should create activity on assayer creation', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(null);
      const saved = { id: 'asr-1', assayerCode: 'AS-01', firstName: 'J', lastName: 'D',
        displayName: 'J D', lifecycleStatus: AssayerLifecycleStatus.INVITED, status: 'INACTIVE' };
      mockAssayerRepo.create.mockReturnValue(saved);
      mockAssayerRepo.save.mockResolvedValue(saved);
      mockActivityRepo.create.mockReturnValue({});
      mockActivityRepo.save.mockResolvedValue({});

      await service.create({
        assayerCode: 'AS-01', firstName: 'J', lastName: 'D',
        phone: '9999999999', address: 'Addr', state: 'MH', district: 'Pune', city: 'Pune',
      }, 'user-1');

      expect(mockActivityRepo.save).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Commercial Profiles
  // ---------------------------------------------------------------------------

  describe('allocateAssayerCode', () => {
    /**
     * The company issues appraiser codes as `AS0844` — a series prefix and four digits, no
     * dash. Website-created assayers must continue THAT series at the next free number, not
     * run a parallel `AS-01` numbering that can never merge with the roster's.
     */
    it("continues the company's own series past the roster's highest code", async () => {
      mockAssayerRepo.find.mockResolvedValue([
        { assayerCode: 'AS0844' }, { assayerCode: 'AS0100' }, { assayerCode: 'AD0475' },
        { assayerCode: 'AS-09' }, // a dash-era row the old bug created — read, never emitted
      ]);
      await expect((service as any).allocateAssayerCode()).resolves.toBe('AS0845');
    });

    it('starts the series at AS0001 on an empty roster', async () => {
      mockAssayerRepo.find.mockResolvedValue([]);
      await expect((service as any).allocateAssayerCode()).resolves.toBe('AS0001');
    });
  });

  describe('createCommercialProfile', () => {
    it('should create and audit', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isActive: true });
      mockCommercialRepo.find.mockResolvedValue([]);
      const saved = { id: 'prof-1', assayerId: 'asr-1', baseFee: 1000 };
      mockCommercialRepo.create.mockReturnValue(saved);
      mockCommercialRepo.save.mockResolvedValue(saved);

      await service.createCommercialProfile('asr-1', {
        baseFee: 1000, hourlyRate: 100, dailyRate: 500,
        travelReimbursement: 200, accommodationAllowance: 300, mealAllowance: 50,
        effectiveStartDate: '2026-01-01', currency: 'INR',
      }, 'user-1');

      expect(mockAuditService.recordEvent).toHaveBeenCalled();
    });

    /**
     * A new rate card ends the one it replaces, so no day is ever covered by two.
     *
     * Without this, two open-ended profiles both matched "in force" and the winner was whatever
     * each reader's ORDER BY returned — the fee quoted, booked and paid could differ for the
     * same audit. The database now refuses the overlap too (EXCLUDE, migration 1793400000000);
     * this is the half that keeps that constraint from firing in normal use.
     */
    it('closes the rate card it supersedes, the day before the new one starts', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isActive: true });
      const open = { id: 'prof-old', assayerId: 'asr-1', baseFee: 900, effectiveStartDate: '2025-01-01', effectiveEndDate: null };
      mockCommercialRepo.find.mockResolvedValue([open]);
      mockCommercialRepo.create.mockReturnValue({ id: 'prof-new' });
      mockCommercialRepo.save.mockImplementation(async (x: any) => x);

      await service.createCommercialProfile('asr-1', {
        baseFee: 1200, effectiveStartDate: '2026-03-01', currency: 'INR',
      }, 'user-1');

      const closed = mockCommercialRepo.save.mock.calls
        .map((c: any[]) => c[0])
        .find((x: any) => x?.id === 'prof-old');
      expect(closed).toBeDefined();
      expect(new Date(closed.effectiveEndDate).toISOString().slice(0, 10)).toBe('2026-02-28');
    });

    it('leaves a rate card that already ended before the new one starts alone', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isActive: true });
      const ended = { id: 'prof-ended', assayerId: 'asr-1', effectiveStartDate: '2024-01-01', effectiveEndDate: '2024-12-31' };
      mockCommercialRepo.find.mockResolvedValue([ended]);
      mockCommercialRepo.create.mockReturnValue({ id: 'prof-new' });
      mockCommercialRepo.save.mockImplementation(async (x: any) => x);

      await service.createCommercialProfile('asr-1', {
        baseFee: 1200, effectiveStartDate: '2026-03-01', currency: 'INR',
      }, 'user-1');

      const touched = mockCommercialRepo.save.mock.calls
        .map((c: any[]) => c[0])
        .find((x: any) => x?.id === 'prof-ended');
      expect(touched).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Workforce Attributes
  // ---------------------------------------------------------------------------

  describe('addWorkforceAttribute', () => {
    it('should create and audit', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'asr-1', isActive: true });
      const saved = { id: 'attr-1', type: 'SKILL', name: 'Communication' };
      mockWorkforceRepo.create.mockReturnValue(saved);
      mockWorkforceRepo.save.mockResolvedValue(saved);

      const result = await service.addWorkforceAttribute('asr-1', { type: 'SKILL', name: 'Communication' }, 'user-1');

      expect(mockAuditService.recordEvent).toHaveBeenCalled();
    });
  });

  describe('live location writes', () => {
    /**
     * These previously loaded the whole assayer and called save(), writing back every column
     * from a stale in-memory copy. Position is reported continuously from the field, so any
     * column changed in between was silently reverted — including must_change_password,
     * locked_until and failed_login_attempts. Observed in practice: a forced-rotation flag
     * set by the rotation script was cleared moments later by a location ping.
     */
    beforeEach(() => {
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'a-1', isActive: true });
      mockAssayerRepo.update.mockClear();
      mockAssayerRepo.save.mockClear();
    });

    it('updates only the position columns, never the whole row', async () => {
      await service.updateLiveLocation('a-1', 19.07, 72.87, 'a-1');

      expect(mockAssayerRepo.save).not.toHaveBeenCalled();
      expect(mockAssayerRepo.update).toHaveBeenCalledTimes(1);

      const [, patch] = mockAssayerRepo.update.mock.calls[0];
      expect(Object.keys(patch).sort()).toEqual(
        ['liveLatitude', 'liveLocation', 'liveLongitude', 'updatedBy'].sort(),
      );
      // Nothing security-related may ride along on a location ping.
      for (const forbidden of ['mustChangePassword', 'lockedUntil', 'failedLoginAttempts', 'status', 'passwordHash']) {
        expect(patch).not.toHaveProperty(forbidden);
      }
    });

    it('toggles live sharing without rewriting the rest of the record', async () => {
      await service.setLiveTracking('a-1', true, 'a-1');

      expect(mockAssayerRepo.save).not.toHaveBeenCalled();
      const [, patch] = mockAssayerRepo.update.mock.calls[0];
      expect(Object.keys(patch).sort()).toEqual(['isLiveEnabled', 'updatedBy'].sort());
    });

    it('rejects a non-finite coordinate rather than storing it', async () => {
      await expect(service.updateLiveLocation('a-1', NaN, 72.87)).rejects.toThrow();
      expect(mockAssayerRepo.update).not.toHaveBeenCalled();
    });
  });
  /**
   * The `uploadFromExcel` tests moved to `roster-import.spec.ts`.
   *
   * They covered two things the surviving importer did not do — finding the roster sheet whatever
   * it is called, and refusing a branch list as the wrong file. Rather than delete them with the
   * importer they were written against, the behaviour was moved into `RosterImportService` and the
   * tests followed it there, where they now guard the importer that is actually used.
   */

  /**
   * A skill, language or certification the person already holds must not be added twice.
   *
   * Two identical rows read as a mistake on screen, but the real damage was on removal: deleting
   * the skill took away one row and left the other, so an assayer whose skill HR had just removed
   * still satisfied a SKILL rule and still came back as an eligible candidate.
   */
  describe('addWorkforceAttribute', () => {
    beforeEach(() => {
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'as-1', assayerCode: 'AS-1', isActive: true });
    });

    it('refuses one the assayer already holds, whatever the casing', async () => {
      mockWorkforceRepo.findOne.mockResolvedValue({ id: 'w-1', type: 'SKILL', name: 'Gold Assaying' });

      await expect(
        service.addWorkforceAttribute('as-1', { type: 'SKILL', name: 'gold assaying' }, 'user-1'),
      ).rejects.toThrow(/already has the skill/);

      expect(mockWorkforceRepo.save).not.toHaveBeenCalled();
    });

    it('adds one the assayer does not yet hold', async () => {
      mockWorkforceRepo.findOne.mockResolvedValue(null);
      mockWorkforceRepo.create.mockReturnValue({ id: 'w-2', type: 'SKILL', name: 'Silver Assaying' });
      mockWorkforceRepo.save.mockResolvedValue({ id: 'w-2', type: 'SKILL', name: 'Silver Assaying' });

      const saved = await service.addWorkforceAttribute('as-1', { type: 'SKILL', name: 'Silver Assaying' }, 'user-1');

      expect(saved.id).toBe('w-2');
      expect(mockWorkforceRepo.save).toHaveBeenCalled();
    });
  });
  /**
   * Codes are permanent identifiers — a deleted assayer's payables and audit trail still refer to
   * hers — so a code must never be reissued. The web form used to guess the next one from the
   * number of assayers it had listed, which counts only active people, so the first create after
   * any delete proposed a code that was already taken and was refused outright.
   */
  describe('assayer code allocation', () => {
    it('skips codes held by deleted assayers rather than reusing them', async () => {
      // AS0027 was deleted; only AS0026 is still active. The next code must be AS0028 — a
      // deleted person's code stays theirs, on their documents and in the audit trail.
      mockAssayerRepo.find.mockResolvedValue([
        { assayerCode: 'AS0026' }, { assayerCode: 'AS0027' },
      ]);
      mockAssayerRepo.findOne.mockResolvedValue(null);
      mockAssayerRepo.create.mockImplementation((v: any) => v);
      mockAssayerRepo.save.mockImplementation(async (v: any) => ({ ...v, id: 'as-new' }));

      await service.create(
        { firstName: 'Nita', lastName: 'Rao', state: 'Maharashtra' } as any,
        'user-1',
      );

      expect(mockAssayerRepo.save).toHaveBeenCalledWith(expect.objectContaining({ assayerCode: 'AS0028' }));
    });

    /**
     * The company's real series (`AS0688`) and the dash-era rows the old bug emitted (`AS-03`)
     * are BOTH read when finding the highest, so neither can be collided with — and what gets
     * issued is the company shape. Other series (AD, FO) belong to other intake channels and
     * do not advance this one.
     */
    it("continues the company's series past both code shapes, ignoring other series", async () => {
      mockAssayerRepo.find.mockResolvedValue([
        { assayerCode: 'AS0688' }, { assayerCode: 'AS-03' }, { assayerCode: 'AD0475' },
      ]);
      mockAssayerRepo.findOne.mockResolvedValue(null);
      mockAssayerRepo.create.mockImplementation((v: any) => v);
      mockAssayerRepo.save.mockImplementation(async (v: any) => ({ ...v, id: 'as-new' }));

      await service.create(
        { firstName: 'Ravi', lastName: 'Kumar', state: 'Kerala' } as any,
        'user-1',
      );

      expect(mockAssayerRepo.save).toHaveBeenCalledWith(expect.objectContaining({ assayerCode: 'AS0689' }));
    });

    it('honours a code the caller supplied', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(null);
      mockAssayerRepo.create.mockImplementation((v: any) => v);
      mockAssayerRepo.save.mockImplementation(async (v: any) => ({ ...v, id: 'as-new' }));

      await service.create(
        { assayerCode: 'AS-99', firstName: 'Asha', lastName: 'Devi', state: 'Goa' } as any,
        'user-1',
      );

      expect(mockAssayerRepo.save).toHaveBeenCalledWith(expect.objectContaining({ assayerCode: 'AS-99' }));
    });
  });
  /**
   * Progressing through onboarding explains itself; leaving does not. A record that says only
   * "Moved to TERMINATED" cannot answer anything in a later dispute or reference check, so the
   * adverse moves must carry a reason — the same standard already applied to rejecting an
   * assignment and to sending work back for rework.
   */
  describe('transitionLifecycle — reasons on the record', () => {
    it.each(['SUSPENDED', 'INACTIVE', 'RESIGNED', 'TERMINATED'])(
      'refuses to move someone to %s with no reason',
      async (target) => {
        await expect(service.transitionLifecycle('as-1', target, 'user-1')).rejects.toThrow(/Say why/);
        await expect(service.transitionLifecycle('as-1', target, 'user-1', '   ')).rejects.toThrow(/Say why/);
      },
    );

    it('asks for nothing extra when someone simply progresses through onboarding', async () => {
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'as-1', assayerCode: 'AS-1', lifecycleStatus: 'INVITED', isActive: true,
      });
      mockAssayerRepo.save.mockImplementation(async (v: any) => v);
      mockWorkforceRepo.find.mockResolvedValue([]);

      await expect(
        service.transitionLifecycle('as-1', 'DOCUMENT_VERIFICATION', 'user-1'),
      ).resolves.toBeDefined();
    });
  });
  /**
   * An assayer's state sets their region, zone and holiday calendar, and territory rules match on
   * it — but nothing checked it on any path. The form, the API and the Excel import all accepted
   * "Freedonia", and the damage was quiet: `region` came out null, which drops the person out of
   * every region-scoped view and out of territory matching, while they sit on the roster looking
   * perfectly ordinary.
   */
  describe('create — the state has to be a real one', () => {
    beforeEach(() => {
      mockAssayerRepo.findOne.mockResolvedValue(null);
      mockAssayerRepo.find.mockResolvedValue([]);
      mockAssayerRepo.create.mockImplementation((v: any) => v);
      mockAssayerRepo.save.mockImplementation(async (v: any) => ({ ...v, id: 'as-new' }));
    });

    it('refuses a state that is not a state', async () => {
      await expect(
        service.create({ assayerCode: 'AS-90', firstName: 'A', lastName: 'B', state: 'Freedonia' } as any, 'user-1'),
      ).rejects.toThrow(/is not a state we recognise/);
    });

    /** Both spellings turn up in real rosters, so both have to be accepted. */
    it.each(['Maharashtra', 'MAHARASHTRA', 'MH', 'ANDRAPRADESH', 'Tamil Nadu'])(
      'accepts %s',
      async (state) => {
        await expect(
          service.create({ assayerCode: 'AS-91', firstName: 'A', lastName: 'B', state } as any, 'user-1'),
        ).resolves.toBeDefined();
      },
    );

    it('says nothing when no state was supplied at all', async () => {
      await expect(
        service.create({ assayerCode: 'AS-92', firstName: 'A', lastName: 'B' } as any, 'user-1'),
      ).resolves.toBeDefined();
    });
  });

  /** The day in the office, which is the unit these `date` columns are in. */
  const dayOf = (value: unknown) =>
    new Date(value as any).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const today = () => dayOf(new Date());
  const daysFromNow = (n: number) => dayOf(new Date(Date.now() + n * 86_400_000));

  /**
   * Nobody leaves before they arrive.
   *
   * 36 of the 1,163 people on the live roster have a joining date later than their exit date —
   * one joined in January 2024 and left in December 2023 — because no write path had ever
   * compared the two. Length of service is read off that pair, by HR's attrition figures and by
   * the qualification score's tenure input, and an inverted pair makes both of them nonsense.
   */
  describe('employment dates that cannot both be true', () => {
    const onRoster = (over: Record<string, unknown> = {}) => ({
      id: 'as-1', assayerCode: 'AS0279', firstName: 'Rajesh', lastName: 'Gupta',
      displayName: 'Rajesh Gupta', address: 'Nashik Road', city: 'Nashik', district: 'Nashik',
      state: 'Maharashtra', isActive: true,
      // The driver hands `date` columns back as 'YYYY-MM-DD' strings while an edit has just
      // assigned a `Date` — comparing across those two shapes is the whole difficulty.
      joiningDate: '2020-04-01', exitDate: null, terminationDate: null, ...over,
    });

    beforeEach(() => {
      mockAssayerRepo.save.mockImplementation(async (a: any) => a);
    });

    it('refuses a joining date later than the exit date already on the record', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(onRoster({ exitDate: '2023-12-31' }));

      await expect(service.update('as-1', { joiningDate: '2024-01-18' }, 'u-1'))
        .rejects.toThrow(/joining date \(2024-01-18\) is after the exit date \(2023-12-31\)/);
    });

    it('refuses the same pair when both halves arrive in one edit', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(onRoster());

      await expect(service.update('as-1', { joiningDate: '2024-01-18', exitDate: '2023-12-31' }, 'u-1'))
        .rejects.toThrow(/left before they joined/);
    });

    it('refuses a joining date later than the termination date, naming that one', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(onRoster({ terminationDate: '2024-04-30' }));

      await expect(service.update('as-1', { joiningDate: '2024-05-29' }, 'u-1'))
        .rejects.toThrow(/joining date \(2024-05-29\) is after the termination date \(2024-04-30\)/);
    });

    it('allows joining and leaving on the same day', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(onRoster());

      await expect(service.update('as-1', { joiningDate: '2024-01-18', exitDate: '2024-01-18' }, 'u-1'))
        .resolves.toBeDefined();
    });

    /**
     * Somebody working out a notice period: the leaving date is ahead of today and the pair is in
     * order. The rule is about the order of the two dates and never about which side of today
     * either one falls on.
     */
    it('allows a leaving date in the future', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(onRoster());

      await expect(service.update('as-1', { exitDate: daysFromNow(30) }, 'u-1')).resolves.toBeDefined();
    });

    /**
     * The 36 records already carrying an inverted pair have to stay editable. Validating on every
     * save would refuse a clerk correcting the phone number on one of them — blocking ordinary
     * work on precisely the records the guard exists to protect, with no route to save the
     * correction it is demanding. Touch a date and you own the pair.
     */
    it('does not block an edit that leaves all three dates alone', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(
        onRoster({ joiningDate: '2024-01-18', exitDate: '2023-12-31' }),
      );

      await expect(service.update('as-1', { phone: '9876543210' }, 'u-1')).resolves.toBeDefined();
    });

    it('applies the same rule on admission, so the two paths cannot drift', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(null);
      mockAssayerRepo.find.mockResolvedValue([]);
      mockAssayerRepo.create.mockImplementation((v: any) => v);
      mockAssayerRepo.save.mockImplementation(async (v: any) => ({ ...v, id: 'as-new' }));

      // `CreateAssayerDto` has no exit date today; the guard reads whatever the create payload
      // carries, so it is already standing on the day one is added.
      await expect(service.create({
        assayerCode: 'AS-95', firstName: 'A', lastName: 'B', state: 'Maharashtra',
        joiningDate: '2024-01-18', exitDate: '2023-12-31',
      } as any, 'user-1')).rejects.toThrow(/left before they joined/);
    });

    /**
     * Ordinary roster shapes that must keep saving. A guard that refuses these costs more than
     * the gap it closes.
     */
    it.each([
      ['a leaver with the dates in order', { joiningDate: '2018-06-01', exitDate: '2024-03-31' }],
      ['somebody serving notice', { joiningDate: '2018-06-01', exitDate: daysFromNow(45) }],
      ['a live record with no leaving date at all', { joiningDate: '2018-06-01' }],
      ['a leaving date on a record with no joining date', { exitDate: '2024-03-31' }],
      ['a termination dated after the joining date', { joiningDate: '2018-06-01', terminationDate: '2024-03-31' }],
    ])('accepts %s', async (_case, dates) => {
      mockAssayerRepo.findOne.mockResolvedValue(onRoster({ joiningDate: null }));

      await expect(service.update('as-1', dates as any, 'u-1')).resolves.toBeDefined();
    });
  });

  /**
   * Leaving has to leave a trace the rest of the system can read.
   *
   * 5 of the 1,163 people on the roster are RESIGNED or TERMINATED with no departure date, so
   * every count of departures reports zero for them; 7 who have left still hold an ACTIVE client
   * empanelment, which is what keeps them selectable for that bank's branches; and 2 are ACTIVE
   * with an exit date behind them, the record asserting both things at once.
   */
  describe('a departure the rest of the system can see', () => {
    const working = (over: Record<string, unknown> = {}) => ({
      id: 'as-1', assayerCode: 'AS0431', displayName: 'Meera Nair', isActive: true,
      lifecycleStatus: AssayerLifecycleStatus.ACTIVE, status: 'ACTIVE',
      joiningDate: '2021-06-01', exitDate: null, terminationDate: null, ...over,
    });

    beforeEach(() => {
      mockAssayerRepo.save.mockImplementation(async (a: any) => a);
      mockActivityRepo.create.mockImplementation((v: any) => v);
      mockActivityRepo.save.mockResolvedValue({});
      // Reset rather than clear: a queued `mockResolvedValueOnce` survives clearAllMocks.
      mockDataSource.query.mockReset();
      // TypeORM answers an UPDATE with [rows, rowCount].
      mockDataSource.query.mockResolvedValue([[], 0]);
    });

    it('records the exit date when a resignation carries none', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(working());

      const saved = await service.acceptResignation('as-1', 'u-1', 'Relocating');

      expect(dayOf(saved.exitDate)).toBe(today());
    });

    /**
     * Moved here from assayer.state-machine.spec.ts when the machine stopped stamping dates and
     * `reconcileDepartureDates` became the single writer. HR may already have entered the real
     * last working day; that beats "when the record was updated".
     */
    it('never overwrites a leaving date HR already entered', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(working({ exitDate: '2026-03-31' }));

      const saved = await service.acceptResignation('as-1', 'u-1', 'Relocating');

      expect(dayOf(saved.exitDate)).toBe('2026-03-31');
    });

    /**
     * A termination stamps both. `termination_date` records that they were dismissed; `exit_date`
     * is the column every reader of departures actually uses — all 421 recorded departures on the
     * live roster set it and none set `termination_date` (447 before `repair-corrupt-dates.js`
     * blanked 26 whose years were importer garbage), and HR's own queries read
     * COALESCE(exit_date, termination_date). A termination with only the former is invisible.
     */
    it('records both dates on a termination, so the departure is not invisible', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(
        working({ lifecycleStatus: AssayerLifecycleStatus.SUSPENDED, status: 'SUSPENDED' }),
      );

      const saved = await service.terminateAssayer('as-1', 'u-1', 'Process not followed');

      expect(dayOf(saved.exitDate)).toBe(today());
      expect(dayOf(saved.terminationDate)).toBe(today());
    });

    it("keeps the last working day HR entered rather than today's date", async () => {
      mockAssayerRepo.findOne.mockResolvedValue(working({ exitDate: '2026-07-31' }));

      const saved = await service.acceptResignation('as-1', 'u-1', 'Resigned in July');

      expect(saved.exitDate).toBe('2026-07-31');
    });

    /**
     * The stamp has to survive the same check a typed date does, or the guard becomes the thing
     * writing impossible pairs — automatically, and across a whole batch in a bulk transition.
     */
    it('refuses to stamp a departure that would land before the joining date', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(working({ joiningDate: '2027-03-01' }));

      await expect(service.acceptResignation('as-1', 'u-1', 'Relocating'))
        .rejects.toThrow(/is after the exit date/);
    });

    it('closes the client standings that keep a leaver selectable', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(working());
      mockDataSource.query.mockResolvedValue([[], 2]);

      await service.acceptResignation('as-1', 'u-1', 'Relocating');

      const [sql, params] = mockDataSource.query.mock.calls.at(-1)! as [string, unknown[]];
      expect(sql).toMatch(/UPDATE assayer_client_empanelments/);
      // ACTIVE and RECOMMENDED are the two standings the planner's per-client gate admits;
      // they are closed to INACTIVE, the one closed standing that reads as reversible.
      expect(params).toEqual(expect.arrayContaining(['ACTIVE', 'RECOMMENDED', 'INACTIVE', 'as-1']));
      expect(params.some((p) => typeof p === 'string' && p.includes('RESIGNED'))).toBe(true);
    });

    it('puts the automatic corrections on the record beside the reason', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(working());
      mockDataSource.query.mockResolvedValue([[], 3]);

      await service.acceptResignation('as-1', 'u-1', 'Relocating');

      const { remarks } = mockAuditService.recordEvent.mock.calls.at(-1)![0];
      expect(remarks).toMatch(/Relocating/);
      expect(remarks).toMatch(/exit date recorded as/);
      expect(remarks).toMatch(/3 client empanelments closed/);
    });

    it('clears a departure date that has already passed when somebody comes back', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(working({
        lifecycleStatus: AssayerLifecycleStatus.INACTIVE, status: 'INACTIVE', exitDate: '2025-11-30',
      }));

      const saved = await service.activateAssayer('as-1', 'u-1', 'Rejoined');

      expect(saved.exitDate).toBeNull();
      expect(saved.status).toBe('ACTIVE');
    });

    /** A notice period is coherent for a working person; clearing it would erase a leaving date
     *  somebody entered on purpose. */
    it('leaves a leaving date still ahead of today alone', async () => {
      const notice = daysFromNow(30);
      mockAssayerRepo.findOne.mockResolvedValue(working({
        lifecycleStatus: AssayerLifecycleStatus.ON_LEAVE, status: 'INACTIVE', exitDate: notice,
      }));

      const saved = await service.activateAssayer('as-1', 'u-1', 'Back from leave');

      expect(saved.exitDate).toBe(notice);
    });

    /**
     * The door out is automatic; the door back in is not. Putting somebody onto a bank's
     * empanelment list is that bank's decision, never a side effect of an HR screen — so a
     * reinstatement goes through the vetting screen and a person.
     */
    it('never reopens a client empanelment on the way back', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(working({
        lifecycleStatus: AssayerLifecycleStatus.INACTIVE, status: 'INACTIVE', exitDate: '2025-11-30',
      }));

      await service.activateAssayer('as-1', 'u-1', 'Rejoined');

      const touched = mockDataSource.query.mock.calls
        .some(([sql]) => String(sql).includes('assayer_client_empanelments'));
      expect(touched).toBe(false);
    });
  });

  /**
   * `status` and `lifecycle_status` state one fact, and the planner reads the weaker one: the
   * candidate query filters `status = 'ACTIVE'` while the explanation shown to a human reads
   * `lifecycleStatus`. `AssayerEntity.deriveOperationalStatus` makes `status` a projection on
   * every save, so the remaining way to put the two out of step — and to leave the workforce with
   * none of the bookkeeping above — is the profile form writing the lifecycle directly.
   */
  describe('where somebody stands is not editable from the profile form', () => {
    beforeEach(() => {
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'as-1', displayName: 'X', isActive: true });
      mockAssayerRepo.save.mockImplementation(async (a: any) => a);
    });

    it.each(['status', 'lifecycleStatus'])('refuses %s in an update body', async (field) => {
      await expect(service.update('as-1', { [field]: 'RESIGNED' } as any, 'u-1'))
        .rejects.toThrow(/changed with the lifecycle actions/);
    });

    it('leaves an ordinary edit alone', async () => {
      await expect(service.update('as-1', { phone: '9876543210' }, 'u-1')).resolves.toBeDefined();
    });
  });

  /**
   * The bulk importer writes appraisers through `manager.save(AssayerEntity, …)`, never through
   * this service, so none of the guards above stand between the real 1,155-row roster file and the
   * database — which is what lets a full import still succeed while the file carries the
   * contradictions these guards refuse.
   *
   * Pinned because routing the importer through `create`/`update` would refuse rows part-way and
   * leave a half-loaded roster. That is a decision to take deliberately, having decided what
   * happens to the rows that fail, rather than by moving one call.
   */
  it('does not stand between the bulk roster importer and the database', () => {
    const importer = readFileSync(join(__dirname, 'roster-import.service.ts'), 'utf8');
    expect(importer).not.toMatch(/assayerService\.(create|update)\b/);
  });
});
