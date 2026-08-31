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
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { EventCategory, AssayerLifecycleStatus } from '@fapoms/shared';

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
      ],
    }).compile();
  }

  beforeEach(async () => {
    const module = await setupModule();
    service = module.get<AssayerService>(AssayerService);
    jest.clearAllMocks();
    mockWorkforceRepo.find.mockResolvedValue([]);
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
   * The roster import, as the client's real file exercises it.
   *
   * Reported as "assayer/roster imports are not working", and it was two things at once: the
   * reader only ever looked at sheet 1 of the workbook (the client's file puts Branch first and
   * the roster second), and a phone number was required to admit anyone (the roster has no phone
   * column). Either alone imported zero people.
   */
  describe('uploadFromExcel — the real client roster', () => {
    /** The client's workbook: branch list first, roster second, trailing space in the name. */
    function clientWorkbook(): Buffer {
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([
        ['BRANCH', 'BRANCH_NAME', 'DISTRICT', 'STATE', 'Branch Address', 'Packets'],
        ['BR-1', 'THENKURISSI', 'PALAKKAD', 'Kerala', 'Main Road', 120],
      ]), 'Branch');
      xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([
        ['Assayer Name', 'Assayer code', 'Residence Address', 'Location', 'District', 'State', 'Zone'],
        ['Shinil T', 'AS0643', 'Thykkattu, Kunnamangalam, kerala-673571', 'Kunnamangalam', 'Calicut', 'Kerala', 'South'],
        ['R Jeganathan', 'AS0361', 'Anna Nagar, Chennai-600040', 'Chennai', 'Chennai', 'Tamil Nadu', 'South'],
      ]), 'Assayer ');
      return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    }

    beforeEach(() => {
      // No existing roster: every row is a create.
      mockAssayerRepo.findOne.mockResolvedValue(null);
      mockAssayerRepo.create.mockImplementation((v: any) => v);
      mockAssayerRepo.save.mockImplementation((v: any) => Promise.resolve({ id: `asr-${v.assayerCode}`, ...v }));
    });

    it('reads the roster from the second sheet of the client workbook', async () => {
      const report = await service.uploadFromExcel(clientWorkbook(), 'user-1');

      expect(report.sheetName).toBe('Assayer ');
      expect(report.errors).toEqual([]);
      expect(report.importedCount).toBe(2);
      expect(report.created).toBe(2);
    });

    it('admits people the roster has no phone number for, and names them', async () => {
      const report = await service.uploadFromExcel(clientWorkbook(), 'user-1');

      // Previously every one of these was a rejection: "Phone is required".
      expect(report.needingPhone).toEqual(['AS0643', 'AS0361']);
      expect(report.importedCount).toBe(2);
    });

    it('still refuses a row with no state — it sets the region, zone and holidays', async () => {
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([
        ['Assayer code', 'Assayer Name', 'District', 'State'],
        ['AS-01', 'Has State', 'Calicut', 'Kerala'],
        ['AS-02', 'No State', 'Calicut', ''],
      ]), 'Roster');
      const report = await service.uploadFromExcel(
        Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })), 'user-1',
      );

      expect(report.importedCount).toBe(1);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]).toContain('AS-02');
      expect(report.errors[0]).toContain('State');
    });

    /**
     * Searching every sheet must not weaken the wrong-file guard: a workbook that is only a
     * branch list, uploaded here, still has to be sent to the right screen rather than read
     * as a roster of 72 people named after branches.
     */
    it('still rejects a branch-only workbook as the wrong file', async () => {
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([
        ['BRANCH', 'BRANCH_NAME', 'DISTRICT', 'STATE', 'Branch Address', 'Packets'],
        ['BR-1', 'THENKURISSI', 'PALAKKAD', 'Kerala', 'Main Road', 120],
      ]), 'Branch');
      const report = await service.uploadFromExcel(
        Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })), 'user-1',
      );

      expect(report.importedCount).toBe(0);
      expect(report.errors[0]).toContain('branch list');
      expect(mockAssayerRepo.save).not.toHaveBeenCalled();
    });
  });
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
      // AS-27 was deleted; only AS-26 is still active. The next code must be AS-28.
      mockAssayerRepo.find.mockResolvedValue([
        { assayerCode: 'AS-26' }, { assayerCode: 'AS-27' },
      ]);
      mockAssayerRepo.findOne.mockResolvedValue(null);
      mockAssayerRepo.create.mockImplementation((v: any) => v);
      mockAssayerRepo.save.mockImplementation(async (v: any) => ({ ...v, id: 'as-new' }));

      await service.create(
        { firstName: 'Nita', lastName: 'Rao', state: 'Maharashtra' } as any,
        'user-1',
      );

      expect(mockAssayerRepo.save).toHaveBeenCalledWith(expect.objectContaining({ assayerCode: 'AS-28' }));
    });

    /** The seeded roster uses `AS0688`; reading that as 688 would jump the sequence. */
    it('ignores codes that do not follow the AS-nn shape', async () => {
      mockAssayerRepo.find.mockResolvedValue([{ assayerCode: 'AS0688' }, { assayerCode: 'AS-03' }]);
      mockAssayerRepo.findOne.mockResolvedValue(null);
      mockAssayerRepo.create.mockImplementation((v: any) => v);
      mockAssayerRepo.save.mockImplementation(async (v: any) => ({ ...v, id: 'as-new' }));

      await service.create(
        { firstName: 'Ravi', lastName: 'Kumar', state: 'Kerala' } as any,
        'user-1',
      );

      expect(mockAssayerRepo.save).toHaveBeenCalledWith(expect.objectContaining({ assayerCode: 'AS-04' }));
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
});
