import { Injectable, NotFoundException, ConflictException, BadRequestException, UnauthorizedException, OnModuleInit, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, In, DataSource, ILike } from 'typeorm';
import * as xlsx from 'xlsx';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { AssayerEntity } from './assayer.entity';
import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from './workforce-attribute.entity';
import { AssayerRemarkEntity } from './assayer-remark.entity';
import { AssayerActivityEntity } from './assayer-activity.entity';
import { AuditService } from '../../core/audit/audit.service';
import { AssayerStateMachine } from './assayer.state-machine';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { EventCategory, AssayerLifecycleStatus, AssayerStatus, AssignmentStatus, SystemRole, resolveRegion, canonicalStateName, canonicalState, ASSAYER_LIFECYCLE_TRANSITIONS, toWorkflowTransitions, AssayerEngagementType, AssayerUnavailableReason } from '@fapoms/shared';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import { geocodeIndia, pincodeAuthority } from '../geo/india-geocoder';
import { parseSheet, rowReader, describeMissingColumn } from '../../core/excel/sheet-reader';
import { resolveCoordinates, needsBetterFix, GeoFields } from '../geo/coordinate-resolution';

/**
 * Resolves an assayer's home coordinates using ONLY the shared Google geocoder.
 * Returns null when nothing resolves (no key, error, or no sane in-state hit) —
 * the caller must treat that as "unknown" rather than inventing a location.
 */
async function geocodeAddress(
  address: string,
  city: string,
  district: string,
  state: string,
  pincode?: string | null,
): Promise<{ lat: number; lng: number; accuracyMeters: number } | null> {
  return geocodeIndia(address, city, district, state, pincode);
}

/**
 * Returns the authoritative state and district a 6-digit Indian pincode belongs
 * to, asking the same Google geocoder the coordinates come from (so the
 * validation and the pin always agree). Used to stop the classic silent
 * mistake: an address that says one place while state/district/city/pincode say
 * another.
 *
 * Returns null when the pincode can't be verified — the caller must then skip
 * the check rather than invent one.
 */
async function fetchPincodeAuthority(
  pincode: string,
): Promise<{ state: string; district: string } | null> {
  return pincodeAuthority(pincode);
}

/** Loose comparer for place names: case/space/punctuation-insensitive and blind
 * to the common "Urban"/"Rural"/"District"/"City" suffixes so "Bengaluru Urban"
 * and "Bengaluru" compare equal. */
function normalizePlace(s?: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/\b(urban|rural|district|city|metro)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Enforces that an assayer's state, district and pincode all describe the same
 * place, using the pincode as the anchor of truth. A mixed entry — a Bengaluru
 * pincode with "Karnataka" in the state field but a Delhi district, or a Delhi
 * address tagged as Karnataka — produces a clear, actionable error instead of a
 * silently wrong map pin.
 */
async function assertAddressConsistent(dto: {
  address?: string;
  city?: string;
  district?: string;
  state?: string;
  pincode?: string | null;
}): Promise<void> {
  /**
   * The state has to be a real one, with or without a pincode to cross-check it against.
   *
   * Nothing checked this on any path — the form, the API and the Excel import all accepted
   * "Freedonia" — and the consequences are quiet rather than loud: `region` is derived from the
   * state, so an unreal one leaves it null, and a null region drops the assayer out of every
   * region-scoped view and out of the territory rules that match on state. They stay on the
   * roster looking ordinary while being unplannable.
   *
   * Checked before the pincode anchor below, which returns early when no pincode was supplied —
   * which is exactly how an imported row with a bogus state got through.
   */
  if (dto.state?.trim()) {
    // Both spellings are accepted, because both turn up in real rosters: `canonicalStateName`
    // reads full names and run-together variants ("ANDRAPRADESH"), while `canonicalState` also
    // resolves the two-letter codes ("MH", "TN"). Chained rather than reimplemented — a third
    // list of state names is exactly how the first two drifted apart.
    const known = canonicalStateName(dto.state) ?? canonicalStateName(canonicalState(dto.state));
    if (!known) {
      throw new BadRequestException(
        `"${dto.state}" is not a state we recognise. It sets this assayer's region, zone and ` +
        'holiday calendar, so it has to match a real state or union territory.',
      );
    }
  }

  const pin = dto.pincode || (dto.address || '').match(/\b\d{6}\b/)?.[0] || '';
  if (!/^\d{6}$/.test(pin)) return; // no pincode to anchor on — nothing further to verify
  const authority = await fetchPincodeAuthority(pin);
  if (!authority) return; // couldn't verify — skip rather than block on a guess

  const where = `${dto.state ?? 'unknown state'}, ${dto.district ?? 'unknown district'}`;
  if (
    dto.state &&
    authority.state &&
    normalizePlace(dto.state) !== normalizePlace(authority.state)
  ) {
    throw new BadRequestException(
      `Pincode ${pin} is in ${authority.state}, but the entered state is "${dto.state}". ` +
        `State, district, city, address and pincode must all describe the same place (got ${where}).`,
    );
  }
  if (
    dto.district &&
    authority.district &&
    normalizePlace(dto.district) !== normalizePlace(authority.district)
  ) {
    throw new BadRequestException(
      `Pincode ${pin} is in ${authority.district} district (${authority.state}), but the entered district is "${dto.district}". ` +
        `State, district, city, address and pincode must all describe the same place (got ${where}).`,
    );
  }
}


/**
 * What a roster upload actually did.
 *
 * A bare `{ importedCount, errors }` could not distinguish the outcomes an operator needs to tell
 * apart: 25 new people vs 25 rows that overwrote the existing roster, and "imported" vs "imported
 * but unreachable". `sheetName` matters because the importer now searches every sheet in the
 * workbook — the operator should be able to see it read the one they meant.
 */
export interface AssayerUploadReport {
  /** Rows that produced a record, whether created or updated. */
  importedCount: number;
  created: number;
  updated: number;
  /** Data rows found in the chosen sheet, so `totalRows - importedCount` is what did not land. */
  totalRows: number;
  /** Which sheet of the workbook was read. */
  sheetName: string;
  /**
   * Assayer codes whose *record* has no phone number after the import — reachable in the app,
   * not by phone. Read from the saved record rather than the sheet, so re-importing a
   * phone-less roster over people who already have numbers does not report them as unreachable.
   */
  needingPhone: string[];
  errors: string[];
}

export interface CreateAssayerDto {
  /** Omit to have the server allocate the next free code. */
  assayerCode?: string;
  employeeId?: string;
  employeeCode?: string;
  firstName: string;
  lastName: string;
  email?: string;
  /**
   * Optional on admission. Rosters arrive without a phone column; a missing number blocks ringing
   * this assayer (Call & Assign, phone-channel dispatch), not recording them. See the column
   * comment on AssayerEntity.phone for why this is not the login identifier it was taken to be.
   */
  phone?: string;
  alternatePhone?: string;
  address?: string;
  /** The one geography field that stays mandatory: it drives region, zone and holidays. */
  state: string;
  district?: string;
  city?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  organizationId?: string;
  panNumber?: string;
  bankAccountNumber?: string;
  ifscCode?: string;
  notes?: string;
  employmentType?: string;
  joiningDate?: string;
  managerId?: string;
  department?: string;
  region?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelation?: string;
  photograph?: string;
  skills?: string[];
  certifications?: { name: string; expiryDate: string }[];
  languages?: string[];
  preferredRegions?: string[];
  specializations?: string[];
  experienceYears?: number;
  performanceRating?: number;
  leaves?: { startDate: string; endDate: string }[];
  workingHours?: { start: string; end: string };
  maxDailyWorkload?: number;
  maxWeeklyWorkload?: number;
  eligibleClients?: string[];

  /**
   * Facts the appraiser roster carries. They arrived through the importer, which writes the
   * entity directly, so the record could be read but not corrected: an operator opening somebody
   * imported from the spreadsheet saw a date of birth and a qualification with no field to
   * change either.
   *
   * `engagementType` and `unavailableReason` are the two halves of the roster's
   * "Active / Inactive" column, which held an availability, a reason and an engagement type in
   * one cell.
   */
  aadhaarNumber?: string;
  bankName?: string;
  dateOfBirth?: string;
  qualification?: string;
  vstsCode?: string;
  hrOwnerName?: string;
  engagementType?: AssayerEngagementType;
  unavailableReason?: AssayerUnavailableReason;
}

export interface UpdateAssayerDto {
  /**
   * `organizationId` is deliberately absent.
   *
   * Which organisation an assayer belongs to is tenancy, taken from the authenticated principal
   * at create time — see `create()`, which receives it as an argument rather than from the body.
   * Accepting it on update would let a caller move somebody else's assayer into their own
   * organisation. The request DTO has always omitted it; the parity spec would have had somebody
   * "fix" that by adding it, so it says so here.
   */
  employeeId?: string;
  employeeCode?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  alternatePhone?: string;
  address?: string;
  state?: string;
  district?: string;
  city?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  panNumber?: string;
  bankAccountNumber?: string;
  ifscCode?: string;
  notes?: string;
  employmentType?: string;
  joiningDate?: string;
  exitDate?: string;
  terminationDate?: string;
  managerId?: string;
  department?: string;
  region?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelation?: string;
  photograph?: string;
  skills?: string[];
  certifications?: { name: string; expiryDate: string }[];
  languages?: string[];
  preferredRegions?: string[];
  specializations?: string[];
  experienceYears?: number;
  performanceRating?: number;
  leaves?: { startDate: string; endDate: string }[];
  workingHours?: { start: string; end: string };
  maxDailyWorkload?: number;
  maxWeeklyWorkload?: number;
  eligibleClients?: string[];
  /**
   * Facts the appraiser roster carries. They arrived through the importer, which writes the
   * entity directly, so an operator opening somebody imported from the spreadsheet saw a date of
   * birth and a qualification with no field to change either.
   */
  aadhaarNumber?: string;
  bankName?: string;
  dateOfBirth?: string;
  qualification?: string;
  vstsCode?: string;
  hrOwnerName?: string;
  engagementType?: AssayerEngagementType;
  unavailableReason?: AssayerUnavailableReason;
}

@Injectable()
export class AssayerService implements OnModuleInit {
  private readonly logger = new Logger(AssayerService.name);
  constructor(
    @InjectRepository(AssayerEntity)
    private readonly assayerRepository: Repository<AssayerEntity>,
    @InjectRepository(AssayerCommercialProfileEntity)
    private readonly commercialRepository: Repository<AssayerCommercialProfileEntity>,
    @InjectRepository(WorkforceAttributeEntity)
    private readonly workforceAttributeRepository: Repository<WorkforceAttributeEntity>,
    @InjectRepository(AssayerRemarkEntity)
    private readonly remarkRepository: Repository<AssayerRemarkEntity>,
    @InjectRepository(AssayerActivityEntity)
    private readonly activityRepository: Repository<AssayerActivityEntity>,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly workflowEngine: WorkflowEngine,
    private readonly notificationDispatch: NotificationDispatchService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  onModuleInit() {
    // Derived from the one table, not typed out again. The engine gates
    // `executeCommand` before the state machine runs, so a hand-written copy here
    // silently outranks the real rules wherever the two drift apart.
    this.workflowEngine.registerWorkflow('assayer', toWorkflowTransitions(ASSAYER_LIFECYCLE_TRANSITIONS));
  }

  async hydrateWorkforceAttributes(assayer: AssayerEntity): Promise<AssayerEntity> {
    const attrs = await this.workforceAttributeRepository.find({
      where: { assayerId: assayer.id, isActive: true },
    });
    (assayer as any).skills = attrs.filter(a => a.type === 'SKILL').map(a => a.name);
    (assayer as any).certifications = attrs.filter(a => a.type === 'CERTIFICATION').map(a => ({
      name: a.name,
      expiryDate: a.expiryDate ? a.expiryDate.toISOString().split('T')[0] : null,
    }));
    (assayer as any).languages = attrs.filter(a => a.type === 'LANGUAGE').map(a => a.name);
    (assayer as any).specializations = attrs.filter(a => a.type === 'SPECIALIZATION').map(a => a.name);
    return assayer;
  }

  async hydrateAllWorkforceAttributes(assayers: AssayerEntity[]): Promise<void> {
    if (assayers.length === 0) return;
    const allAttrs = await this.workforceAttributeRepository.find({
      where: { assayerId: In(assayers.map(a => a.id)), isActive: true },
    });
    const attrsMap = new Map<string, WorkforceAttributeEntity[]>();
    for (const attr of allAttrs) {
      if (!attrsMap.has(attr.assayerId)) attrsMap.set(attr.assayerId, []);
      attrsMap.get(attr.assayerId)!.push(attr);
    }
    for (const assayer of assayers) {
      const attrs = attrsMap.get(assayer.id) || [];
      (assayer as any).skills = attrs.filter(a => a.type === 'SKILL').map(a => a.name);
      (assayer as any).certifications = attrs.filter(a => a.type === 'CERTIFICATION').map(a => ({
        name: a.name,
        expiryDate: a.expiryDate ? a.expiryDate.toISOString().split('T')[0] : null,
      }));
      (assayer as any).languages = attrs.filter(a => a.type === 'LANGUAGE').map(a => a.name);
      (assayer as any).specializations = attrs.filter(a => a.type === 'SPECIALIZATION').map(a => a.name);
    }
  }

  /**
   * Every distinct capability name already recorded across the roster, by kind.
   *
   * The picker on the capability screen is built from this rather than a hardcoded list, so it
   * offers the vocabulary this workforce actually uses — and a name typed once is offered to
   * everyone afterwards, which is what stops "Gold Assaying" and "Gold assaying" becoming two
   * different skills that the eligibility filter treats as unrelated.
   *
   * ## The `COUNT(DISTINCT)` stays, and is index-backed
   *
   * This is the least-protected of the endpoints that aggregate `workforce_attributes`: the HR
   * capability page fetches it from a bare `useEffect([])` with no react-query wrapper, so there
   * is no client cache, no dedupe and no server-side `CacheService.wrap` — every visit to
   * /hr/capability runs it, and the page unmounts on tab change. It is also unbounded: no LIMIT,
   * a full aggregate over every active attribute row.
   *
   * Measured on a copy of the 200k fixture with the HR tables filled to match its 5,038-assayer
   * roster (40,405 attribute rows), warm, five runs: 75.6 ms, of which ~70 ms was a sort of all
   * 40k rows by `(type, name, assayer_id)` — a `DISTINCT` aggregate cannot be hash-aggregated, so
   * the planner must sort, and these are collated `varchar`s. `1791000000000-WorkforceVocabularyIndex`
   * supplies that exact order as a partial index, and the same unchanged SQL now runs in 5.3 ms.
   *
   * Two things were tried and rejected. Pre-aggregating into a `SELECT DISTINCT` subquery so the
   * planner can hash reaches only 26.4 ms, and once the index exists it is worse than doing
   * nothing (21.1 ms vs 5.3 ms) because it reverts to a sequential scan. And `COUNT(*)` is not a
   * legal substitute for `COUNT(DISTINCT …)` here: nothing in the schema or the write path stops
   * one assayer holding the same `(type, name)` twice — there is no unique constraint, and
   * `syncWorkforceAttributes` inserts whatever array the client sends — so the DISTINCT is
   * load-bearing, and dropping it would inflate the counts the picker ranks its suggestions by.
   */
  async getWorkforceAttributeVocabulary(): Promise<Record<string, Array<{ name: string; assayerCount: number }>>> {
    const rows = await this.workforceAttributeRepository
      .createQueryBuilder('a')
      .select('a.type', 'type')
      .addSelect('a.name', 'name')
      .addSelect('COUNT(DISTINCT a.assayerId)', 'assayerCount')
      .where('a.isActive = true')
      .groupBy('a.type')
      .addGroupBy('a.name')
      .orderBy('a.type')
      .addOrderBy('COUNT(DISTINCT a.assayerId)', 'DESC')
      .getRawMany();

    return rows.reduce<Record<string, Array<{ name: string; assayerCount: number }>>>((acc, r) => {
      (acc[r.type] ??= []).push({ name: r.name, assayerCount: Number(r.assayerCount) });
      return acc;
    }, {});
  }

  private async syncWorkforceAttributes(assayerId: string, dto: CreateAssayerDto | UpdateAssayerDto, userId: string): Promise<void> {
    const FIELD_TO_TYPE = {
      skills: 'SKILL',
      certifications: 'CERTIFICATION',
      languages: 'LANGUAGE',
      specializations: 'SPECIALIZATION',
    } as const;

    /**
     * Replace only the kinds of attribute the caller actually sent.
     *
     * This used to delete all four types whenever any one of them was present, then re-insert
     * just the ones supplied. Saving an assayer's skills therefore erased their certifications,
     * languages and specializations — including certification expiry dates, which the
     * eligibility gate reads. A partial update is the normal shape for an edit form, so this
     * was data loss waiting for the first screen that offered one field without the others.
     */
    const providedTypes = (Object.keys(FIELD_TO_TYPE) as Array<keyof typeof FIELD_TO_TYPE>)
      .filter((f) => (dto as any)[f] !== undefined)
      .map((f) => FIELD_TO_TYPE[f]);

    if (providedTypes.length === 0) return;

    await this.workforceAttributeRepository.delete({
      assayerId,
      type: In(providedTypes),
    });

    const newAttrs: Partial<WorkforceAttributeEntity>[] = [];
    if (dto.skills) {
      for (const skill of dto.skills) {
        newAttrs.push({ assayerId, type: 'SKILL', name: skill, createdBy: userId, updatedBy: userId });
      }
    }
    if (dto.certifications) {
      for (const cert of dto.certifications) {
        newAttrs.push({
          assayerId, type: 'CERTIFICATION', name: cert.name,
          expiryDate: cert.expiryDate ? new Date(cert.expiryDate) : null,
          createdBy: userId, updatedBy: userId,
        });
      }
    }
    if (dto.languages) {
      for (const lang of dto.languages) {
        newAttrs.push({ assayerId, type: 'LANGUAGE', name: lang, createdBy: userId, updatedBy: userId });
      }
    }
    if (dto.specializations) {
      for (const spec of dto.specializations) {
        newAttrs.push({ assayerId, type: 'SPECIALIZATION', name: spec, createdBy: userId, updatedBy: userId });
      }
    }
    if (newAttrs.length > 0) {
      await this.workforceAttributeRepository.save(newAttrs as any[]);
    }
  }

  async findAll(
    page = 1,
    limit = 50,
    scope?: Partial<GlobalScope>,
  ): Promise<{ assayers: AssayerEntity[]; total: number }> {
    // Only region applies. An assayer has a home region but no client, zone or state of their
    // own in the sense the scope means, and inferring one from their assignment history would
    // hide anyone who has not yet worked for the client the operator happens to be scoped to.
    const where: Record<string, unknown> = { isActive: true };
    if (scope?.regions?.length) where.region = In(scope.regions);

    const [assayers, total] = await this.assayerRepository.findAndCount({
      where,
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });
    await this.hydrateAllWorkforceAttributes(assayers);
    return { assayers, total };
  }

  async findOne(id: string): Promise<AssayerEntity> {
    const assayer = await this.assayerRepository.findOne({ where: { id, isActive: true } });
    if (!assayer) throw new NotFoundException(`Assayer ${id} not found.`);
    await this.hydrateWorkforceAttributes(assayer);
    return assayer;
  }

  /**
   * The next free `AS-nn` code, considering every assayer that has ever existed.
   *
   * Codes are permanent identifiers: a deleted assayer keeps hers, and her payables, assignments
   * and audit trail still refer to it, so the number must never be handed out again. The scan
   * therefore ignores `isActive` — the one place in this service that deliberately does.
   *
   * Codes that do not follow this shape are skipped rather than parsed: the seeded roster uses
   * `AS0688`, and reading that as 688 would jump the sequence into the hundreds on first use.
   */
  private async allocateAssayerCode(): Promise<string> {
    const rows = await this.assayerRepository.find({ select: ['assayerCode'], withDeleted: true } as any);
    const highest = rows.reduce((max, r) => {
      const m = /^AS-(\d+)$/.exec(r.assayerCode ?? '');
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    return `AS-${String(highest + 1).padStart(2, '0')}`;
  }

  async create(dto: CreateAssayerDto, userId: string, organizationId?: string | null): Promise<AssayerEntity> {
    const assayerCode = dto.assayerCode?.trim() || (await this.allocateAssayerCode());
    dto = { ...dto, assayerCode };

    const existing = await this.assayerRepository.findOne({ where: { assayerCode } });
    if (existing) throw new ConflictException(`Assayer code ${assayerCode} already exists.`);

    await assertAddressConsistent(dto);

    /**
     * Resolved through the shared chain, so an assayer's home is placed by the same rules — and
     * carries the same precision record — as a branch. That symmetry is the point: the
     * conflict-of-interest floor and the serviceability radius are distances *between* the two,
     * and a comparison between a 10 m pin and a 100 km centroid is not a distance.
     *
     * Never falls back to a hardcoded coordinate. That is worse than no location: the assayer
     * appears on the map somewhere they have never been, and every distance filter silently
     * uses the fiction. An unknown location is visible and fixable; a plausible wrong one is
     * neither — which is exactly what `geoAccuracyMeters` now makes legible.
     */
    const geo = await resolveCoordinates({
      address: dto.address,
      city: dto.city,
      district: dto.district,
      state: dto.state,
      pincode: dto.pincode,
      suppliedLat: dto.latitude,
      suppliedLng: dto.longitude,
      suppliedIsManual: dto.latitude != null && dto.longitude != null,
    });
    if (geo && needsBetterFix(geo.geoSource, geo.geoAccuracyMeters)) {
      this.logger.warn(
        `Assayer ${dto.assayerCode}: could only place them to ±${geo.geoAccuracyMeters}m ` +
        `(${geo.geoSource}) from "${dto.address}" (${dto.city}, ${dto.district}, ${dto.state}). ` +
        `Distance-based matching will be unreliable until someone pins them precisely.`,
      );
    }

    const geoFields: Partial<GeoFields> = geo ?? {};
    const assayer = this.assayerRepository.create({
      ...dto,
      ...geoFields,
      // Address, city and district became optional on admission but remain NOT NULL columns, and
      // spreading an absent one would insert NULL and fail. Empty is the same thing the branch
      // importer stores for an unknown field, and `missingCriticalFields` reads blank as missing —
      // so the gap still surfaces on the record instead of being hidden behind a constraint error.
      address: dto.address ?? '',
      city: dto.city ?? '',
      district: dto.district ?? '',
      phone: dto.phone || null,
      // Canonicalised from the state, exactly as branches are. Left to the caller this column
      // arrives null (the seed never sets it) or as a free-text zone name from an Excel import,
      // and either way `region IN ('WEST')` matches nobody — a region-scoped operator would
      // open the map, the roster and the capacity tile and find their workforce empty.
      region: resolveRegion(dto.region) ?? resolveRegion(dto.state) ?? null,
      joiningDate: dto.joiningDate ? new Date(dto.joiningDate) : null,
      displayName: `${dto.firstName} ${dto.lastName}`,
      lifecycleStatus: AssayerLifecycleStatus.INVITED,
      status: AssayerStatus.INACTIVE,
      organizationId: organizationId ?? null,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.assayerRepository.save(assayer);
    await this.syncWorkforceAttributes(saved.id, dto, userId);
    await this.recordActivity(saved.id, 'ASSAYER_CREATED', null, AssayerLifecycleStatus.INVITED, userId, 'Assayer profile created');
    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_CREATED',
      entityType: 'ASSAYER',
      entityId: saved.id,
      userId,
      remarks: `Created assayer profile: ${saved.displayName} (${saved.assayerCode})`,
    });
    await this.eventPublisher.publish('assayer:created', {
      eventType: 'assayer:created',
      aggregateId: saved.id,
      userId,
      organizationId: saved.organizationId,
      payload: { id: saved.id, displayName: saved.displayName, assayerCode: saved.assayerCode },
    });
    await this.hydrateWorkforceAttributes(saved);
    return saved;
  }

  async update(id: string, dto: UpdateAssayerDto, userId: string): Promise<AssayerEntity> {
    const assayer = await this.findOne(id);
    const orig = {
      address: assayer.address,
      city: assayer.city,
      district: assayer.district,
      state: assayer.state,
      pincode: assayer.pincode,
    };
    /**
     * What an emptied box means, decided here rather than in every client.
     *
     * A form sends `''` for a field the operator cleared. Whether that is storable depends on
     * the column, and only this side knows: `manager_id` is a uuid and `''` is not a uuid;
     * `employee_id` is unique, so two records cleared to `''` collide on the second one; while
     * `address`, `city`, `district` and `employment_type` are NOT NULL and `''` is exactly
     * right for them. Every one of those was a raw 500 with a Postgres message in it.
     *
     * So the schema answers the question: a cleared value becomes null where the column allows
     * null, and stays an empty string where it does not. The client sends `''` and stops
     * needing to carry a copy of the table definition.
     */
    const columns = this.assayerRepository.metadata;
    Object.keys(dto).forEach((key) => {
      const incoming = (dto as any)[key];
      if (incoming === undefined) return;
      const column = columns.findColumnWithPropertyName(key);

      if (incoming === null && column && !column.isNullable) {
        throw new BadRequestException(
          `${key} cannot be emptied — every assayer must have one.`,
        );
      }
      (assayer as any)[key] = incoming === '' && column?.isNullable ? null : incoming;
    });
    if (dto.firstName || dto.lastName) {
      assayer.displayName = `${dto.firstName ?? assayer.firstName} ${dto.lastName ?? assayer.lastName}`;
    }
    // Region follows the state unless named explicitly, and is canonicalised either way —
    // the same rule create() applies, so an edit cannot un-canonicalise the column.
    if (dto.region !== undefined) {
      assayer.region = resolveRegion(dto.region) ?? resolveRegion(assayer.state) ?? null;
    } else if (dto.state !== undefined) {
      assayer.region = resolveRegion(dto.state) ?? assayer.region;
    }
    if (dto.joiningDate) assayer.joiningDate = new Date(dto.joiningDate);
    if (dto.exitDate) assayer.exitDate = new Date(dto.exitDate);
    if (dto.terminationDate) assayer.terminationDate = new Date(dto.terminationDate);
    const addressChanged = dto.address !== undefined && dto.address !== orig.address;
    const cityChanged = dto.city !== undefined && dto.city !== orig.city;
    const districtChanged = dto.district !== undefined && dto.district !== orig.district;
    const stateChanged = dto.state !== undefined && dto.state !== orig.state;

    if (addressChanged || cityChanged || districtChanged || stateChanged) {
      await assertAddressConsistent({
        address: dto.address ?? orig.address,
        city: dto.city ?? orig.city,
        district: dto.district ?? orig.district,
        state: dto.state ?? orig.state,
        pincode: dto.pincode ?? orig.pincode,
      });
    }

    const coordsSupplied = dto.latitude !== undefined && dto.longitude !== undefined;
    if (addressChanged || cityChanged || districtChanged || stateChanged || coordsSupplied) {
      // Returns null when this assayer's home was pinned by hand — see resolveCoordinates.
      const geo = await resolveCoordinates(
        {
          address: dto.address ?? orig.address,
          city: dto.city ?? orig.city,
          district: dto.district ?? orig.district,
          state: dto.state ?? orig.state,
          pincode: dto.pincode ?? orig.pincode,
          suppliedLat: dto.latitude,
          suppliedLng: dto.longitude,
          suppliedIsManual: coordsSupplied,
        },
        assayer,
      );
      if (geo) {
        Object.assign(assayer, geo);
        this.logger.log(
          `Assayer ${assayer.assayerCode}: re-pinned at ±${geo.geoAccuracyMeters}m (${geo.geoSource})`,
        );
      }
    }

    assayer.updatedBy = userId;
    const saved = await this.assayerRepository.save(assayer);
    await this.syncWorkforceAttributes(saved.id, dto, userId);
    await this.recordActivity(saved.id, 'ASSAYER_UPDATED', null, null, userId, 'Profile updated');
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_UPDATED',
      entityType: 'ASSAYER',
      entityId: saved.id,
      userId,
      remarks: `Updated assayer profile: ${saved.displayName}`,
    });
    await this.eventPublisher.publish('assayer:updated', {
      eventType: 'assayer:updated',
      aggregateId: saved.id,
      userId,
      organizationId: saved.organizationId,
      payload: { id: saved.id, displayName: saved.displayName },
    });
    await this.hydrateWorkforceAttributes(saved);
    return saved;
  }

  /**
   * Records the assayer's live position WITHOUT touching their home address
   * (`latitude`/`longitude`). Live coordinates only feed the recommendation
   * engine when the assayer has also opted in (`isLiveEnabled === true`).
   */
  async updateLiveLocation(id: string, latitude: number, longitude: number, userId?: string): Promise<AssayerEntity> {
    // Existence check only — the row itself is updated by column below, never written back
    // wholesale.
    await this.findOne(id);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new BadRequestException('Invalid live coordinates');
    }
    /**
     * A targeted column update, not a whole-entity save.
     *
     * This previously loaded the full assayer and called `save()`, which writes back every
     * column from the in-memory copy. Live position is reported continuously while an
     * assayer is in the field (one row here reached version 53), so any column changed by
     * something else between the read and the write was silently reverted to its stale
     * value. That included security state: a forced-password-change flag, a lockout, or a
     * failed-attempt counter set while the worker's phone was reporting its position would
     * simply disappear. Observed in practice — a `must_change_password` flag set by the
     * rotation script was cleared moments later by a location ping.
     */
    await this.assayerRepository.update(id, {
      liveLatitude: latitude,
      liveLongitude: longitude,
      liveLocation: { type: 'Point', coordinates: [longitude, latitude] } as any,
      updatedBy: userId ?? id,
    });

    return this.findOne(id);
  }

  /**
   * Turns live sharing on/off for an assayer. Off by default; turning it off
   * keeps any last live coordinate but the engine no longer uses it.
   */
  /**
   * Assignment states in which an assayer is actively holding work: they have committed to a job
   * and have not finished it. COMPLETED is excluded on purpose — the obligation ends with the job.
   */
  private static readonly HOLDS_ACTIVE_WORK: AssignmentStatus[] = [
    AssignmentStatus.ACCEPTED,
    AssignmentStatus.CHECKED_IN,
    AssignmentStatus.IN_PROGRESS,
  ];

  /** Does this assayer currently hold work they have accepted and not yet completed? */
  async hasActiveAssignment(assayerId: string): Promise<boolean> {
    const [row] = await this.dataSource.query(
      `SELECT 1 FROM assignments
        WHERE assayer_id = $1 AND is_active = true AND status::text = ANY($2)
        LIMIT 1`,
      [assayerId, AssayerService.HOLDS_ACTIVE_WORK.map(String)],
    );
    return Boolean(row);
  }

  /**
   * Turn live sharing on or off.
   *
   * **Sharing cannot be switched off while the assayer holds accepted work.** The movement trail is
   * what a travel allowance is checked against, and a control someone can simply disable for the
   * journey they are about to claim for is not a control at all.
   *
   * The obligation is deliberately scoped to the job and no further. Between assignments — evenings,
   * days off, leave — an assayer turns it off like any other setting, and nothing here follows them
   * around. That boundary is the difference between verifying work and surveilling a person, and it
   * is why this checks for active work rather than simply pinning the flag on.
   *
   * `actorIsStaff` bypasses the restriction and exists for system-initiated changes — today only
   * `enableLiveTrackingForActiveWork`, which turns sharing *on*. The HTTP route is self-only (it
   * refuses when the caller is not the assayer), so there is currently no way for anyone else to
   * switch someone's sharing off; if that is ever wanted for a lost handset, this is the seam.
   * Every change is audited either way.
   */
  async setLiveTracking(
    id: string,
    enabled: boolean,
    userId?: string,
    opts: { actorIsStaff?: boolean } = {},
  ): Promise<AssayerEntity> {
    const before = await this.findOne(id); // existence check

    if (!enabled && !opts.actorIsStaff && (await this.hasActiveAssignment(id))) {
      throw new BadRequestException(
        'Location sharing has to stay on while you are on an assignment — it is what confirms your ' +
          'travel when you claim for it. You can switch it off once the job is completed.',
      );
    }

    // Same reasoning as updateLiveLocation: touch only the column being changed.
    await this.assayerRepository.update(id, {
      isLiveEnabled: !!enabled,
      updatedBy: userId ?? id,
    });

    if (before.isLiveEnabled !== !!enabled) {
      // Recorded because it changes what the movement trail can later establish: a window with
      // sharing off is a gap somebody chose, and a dispute about a travel claim needs to be able
      // to tell that apart from a handset that simply lost signal.
      await this.recordActivity(
        id,
        enabled ? 'LOCATION_SHARING_ENABLED' : 'LOCATION_SHARING_DISABLED',
        String(before.isLiveEnabled),
        String(!!enabled),
        userId ?? id,
        enabled ? 'Live location sharing turned on' : 'Live location sharing turned off',
      );
    }

    return this.findOne(id);
  }

  /**
   * Turn sharing on because the assayer has just taken on work.
   *
   * Called when an offer is accepted. Best-effort and never throws: failing to enable tracking must
   * not be able to fail an acceptance — losing the assignment would be a far worse outcome than a
   * trail that starts late, and the gap is visible in the assessment either way.
   */
  async enableLiveTrackingForActiveWork(assayerId: string, userId?: string): Promise<void> {
    try {
      const assayer = await this.assayerRepository.findOne({ where: { id: assayerId } });
      if (!assayer || assayer.isLiveEnabled) return;
      await this.setLiveTracking(assayerId, true, userId, { actorIsStaff: true });
    } catch (err) {
      this.logger.warn(
        `Could not enable location sharing for assayer ${assayerId} on acceptance: ${(err as Error)?.message}`,
      );
    }
  }

  async remove(id: string, userId: string): Promise<void> {
    const assayer = await this.findOne(id);
    assayer.isActive = false;
    assayer.updatedBy = userId;
    await this.assayerRepository.save(assayer);

    // Deactivate assayer commercial profiles
    await this.dataSource.query(
      `UPDATE assayer_commercial_profiles SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
      [userId, id],
    );

    // Deactivate assayer documents
    await this.dataSource.query(
      `UPDATE assayer_documents SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
      [userId, id],
    );

    // Deactivate assayer government documents
    // Skills, languages and certifications. Missing from this cascade, these outlived the person:
    // the HR compliance queries join `assayers` and read `w.is_active`, so a deleted assayer's
    // certifications kept appearing under "falling due" and their skills kept counting toward
    // capability coverage — HR chasing renewals for someone who no longer exists.
    await this.dataSource.query(
      `UPDATE workforce_attributes SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
      [userId, id],
    );

    await this.dataSource.query(
      `UPDATE assayer_government_documents SET is_active = false, updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
      [userId, id],
    );

    // Deactivate active assignments for this assayer
    await this.dataSource.query(
      `UPDATE assignments SET is_active = false, cancel_reason = 'Assayer profile soft deleted', updated_by = $1 WHERE assayer_id = $2 AND is_active = true`,
      [userId, id],
    );

    /**
     * And the scheduled visits those assignments carry.
     *
     * The cascade stopped at the assignment, so a deleted assayer's schedules stayed active —
     * two of them in this database, both ACCEPTED, both for a profile that no longer exists.
     * A schedule is what the calendar, the day plan and the dispatch view read, so the effect
     * is a deleted person still holding dated slots that operations plans around.
     */
    await this.dataSource.query(
      `UPDATE schedules SET is_active = false, updated_by = $1
        WHERE is_active = true AND assignment_id IN (SELECT id FROM assignments WHERE assayer_id = $2)`,
      [userId, id],
    );

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_DELETED',
      entityType: 'ASSAYER',
      entityId: id,
      userId,
      remarks: `Soft deleted assayer profile ${assayer.displayName} and cascaded deactivation to commercial profiles, documents, and active assignments`,
    });
    await this.eventPublisher.publish('assayer:deleted', {
      eventType: 'assayer:deleted',
      aggregateId: id,
      userId,
      organizationId: assayer.organizationId,
      payload: { id, displayName: assayer.displayName },
    });
  }

  /**
   * Moves that go on someone's employment record and need to say why.
   *
   * Progressing through onboarding is self-explanatory — "Moved to TRAINING" is the whole story.
   * Being suspended, deactivated, resigned or terminated is not: those are the entries that get
   * read back months later, in a dispute or a reference check, and a record that says only
   * "Moved to TERMINATED" cannot answer anything. Same standard already applied to rejecting an
   * assignment and to sending work back for rework.
   */
  private static readonly LIFECYCLE_MOVES_NEEDING_A_REASON = new Set<string>([
    AssayerLifecycleStatus.SUSPENDED,
    AssayerLifecycleStatus.INACTIVE,
    AssayerLifecycleStatus.RESIGNED,
    AssayerLifecycleStatus.TERMINATED,
  ]);

  async transitionLifecycle(id: string, targetStatus: string, userId: string, reason?: string): Promise<AssayerEntity> {
    if (AssayerService.LIFECYCLE_MOVES_NEEDING_A_REASON.has(targetStatus) && !reason?.trim()) {
      throw new BadRequestException(
        `Say why this assayer is being moved to ${targetStatus.toLowerCase().replace(/_/g, ' ')}. ` +
        'This goes on their employment record and is what the decision will be judged on later.',
      );
    }

    if (targetStatus === AssayerLifecycleStatus.DOCUMENT_VERIFICATION) {
      return this.verifyDocuments(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.BACKGROUND_VERIFICATION) {
      return this.initiateBackgroundCheck(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.TRAINING) {
      return this.startTraining(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.ACTIVE) {
      return this.activateAssayer(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.ON_LEAVE) {
      return this.putOnLeave(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.SUSPENDED) {
      return this.suspendAssayer(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.INACTIVE) {
      return this.deactivateAssayer(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.RESIGNED) {
      return this.acceptResignation(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.TERMINATED) {
      return this.terminateAssayer(id, userId, reason);
    } else if (targetStatus === AssayerLifecycleStatus.ARCHIVED) {
      return this.archiveAssayer(id, userId, reason);
    } else {
      throw new BadRequestException(`Invalid target status: ${targetStatus}`);
    }
  }

  /**
   * Move a batch of assayers forward to a single target stage as one operation.
   *
   * Each row is advanced through the allowed state-machine path to the target
   * (e.g. INVITED → DOCUMENT_VERIFICATION → BACKGROUND_VERIFICATION → TRAINING),
   * so a mixed-stage batch can be onboarded together without invalid jumps.
   * Every intermediate step still runs through the normal workflow command,
   * activity log and audit trail. Rows that cannot reach the target are skipped,
   * and per-row errors are isolated so one bad row never aborts the rest.
   */
  async bulkTransitionLifecycle(
    ids: string[],
    targetStatus: string,
    userId: string,
    reason?: string,
  ): Promise<{
    succeeded: { id: string; from: string; to: string }[];
    skipped: { id: string; current: string; reason: string }[];
    failed: { id: string; reason: string }[];
  }> {
    const validTargets = Object.values(AssayerLifecycleStatus);
    if (!validTargets.includes(targetStatus as AssayerLifecycleStatus)) {
      throw new BadRequestException(`Invalid target status: ${targetStatus}`);
    }

    // Doing it to twenty people at once does not make the reason less necessary. This path calls
    // `doTransitionLifecycle` directly, so the check in `transitionLifecycle` never saw it.
    if (AssayerService.LIFECYCLE_MOVES_NEEDING_A_REASON.has(targetStatus) && !reason?.trim()) {
      throw new BadRequestException(
        `Say why these assayers are being moved to ${targetStatus.toLowerCase().replace(/_/g, ' ')}. ` +
        'It goes on each of their employment records.',
      );
    }

    const succeeded: { id: string; from: string; to: string }[] = [];
    const skipped: { id: string; current: string; reason: string }[] = [];
    const failed: { id: string; reason: string }[] = [];

    for (const id of ids) {
      try {
        const assayer = await this.findOne(id);
        const path = AssayerStateMachine.findPathTo(assayer.lifecycleStatus, targetStatus);
        if (path === null) {
          skipped.push({
            id,
            current: assayer.lifecycleStatus,
            reason: `No valid path from ${assayer.lifecycleStatus} to ${targetStatus}`,
          });
          continue;
        }
        const from = assayer.lifecycleStatus;
        for (const step of path) {
          const { saved, event } = await this.doTransitionLifecycle(id, step as AssayerLifecycleStatus, userId, reason);
          if (event) this.eventPublisher.publish(event.constructor.name, event);
          void saved;
        }
        succeeded.push({ id, from, to: targetStatus });
      } catch (e) {
        failed.push({ id, reason: (e as Error).message });
      }
    }

    return { succeeded, skipped, failed };
  }

  private async doTransitionLifecycle(
    id: string,
    targetStatus: AssayerLifecycleStatus,
    userId: string,
    reason?: string,
    role = SystemRole.ADMIN,
  ): Promise<{ saved: AssayerEntity; event: any }> {
    const assayer = await this.findOne(id);
    const currentStatus = assayer.lifecycleStatus;

    let event: any;
    if (targetStatus === AssayerLifecycleStatus.DOCUMENT_VERIFICATION) {
      event = AssayerStateMachine.verifyDocuments(assayer, userId);
    } else if (targetStatus === AssayerLifecycleStatus.BACKGROUND_VERIFICATION) {
      event = AssayerStateMachine.initiateBackgroundCheck(assayer, userId);
    } else if (targetStatus === AssayerLifecycleStatus.TRAINING) {
      event = AssayerStateMachine.startTraining(assayer, userId);
    } else if (targetStatus === AssayerLifecycleStatus.ACTIVE) {
      event = AssayerStateMachine.activate(assayer, userId);
    } else if (targetStatus === AssayerLifecycleStatus.ON_LEAVE) {
      event = AssayerStateMachine.putOnLeave(assayer, userId);
    } else if (targetStatus === AssayerLifecycleStatus.SUSPENDED) {
      event = AssayerStateMachine.suspend(assayer, userId);
    } else if (targetStatus === AssayerLifecycleStatus.INACTIVE) {
      event = AssayerStateMachine.deactivate(assayer, userId);
    } else if (targetStatus === AssayerLifecycleStatus.RESIGNED) {
      event = AssayerStateMachine.acceptResignation(assayer, userId);
    } else if (targetStatus === AssayerLifecycleStatus.TERMINATED) {
      event = AssayerStateMachine.terminate(assayer, userId);
    } else if (targetStatus === AssayerLifecycleStatus.ARCHIVED) {
      event = AssayerStateMachine.archive(assayer, userId);
    } else {
      throw new BadRequestException(`Invalid lifecycle status: ${targetStatus}`);
    }

    return this.workflowEngine.executeCommand(
      'assayer',
      assayer.id,
      `${targetStatus}_Command`,
      currentStatus,
      targetStatus,
      userId,
      role,
      [],
      async () => {
        const saved = await this.assayerRepository.save(assayer);
        await this.recordActivity(saved.id, 'ASSAYER_LIFECYCLE_TRANSITION', currentStatus, targetStatus, userId, reason || null);
        await this.auditService.recordEvent({
          category: EventCategory.WORKFLOW,
          eventType: 'ASSAYER_LIFECYCLE_TRANSITION',
          entityType: 'ASSAYER',
          entityId: saved.id,
          previousState: currentStatus,
          newState: targetStatus,
          userId,
          remarks: reason || `Lifecycle transition: ${currentStatus} → ${targetStatus}`,
        });

        // Only on the crossing into ACTIVE, never on a re-save at ACTIVE. The dedupe key is the
        // assayer alone, so a later ON_LEAVE → ACTIVE return does not re-announce someone who
        // was onboarded months ago — "newly onboarded" is true exactly once per person.
        if (targetStatus === AssayerLifecycleStatus.ACTIVE && currentStatus !== AssayerLifecycleStatus.ACTIVE) {
          this.notificationDispatch.emitSafe({
            type: 'ASSAYER_ONBOARDED',
            entityType: 'ASSAYER',
            entityId: saved.id,
            actorUserId: userId,
            assayerId: saved.id,
            dedupeKey: `ASSAYER_ONBOARDED:${saved.id}`,
            payload: { assayerName: saved.displayName },
          });
        }

        return { saved, event };
      }
    );
  }

  async verifyDocuments(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.DOCUMENT_VERIFICATION, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async initiateBackgroundCheck(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.BACKGROUND_VERIFICATION, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async startTraining(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.TRAINING, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async activateAssayer(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.ACTIVE, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async putOnLeave(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.ON_LEAVE, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async suspendAssayer(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.SUSPENDED, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async deactivateAssayer(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.INACTIVE, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async acceptResignation(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.RESIGNED, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async terminateAssayer(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.TERMINATED, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async archiveAssayer(id: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const { saved, event } = await this.doTransitionLifecycle(id, AssayerLifecycleStatus.ARCHIVED, userId, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  // ---- Stats & Profile ----

  /**
   * The cached `averageRating` on the assayer row, on the 1–5 scale its readers expect.
   *
   * Remarks themselves are written and read through AssayerRemarksService (modules/assayer-remarks);
   * this is the only remark-derived figure that still lives here, because it is a column on the
   * assayer row and is also refreshed from `updateAssayerStats`.
   *
   * Remark ratings are stored −2…+2 (see modules/assayer-remarks and migration
   * AssayerRemarkRatings1791430000000). This used to write the raw average, which was harmless
   * while no screen ever set a rating — the column sat at 0 and every reader hid it — but with the
   * signed scale a single +1 remark came out as "1.0 out of 5", the opposite of what was said.
   * `3 + mean` maps the neutral point to 3.0, all −2 to 1.0 and all +2 to 5.0, which is what the
   * planning modal's colour thresholds (≥4 good, ≥3 fair) and the mobile "out of 5" tile read.
   * Zero remains "nothing rated yet" and is still hidden by every reader's `> 0` guard.
   *
   * Deliberately a plain average over all live rated remarks, not the engine's recency-weighted
   * one: this is a lifetime figure on the profile, the engine's is a "who are they now" score,
   * and the two are labelled differently on screen.
   */
  async recomputeAverageRating(assayerId: string): Promise<void> {
    const result = await this.remarkRepository
      .createQueryBuilder('r')
      .select('AVG(r.rating)', 'avg')
      .where('r.assayerId = :assayerId', { assayerId })
      .andWhere('r.rating IS NOT NULL')
      .andWhere('r.isActive = :isActive', { isActive: true })
      .getRawOne();
    const mean = result?.avg === null || result?.avg === undefined ? null : Number(result.avg);
    const outOfFive = mean === null || !Number.isFinite(mean)
      ? 0
      : parseFloat(Math.max(1, Math.min(5, 3 + mean)).toFixed(2));
    await this.assayerRepository.update(assayerId, { averageRating: outOfFive });
  }

  /**
   * Recompute the derived counters cached on the assayer row.
   *
   * Nine independent reads and two writes. They used to run strictly one after another, each
   * waiting on the previous for no reason — none of them takes an input from another. On the
   * critical path of every assignment transition (accept, reject, cancel, complete), that was a
   * chain of round-trips the operator sat through before their click returned, and it grows with
   * the assayer's history rather than staying constant.
   *
   * Now issued together. Nothing else about the computation changes; the queries and the values
   * they produce are identical.
   */
  async updateAssayerStats(assayerId: string): Promise<void> {
    const mgr = this.assayerRepository.manager;

    // NOTE: 'AUDIT_COMPLETED'/'VALIDATION_COMPLETED'/'CLOSED' are ProjectBranchStatus values,
    // not AssignmentStatus values — they belong only in the pb.status clause. Putting them in
    // a.status IN (...) makes Postgres reject the whole query (invalid enum value for
    // assignments_status_enum), which silently no-ops every call via the caller's catch block.
    const [
      total,
      completedResult,
      cancelled,
      onTimeResult,
      lastAssignment,
    ] = await Promise.all([
      mgr.count('assignments', { where: { assayerId, isActive: true } }),
      mgr.query(
        `SELECT COUNT(*) as cnt FROM assignments a
         LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
         WHERE a.assayer_id = $1 AND a.is_active = true
         AND (a.status = 'COMPLETED' OR pb.status IN ('AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'))`,
        [assayerId],
      ),
      mgr.count('assignments', {
        where: { assayerId, status: AssignmentStatus.CANCELLED, isActive: true },
      }),
      mgr.query(
        `SELECT COUNT(*) as cnt FROM assignments a
         LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
         WHERE a.assayer_id = $1 AND a.is_active = true
         AND (a.status = 'COMPLETED' OR pb.status IN ('AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'))
         AND (a.completion_date IS NULL OR a.scheduled_date IS NULL OR a.completion_date <= a.scheduled_date)`,
        [assayerId],
      ),
      mgr.query(
        `SELECT updated_at FROM assignments a
         WHERE a.assayer_id = $1 AND a.is_active = true
         ORDER BY a.updated_at DESC LIMIT 1`,
        [assayerId],
      ),
    ]);

    const completed = Number(completedResult[0]?.cnt ?? 0);

    // Earnings are deliberately NOT cached here. What an assayer is owed has exactly one answer —
    // `BillingEngineService.assayerTotals` — and a counter that self-heals on read is still a
    // second answer that can be wrong between reads.
    await this.assayerRepository.update(assayerId, {
      totalAssignments: total,
      completedAssignments: completed,
      cancelledAssignments: cancelled,
      onTimeCompletions: Number(onTimeResult[0]?.cnt ?? 0),
      lastAssignmentDate: lastAssignment[0]?.updated_at ?? null,
    });
    await this.recomputeAverageRating(assayerId);
  }

  /**
   * Refresh the cached counters without making the caller wait.
   *
   * These are derived values — assignment counts, earnings, rating — read by roster listings and
   * reports, never by the response of the action that changes them. Awaiting the recompute inside
   * an assignment transition put a fan of queries between the operator's click and its
   * confirmation, for numbers nobody was about to look at. `getProfile` recomputes on read, so a
   * momentarily stale counter self-corrects the instant it matters.
   *
   * Failures are logged, never propagated: statistics must not be able to fail an acceptance.
   */
  scheduleStatsRefresh(assayerId: string): void {
    void this.updateAssayerStats(assayerId).catch((err) =>
      this.logger.warn(`Could not refresh cached stats for assayer ${assayerId}: ${err?.message}`),
    );
  }

  async getProfile(assayerId: string): Promise<AssayerEntity> {
    const isUuid = /^[0-9a-fA-F-]{36}$/.test(assayerId);
    const where: any[] = isUuid
      ? [{ id: assayerId, isActive: true }]
      : [{ assayerCode: assayerId, isActive: true }, { employeeId: assayerId, isActive: true }];
    const assayer = await this.assayerRepository.findOne({ where });
    if (!assayer) throw new NotFoundException(`Assayer ${assayerId} not found.`);

    // Live update stats & ratings from real DB tables
    await this.updateAssayerStats(assayer.id).catch(err => console.error('Failed to update assayer stats in profile:', err));

    // Refetch to get fresh metrics
    const updated = await this.assayerRepository.findOne({ where: { id: assayer.id } });
    const target = updated || assayer;

    await this.hydrateWorkforceAttributes(target);

    const mgr = this.assayerRepository.manager;

    // 1. Query Count raised against this assayer
    const queryRes = await mgr.query(
      `SELECT COUNT(*) as cnt FROM validation_queries vq
       JOIN assignments a ON a.id = vq.assignment_id
       WHERE a.assayer_id = $1 AND vq.is_active = true`,
      [target.id],
    ).catch(() => [{ cnt: 0 }]);
    (target as any).queryCount = Number(queryRes[0]?.cnt ?? 0);

    // 2. Acceptance vs Rejection Rate Breakdown
    const totalOffered = await mgr.count('assignments', { where: { assayerId: target.id, isActive: true } });
    const acceptedCount = await mgr.count('assignments', { where: { assayerId: target.id, status: In([AssignmentStatus.ACCEPTED, AssignmentStatus.COMPLETED]), isActive: true } });
    const rejectedCount = await mgr.count('assignments', { where: { assayerId: target.id, status: AssignmentStatus.REJECTED, isActive: true } });
    
    (target as any).acceptanceRate = totalOffered > 0 ? Math.round((acceptedCount / totalOffered) * 100) : 100;
    (target as any).rejectionRate = totalOffered > 0 ? Math.round((rejectedCount / totalOffered) * 100) : 0;

    // 3. Full Audit History with branch details & fees
    const auditHistory = await mgr.query(
      `SELECT a.id, a.assignment_number, a.status, a.agreed_fee, a.proposed_fee, a.scheduled_date, a.completion_date,
              b.name as branch_name, b.city as branch_city, b.state as branch_state, p.name as project_name
       FROM assignments a
       LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
       LEFT JOIN branches b ON b.id = pb.branch_id
       LEFT JOIN projects p ON p.id = pb.project_id
       WHERE a.assayer_id = $1 AND a.is_active = true
       ORDER BY a.created_at DESC LIMIT 20`,
      [target.id],
    ).catch(() => []);
    (target as any).auditHistory = auditHistory;

    // 4. Attach active commercial profile
    const activeCommercial = await this.getActiveCommercialProfile(target.id, new Date()).catch(() => null);
    (target as any).activeCommercialProfile = activeCommercial;

    return target;
  }

  // ---- Activity Timeline ----

  private async recordActivity(assayerId: string, eventType: string, previousState: string | null, newState: string | null, userId: string, remarks: string | null): Promise<void> {
    const activity = this.activityRepository.create({
      assayerId,
      eventType,
      previousState,
      newState,
      performedBy: userId,
      performedByName: null,
      remarks,
      createdBy: userId,
      updatedBy: userId,
    });
    await this.activityRepository.save(activity);
  }

  async getActivityTimeline(assayerId: string, page = 1, limit = 20): Promise<{ activities: AssayerActivityEntity[]; total: number }> {
    const [activities, total] = await this.activityRepository.findAndCount({
      where: { assayerId },
      order: { occurredAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { activities: await this.withActorNames(activities), total };
  }

  /**
   * Fills in `performedByName`, which is written as null at event time — the audit
   * trail stored only an actor UUID, so every history view rendered "system" no
   * matter who actually made the change. Resolved on read so existing rows gain
   * names too. An actor is a staff user, or an assayer acting on their own record.
   */
  private async withActorNames(activities: AssayerActivityEntity[]): Promise<AssayerActivityEntity[]> {
    const ids = [...new Set(activities.map((a) => a.performedBy).filter(Boolean))] as string[];
    if (ids.length === 0) return activities;

    const names = new Map<string, string>();
    const rows = await this.activityRepository.manager.query(
      `SELECT id, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), ''), username) AS name
         FROM users WHERE id = ANY($1)
       UNION ALL
       SELECT id, display_name AS name FROM assayers WHERE id = ANY($1)`,
      [ids],
    );
    for (const r of rows) names.set(r.id, r.name);

    return activities.map((a) => {
      if (!a.performedByName && a.performedBy && names.has(a.performedBy)) {
        a.performedByName = names.get(a.performedBy)!;
      }
      return a;
    });
  }

  // ---- Commercial Profiles ----

  async createCommercialProfile(assayerId: string, dto: any, userId: string): Promise<AssayerCommercialProfileEntity> {
    await this.findOne(assayerId);
    const profile = this.commercialRepository.create({
      ...dto,
      assayerId,
      effectiveStartDate: new Date(dto.effectiveStartDate),
      effectiveEndDate: dto.effectiveEndDate ? new Date(dto.effectiveEndDate) : null,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.commercialRepository.save(profile) as unknown as AssayerCommercialProfileEntity;
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_COMMERCIAL_PROFILE_CREATED',
      entityType: 'ASSAYER_COMMERCIAL_PROFILE',
      entityId: saved.id,
      userId,
      remarks: `Created commercial profile for assayer ${assayerId} with base fee ₹${dto.baseFee}`,
    });
    await this.recordActivity(assayerId, 'ASSAYER_COMMERCIAL_PROFILE_CREATED', null, null, userId, `Commercial profile created with base fee ₹${dto.baseFee}`);
    return saved;
  }

  async updateCommercialProfile(profileId: string, dto: any, userId: string): Promise<AssayerCommercialProfileEntity> {
    const profile = await this.commercialRepository.findOne({ where: { id: profileId, isActive: true } });
    if (!profile) throw new NotFoundException(`Commercial profile ${profileId} not found.`);
    if (dto.baseFee !== undefined) profile.baseFee = dto.baseFee;
    if (dto.hourlyRate !== undefined) profile.hourlyRate = dto.hourlyRate;
    if (dto.dailyRate !== undefined) profile.dailyRate = dto.dailyRate;
    if (dto.travelReimbursement !== undefined) profile.travelReimbursement = dto.travelReimbursement;
    if (dto.accommodationAllowance !== undefined) profile.accommodationAllowance = dto.accommodationAllowance;
    if (dto.mealAllowance !== undefined) profile.mealAllowance = dto.mealAllowance;
    if (dto.currency !== undefined) profile.currency = dto.currency;
    if (dto.effectiveStartDate !== undefined) profile.effectiveStartDate = new Date(dto.effectiveStartDate);
    if (dto.effectiveEndDate !== undefined) profile.effectiveEndDate = dto.effectiveEndDate ? new Date(dto.effectiveEndDate) : null;
    profile.updatedBy = userId;
    const saved = await this.commercialRepository.save(profile) as unknown as AssayerCommercialProfileEntity;
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_COMMERCIAL_PROFILE_UPDATED',
      entityType: 'ASSAYER_COMMERCIAL_PROFILE',
      entityId: saved.id,
      userId,
      remarks: `Updated commercial profile ${profileId}`,
    });
    await this.recordActivity(profile.assayerId, 'ASSAYER_COMMERCIAL_PROFILE_UPDATED', null, null, userId, `Commercial profile updated`);
    return saved;
  }

  async getCommercialProfiles(assayerId: string): Promise<AssayerCommercialProfileEntity[]> {
    return this.commercialRepository.find({
      where: { assayerId, isActive: true },
      order: { effectiveStartDate: 'DESC' },
    });
  }

  async getActiveCommercialProfile(assayerId: string, date: Date = new Date()): Promise<AssayerCommercialProfileEntity | null> {
    const profiles = await this.commercialRepository.find({
      where: { assayerId, isActive: true, effectiveStartDate: LessThanOrEqual(date) },
      order: { effectiveStartDate: 'DESC' },
    });
    for (const p of profiles) {
      if (!p.effectiveEndDate || p.effectiveEndDate >= date) return p;
    }
    return null;
  }

  /**
   * Every assayer's commercial terms as they stand today, in one query.
   *
   * The pay screen needs the whole roster's rate card at once — to compare terms, and to see
   * who has no active profile and therefore falls back to the client's default fee. Loading it
   * one assayer at a time (the only route that existed) is 26+ round trips for one table.
   *
   * "As they stand today" uses the same rule the fee calculator and the recommendation scorers
   * use: the profile effective on the date, newest start winning. A profile dated in the future
   * is not yet in force and is reported as such rather than as the current rate.
   */
  async getRosterCommercialProfiles(onDate: Date = new Date()):
    Promise<Array<{ assayerId: string; profile: AssayerCommercialProfileEntity | null; hasFutureProfile: boolean }>> {
    const assayers = await this.assayerRepository.find({ where: { isActive: true }, select: { id: true } });
    const all = await this.commercialRepository.find({
      where: { isActive: true },
      order: { effectiveStartDate: 'DESC' },
    });

    const byAssayer = new Map<string, AssayerCommercialProfileEntity[]>();
    for (const p of all) {
      (byAssayer.get(p.assayerId) ?? byAssayer.set(p.assayerId, []).get(p.assayerId)!).push(p);
    }

    return assayers.map((a) => {
      const rows = byAssayer.get(a.id) ?? [];
      const inForce = rows.find((p) => p.effectiveStartDate <= onDate && (!p.effectiveEndDate || p.effectiveEndDate >= onDate)) ?? null;
      const hasFutureProfile = rows.some((p) => p.effectiveStartDate > onDate);
      return { assayerId: a.id, profile: inForce, hasFutureProfile };
    });
  }

  // ---- Workforce Attributes ----

  /**
   * Refuse a skill, language, certification or specialisation the person already holds.
   *
   * Adding the same one twice created two rows. Beyond reading as a mistake on screen, removing
   * it then took the person only halfway: one row went, the other stayed, so an assayer whose
   * skill HR had just deleted still satisfied a SKILL rule and still appeared as a candidate.
   * Matching is case-insensitive because "Gold Assaying" and "gold assaying" are the same skill.
   */
  async addWorkforceAttribute(assayerId: string, dto: any, userId: string): Promise<WorkforceAttributeEntity> {
    await this.findOne(assayerId);

    const existing = await this.workforceAttributeRepository.findOne({
      where: { assayerId, type: dto.type, name: ILike(String(dto.name ?? '').trim()), isActive: true },
    });
    if (existing) {
      throw new ConflictException(
        `This assayer already has the ${String(dto.type).toLowerCase()} “${existing.name}”.`,
      );
    }

    const attr = this.workforceAttributeRepository.create({
      ...dto,
      assayerId,
      expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.workforceAttributeRepository.save(attr) as unknown as WorkforceAttributeEntity;
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'WORKFORCE_ATTRIBUTE_CREATED',
      entityType: 'WORKFORCE_ATTRIBUTE',
      entityId: saved.id,
      userId,
      remarks: `Added ${dto.type} '${dto.name}' to assayer ${assayerId}`,
    });
    await this.recordActivity(assayerId, 'WORKFORCE_ATTRIBUTE_CREATED', null, null, userId, `Added ${dto.type} '${dto.name}'`);
    return saved;
  }

  async updateWorkforceAttribute(attributeId: string, dto: any, userId: string): Promise<WorkforceAttributeEntity> {
    const attr = await this.workforceAttributeRepository.findOne({ where: { id: attributeId, isActive: true } });
    if (!attr) throw new NotFoundException(`Workforce attribute ${attributeId} not found.`);
    if (dto.name !== undefined) attr.name = dto.name;
    if (dto.level !== undefined) attr.level = dto.level;
    if (dto.expiryDate !== undefined) attr.expiryDate = dto.expiryDate ? new Date(dto.expiryDate) : null;
    if (dto.metadata !== undefined) attr.metadata = dto.metadata;
    attr.updatedBy = userId;
    const saved = await this.workforceAttributeRepository.save(attr) as unknown as WorkforceAttributeEntity;
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'WORKFORCE_ATTRIBUTE_UPDATED',
      entityType: 'WORKFORCE_ATTRIBUTE',
      entityId: saved.id,
      userId,
      remarks: `Updated workforce attribute ${attributeId}`,
    });
    await this.recordActivity(attr.assayerId, 'WORKFORCE_ATTRIBUTE_UPDATED', null, null, userId, `Updated workforce attribute '${attr.name}'`);
    return saved;
  }

  async removeWorkforceAttribute(attributeId: string, userId: string): Promise<void> {
    const attr = await this.workforceAttributeRepository.findOne({ where: { id: attributeId, isActive: true } });
    if (!attr) throw new NotFoundException(`Workforce attribute ${attributeId} not found.`);
    attr.isActive = false;
    attr.updatedBy = userId;
    await this.workforceAttributeRepository.save(attr);
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'WORKFORCE_ATTRIBUTE_REMOVED',
      entityType: 'WORKFORCE_ATTRIBUTE',
      entityId: attributeId,
      userId,
      remarks: `Removed workforce attribute '${attr.name}' from assayer ${attr.assayerId}`,
    });
    await this.recordActivity(attr.assayerId, 'WORKFORCE_ATTRIBUTE_REMOVED', null, null, userId, `Removed workforce attribute '${attr.name}'`);
  }

  async getWorkforceAttributes(assayerId: string, type?: string): Promise<WorkforceAttributeEntity[]> {
    const where: any = { assayerId, isActive: true };
    if (type) where.type = type;
    return this.workforceAttributeRepository.find({ where, order: { type: 'ASC', name: 'ASC' } });
  }

  /**
   * Assayer intake template.
   *
   * Headers deliberately match the column names on the rosters actually received
   * ("Assayer code", "Assayer Name", "Residence Address", "Location", "Zone")
   * rather than an idealised internal shape, so a roster can be filled in and sent
   * back without being restructured. The importer accepts both spellings.
   *
   * Only the four fields the record genuinely cannot function without are
   * required. Everything else is optional and can be filled in later — a long
   * mandatory list is what pushes people back to editing the database by hand.
   */
  async generateTemplate(): Promise<Buffer> {
    const headers = [
      // Identity. A row needs a code and a name; the rest of this group is what makes the
      // assayer reachable and costable, and is reported as incomplete rather than refused.
      'Assayer code', 'Assayer Name', 'Phone', 'Residence Address', 'Initial Password',
      // Location / coverage. `State` is required — it decides the region, the zone and the
      // holiday calendar the assayer is planned against, and a row without it is rejected.
      'Location', 'District', 'State', 'Zone', 'Pincode', 'Preferred Regions',
      // Contact
      'Email', 'Alternate Phone',
      // Employment
      'Employment Type', 'Employee ID', 'Department', 'Joining Date',
      // Capability — drives which assayer the engine can match to which branch
      'Skills', 'Certifications', 'Specializations', 'Languages',
      'Experience (Years)', 'Performance Rating',
      'Max Daily Workload', 'Max Weekly Workload',
      'Working Hours Start', 'Working Hours End',
      // Commercial — drives what we owe them and the cost side of every audit
      'Base Fee', 'Daily Rate', 'Hourly Rate',
      'Travel Reimbursement', 'Accommodation Allowance', 'Meal Allowance',
      // Payment
      'PAN Number', 'Bank Account Number', 'IFSC Code',
      // Emergency
      'Emergency Contact Name', 'Emergency Contact Phone', 'Emergency Contact Relation',
    ];

    const ws = xlsx.utils.json_to_sheet([], { header: headers });
    ws['!cols'] = headers.map((h) => ({ wch: h === 'Residence Address' ? 50 : Math.max(16, h.length + 4) }));

    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Assayers');

    const instructions = [
      { Field: 'Assayer code', Required: 'Yes', Description: 'Unique code, e.g. AS0643. Re-importing the same code updates that assayer instead of creating a duplicate.' },
      { Field: 'Assayer Name', Required: 'Yes', Description: 'Full name in one cell, e.g. "Shinil T". Split automatically — the last word is taken as the surname.' },
      { Field: 'Phone', Required: 'No', Description: "The assayer's login identifier AND how dispatch notifications reach them. The row is accepted without one and flagged incomplete — the assayer cannot be called or dispatched to until it is filled in." },
      { Field: 'Residence Address', Required: 'No', Description: 'Full address. Used to compute travel distance to branches; a 6-digit pincode inside this text is picked up automatically. Without it the assayer has no start point, so travel cannot be costed.' },
      { Field: 'Initial Password', Required: 'No', Description: "Password the assayer signs in with. Defaults to 'assayer123' when blank. Only applied when the assayer is first created — re-importing a roster never resets an existing password." },
      { Field: 'Location', Required: 'No', Description: 'Town or locality, e.g. Kunnamangalam. Stored as the city.' },
      { Field: 'District', Required: 'No', Description: 'Used for travel distance and coverage planning.' },
      { Field: 'State', Required: 'Yes', Description: 'Sets the region, the zone and the public-holiday calendar this assayer is planned against. A row without it is rejected.' },
      { Field: 'Zone', Required: 'No', Description: 'Operating zone, e.g. South. Casing is normalised, so "north" and "North" are one zone.' },
      { Field: 'Pincode', Required: 'No', Description: 'Leave blank if already present in the address.' },
      { Field: 'Preferred Regions', Required: 'No', Description: 'Comma-separated. Regions this assayer prefers; improves their match score for branches there.' },
      { Field: 'Email', Required: 'No', Description: 'Used for notifications where available.' },
      { Field: 'Alternate Phone', Required: 'No', Description: 'Secondary contact number.' },
      { Field: 'Employment Type', Required: 'No', Description: 'INTERNAL / EXTERNAL / CONTRACT.' },
      { Field: 'Employee ID', Required: 'No', Description: 'HR identifier, for internal staff.' },
      { Field: 'Department', Required: 'No', Description: 'Department name.' },
      { Field: 'Joining Date', Required: 'No', Description: 'YYYY-MM-DD.' },
      { Field: 'Skills', Required: 'No', Description: 'Comma-separated, e.g. Gold Assaying, Hallmarking. A branch or client that requires a skill will only be matched to assayers who have it — blank means this assayer is excluded from any such work.' },
      { Field: 'Certifications', Required: 'No', Description: 'Semicolon-separated as Name|YYYY-MM-DD, e.g. Certified Gold Assayer|2027-06-01. Expiry is enforced: an expired certification blocks assignment to work requiring it.' },
      { Field: 'Specializations', Required: 'No', Description: 'Comma-separated areas of speciality.' },
      { Field: 'Languages', Required: 'No', Description: 'Comma-separated, e.g. English, Malayalam, Tamil. Used to match assayers to branches where the language matters.' },
      { Field: 'Experience (Years)', Required: 'No', Description: 'Whole number. Feeds the match score.' },
      { Field: 'Performance Rating', Required: 'No', Description: '1.00 – 10.00. Feeds the match score; leave blank to let the system derive it from completed work.' },
      { Field: 'Max Daily Workload', Required: 'No', Description: 'Branches per day. Defaults to 3. The day planner will not exceed this.' },
      { Field: 'Max Weekly Workload', Required: 'No', Description: 'Branches per week. Defaults to 15. Enforced when scheduling.' },
      { Field: 'Working Hours Start', Required: 'No', Description: 'e.g. 09:00. Used to fit branches into a realistic working day.' },
      { Field: 'Working Hours End', Required: 'No', Description: 'e.g. 18:00.' },
      { Field: 'Base Fee', Required: 'No', Description: 'Standard fee per audit for this assayer. Used as the opening offer during negotiation and as the cost side of every audit they perform.' },
      { Field: 'Daily Rate', Required: 'No', Description: 'Day rate where the engagement is priced per day rather than per audit.' },
      { Field: 'Hourly Rate', Required: 'No', Description: 'Hourly rate, where applicable.' },
      { Field: 'Travel Reimbursement', Required: 'No', Description: 'Travel paid per assignment. This is recharged to the client where their contract allows, so leaving it blank understates both cost and recoverable revenue.' },
      { Field: 'Accommodation Allowance', Required: 'No', Description: 'Paid for overnight assignments.' },
      { Field: 'Meal Allowance', Required: 'No', Description: 'Paid per assignment day.' },
      { Field: 'PAN Number', Required: 'No', Description: 'Needed before payment; TDS is withheld against it.' },
      { Field: 'Bank Account Number', Required: 'No', Description: 'Needed to disburse fees.' },
      { Field: 'IFSC Code', Required: 'No', Description: 'Needed to disburse fees.' },
      { Field: 'Emergency Contact Name', Required: 'No', Description: 'Emergency contact person.' },
      { Field: 'Emergency Contact Phone', Required: 'No', Description: 'Emergency contact number.' },
      { Field: 'Emergency Contact Relation', Required: 'No', Description: 'Relationship to the assayer.' },
    ];
    const instrWs = xlsx.utils.json_to_sheet(instructions, { header: ['Field', 'Required', 'Description'] });
    instrWs['!cols'] = [{ wch: 26 }, { wch: 10 }, { wch: 95 }];
    xlsx.utils.book_append_sheet(wb, instrWs, 'Instructions');

    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  }

  async uploadFromExcel(fileBuffer: Buffer, userId: string): Promise<AssayerUploadReport> {
    /**
     * Columns are matched ignoring case, spaces and punctuation — see core/excel/sheet-reader.
     *
     * This used to read `row['Assayer Code'] || row['Assayer code']` exactly, so a roster whose
     * column said `ASSAYER CODE`, `Assayer_Code`, or `Assayer Code ` with a trailing space
     * failed every single row with "Assayer Code is required" — 72 identical lines about a
     * column the operator could see in front of them. Passing the required columns also lets
     * the parser find a header row that is not the first, which is what a client file with a
     * merged title row above the table looks like.
     */
    const sheet = parseSheet(fileBuffer, ['Assayer Code', 'Assayer Name', 'Phone']);
    const rows = sheet.rows;

    const errors: string[] = [];
    let importedCount = 0;
    let createdCount = 0;
    let updatedCount = 0;
    /** Admitted, but not yet reachable by phone — reported so the gap is worked, not discovered. */
    const needingPhone: string[] = [];

    const CODE_ALIASES = ['Assayer Code', 'Assayer code', 'AssayerCode', 'Code', 'Employee Code', 'Emp Code'];

    /**
     * If not one row carries a code, the column is missing — not seventy-two bad rows.
     *
     * Reported once, naming the headers actually found, because the per-row form of this
     * message is unactionable: it tells the operator a column they are looking at is absent and
     * gives them no way to see that the file says something slightly different.
     */
    if (rows.length > 0 && !rows.some((r: Record<string, any>) => rowReader(r)(...CODE_ALIASES))) {
      return {
        importedCount: 0,
        created: 0,
        updated: 0,
        totalRows: rows.length,
        sheetName: sheet.sheetName,
        needingPhone: [],
        errors: [describeMissingColumn('Assayer Code', CODE_ALIASES, sheet, 'assayer-roster')],
      };
    }

    /**
     * Codes already seen in *this* workbook, and the row they came from.
     *
     * Re-importing a code deliberately updates that assayer, which is how a corrected roster is
     * re-uploaded. Two rows carrying the same code inside one file is a different thing: it is a
     * mistake in the file. Applied in order it silently overwrote the earlier row — including
     * blanking fields the earlier row had filled — and reported both as ordinary updates, so
     * nothing on screen said a row had been discarded. Same treatment the branch import gives a
     * repeated branch code.
     */
    const firstRowForCode = new Map<string, number>();

    /**
     * Every assayer this roster might already know about, resolved in one query.
     *
     * This was a `findOne({ where: { assayerCode } })` inside the loop, so a 200-person roster
     * issued 200 queries to answer a question one `In(codes)` answers — the same shape of fault
     * the branch importer had. Read before the loop because none of it depends on what an earlier
     * row did: the duplicate-code guard above means each code is worked at most once, so an
     * assayer this import creates can never also be matched by it.
     *
     * No `isActive` filter, matching the per-row lookup exactly. Re-importing a roster is meant
     * to update the person it names even if their record has been deactivated; filtering here
     * would quietly create a second record for them instead.
     */
    const codesInFile = Array.from(new Set(
      rows.map((r: Record<string, any>) => rowReader(r)(...CODE_ALIASES)).filter(Boolean),
    ));
    const existingAssayers = codesInFile.length
      ? await this.assayerRepository.find({ where: { assayerCode: In(codesInFile) } })
      : [];
    const assayerByCode = new Map(existingAssayers.map((a) => [a.assayerCode, a]));

    /**
     * And their current commercial profiles, for the rows that carry rates.
     *
     * Only assayers who already existed can have one, so this covers every case the per-row
     * `findOne` did: a person this import is creating has no profile by definition, and that path
     * now issues no query at all rather than one that is guaranteed to return nothing.
     *
     * Sorted ascending and written into the map in order, so the last write per assayer is the
     * latest `effectiveStartDate` — the same record `order: { effectiveStartDate: 'DESC' }` with
     * `findOne` picked. The whole preload is best-effort for the same reason the per-row lookup
     * had `.catch(() => null)`: a missing profile must not fail the roster import.
     */
    const activeProfileByAssayerId = new Map<string, AssayerCommercialProfileEntity>();
    if (existingAssayers.length > 0) {
      try {
        const profiles = await this.commercialRepository.find({
          where: { assayerId: In(existingAssayers.map((a) => a.id)), isActive: true },
          order: { effectiveStartDate: 'ASC' },
        });
        for (const profile of profiles) activeProfileByAssayerId.set(profile.assayerId, profile);
      } catch {
        /* best-effort: the import proceeds and simply writes a fresh profile */
      }
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // +1 for the header row itself, plus however many rows preceded it.
      const rowNum = i + sheet.headerRow + 1;
      const get = rowReader(row);

      try {
        const assayerCode = get(...CODE_ALIASES);
        if (!assayerCode) {
          // A genuinely blank trailing row, not a header problem — that was ruled out above.
          if (Object.values(row).every((v) => v === null || v === undefined || String(v).trim() === '')) continue;
          errors.push(`Row ${rowNum}: no assayer code in this row`);
          continue;
        }

        const codeKey = assayerCode.trim().toUpperCase();
        const seenAt = firstRowForCode.get(codeKey);
        if (seenAt !== undefined) {
          errors.push(
            `Row ${rowNum} (${assayerCode}): same assayer code as row ${seenAt} — only row ${seenAt} was used. ` +
            'Merge the two rows into one and re-upload if both carry details you need.',
          );
          continue;
        }
        firstRowForCode.set(codeKey, rowNum);

        // Rosters carry one combined name column; the record stores first/last
        // separately. Split on whitespace, treating the final token as the surname
        // and everything before it as the given name, so "R Jeganathan" and
        // "Shinil T" both resolve sensibly.
        let firstName = get('First Name', 'FirstName', 'Given Name');
        let lastName = get('Last Name', 'LastName', 'Surname');
        const combinedName = get('Assayer Name', 'Name', 'Full Name', 'Employee Name');
        if ((!firstName || !lastName) && combinedName) {
          const parts = combinedName.split(/\s+/).filter(Boolean);
          if (parts.length === 1) {
            firstName = firstName || parts[0];
            lastName = lastName || parts[0];
          } else {
            firstName = firstName || parts.slice(0, -1).join(' ');
            lastName = lastName || parts[parts.length - 1];
          }
        }
        if (!firstName) {
          errors.push(`Row ${rowNum} (${assayerCode}): provide 'Assayer Name' or 'First Name'`);
          continue;
        }
        if (!lastName) lastName = firstName;

        /**
         * A missing phone is a gap in the record, not a reason to refuse it.
         *
         * This used to reject the row. The client rosters this importer is actually fed have no
         * phone column at all — seven columns: name, code, residence address, location, district,
         * state, zone — so a real roster imported nobody, and the only way past it was for an
         * operator to invent numbers into a payroll-adjacent record.
         *
         * The record is admitted without one and counted as incomplete, which is reported back
         * and shown on the HR record as "Phone — blocks calling and dispatch". The assayer opens
         * at INVITED and the recommendation engine will not deploy them until ACTIVE, so an
         * unreachable person cannot quietly end up on a plan.
         */
        const phone = get('Phone', 'Mobile', 'Contact Number', 'Mobile Number', 'Phone Number', 'Contact');

        // State drives region, zone and the public-holiday calendar, so it is the one field an
        // assayer cannot be planned without — the same line the branch importer draws.
        const state = get('State');
        if (!state) {
          errors.push(`Row ${rowNum} (${assayerCode}): no State — it sets the region, zone and holiday calendar this assayer is planned against`);
          continue;
        }

        const dto: any = {
          assayerCode,
          firstName,
          lastName,
          displayName: get('Display Name') || `${firstName} ${lastName}`,
          email: get('Email') || undefined,
          phone: phone || undefined,
          alternatePhone: get('Alternate Phone') || undefined,
          address: get('Address', 'Residence Address'),
          state,
          district: get('District'),
          // Rosters name the town/locality "Location"; it maps to city.
          city: get('City', 'Location'),
          // Rosters rarely carry a separate pincode column — it is embedded in the
          // residence address, so recover it rather than dropping it.
          pincode: get('Pincode')
            || (get('Residence Address').match(/\b\d{6}\b/)?.[0] ?? undefined),
          // Zone is the operating region on a roster. Normalised because the same
          // zone appears with inconsistent casing ("North" vs "north"), which would
          // otherwise create two distinct regions.
          region: get('Region', 'Zone').replace(/\b\w/g, (c: string) => c.toUpperCase()) || undefined,
          employeeId: get('Employee ID') || undefined,
          employeeCode: get('Employee Code') || undefined,
          employmentType: get('Employment Type') || undefined,
          department: get('Department') || undefined,
          joiningDate: get('Joining Date') || undefined,
          panNumber: get('PAN Number') || undefined,
          bankAccountNumber: get('Bank Account Number') || undefined,
          ifscCode: get('IFSC Code') || undefined,
          experienceYears: parseInt(get('Experience (Years)'), 10) || undefined,
          performanceRating: parseFloat(get('Performance Rating')) || undefined,
          maxDailyWorkload: parseInt(get('Max Daily Workload'), 10) || undefined,
          maxWeeklyWorkload: parseInt(get('Max Weekly Workload'), 10) || undefined,
          emergencyContactName: get('Emergency Contact Name') || undefined,
          emergencyContactPhone: get('Emergency Contact Phone') || undefined,
          emergencyContactRelation: get('Emergency Contact Relation') || undefined,
          workingHours: undefined,
        };

        // Parse array fields
        const skills = get('Skills (comma-separated)', 'Skills');
        if (skills) dto.skills = skills.split(',').map((s: string) => s.trim()).filter(Boolean);

        const languages = get('Languages (comma-separated)', 'Languages');
        if (languages) dto.languages = languages.split(',').map((s: string) => s.trim()).filter(Boolean);

        const prefs = get('Preferred Regions (comma-separated)', 'Preferred Regions');
        if (prefs) dto.preferredRegions = prefs.split(',').map((s: string) => s.trim()).filter(Boolean);

        const specializations = get('Specializations (comma-separated)', 'Specializations');
        if (specializations) dto.specializations = specializations.split(',').map((s: string) => s.trim()).filter(Boolean);

        // Parse certifications: "Name|YYYY-MM-DD;Name2|YYYY-MM-DD"
        const certs = get('Certifications (semicolon-separated: Name|YYYY-MM-DD)', 'Certifications');
        if (certs) {
          dto.certifications = certs.split(';').map((c: string) => {
            const [name, expiryDate] = c.split('|').map((p: string) => p.trim());
            return { name: name || c.trim(), expiryDate: expiryDate || undefined };
          }).filter((c: any) => c.name);
        }

        // Parse working hours
        const whStart = get('Working Hours Start');
        const whEnd = get('Working Hours End');
        if (whStart && whEnd) {
          dto.workingHours = { start: whStart, end: whEnd };
        }

        // Resolved from the batch loaded before the loop, not a query per row.
        const existing = assayerByCode.get(assayerCode) ?? null;
        const saved = existing
          ? await this.update(existing.id, dto, userId)
          : await this.create(dto, userId);
        if (existing) updatedCount++; else createdCount++;

        /**
         * Reported from the saved record, not from the spreadsheet cell.
         *
         * A roster without a phone column re-imported over people who already have numbers must
         * not report 25 unreachable assayers — they are reachable, the sheet simply did not carry
         * the number, and `update` leaves an absent field alone. What the operator needs to act
         * on is who cannot be rung, which is a fact about the record.
         */
        if (!saved.phone || !String(saved.phone).trim()) needingPhone.push(assayerCode);

        // A bulk-imported assayer had no password, so every one of them could be
        // created successfully and then never sign in — the import looked like it
        // worked while producing accounts that could not be used. Set an initial
        // password on creation (from the sheet if supplied, otherwise the documented
        // default) so an imported assayer can actually log in. Never overwrite an
        // existing password: re-importing a roster must not reset live credentials.
        if (!existing) {
          const supplied = get('Initial Password', 'Password');
          const initial = supplied || 'assayer123';
          await this.assayerRepository.update(saved.id, {
            passwordHash: await bcrypt.hash(initial, 12),
          });
        }

        // Commercial rates drive what we owe this assayer and the cost side of
        // every audit they perform, so they are imported with the record rather
        // than needing a second pass. Only written when the sheet actually carries
        // a rate — an all-zero profile would read as "this assayer is free".
        const num = (v: any) => {
          const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''));
          return Number.isFinite(n) ? n : undefined;
        };
        const rates = {
          baseFee: num(get('Base Fee')),
          dailyRate: num(get('Daily Rate')),
          hourlyRate: num(get('Hourly Rate')),
          travelReimbursement: num(get('Travel Reimbursement')),
          accommodationAllowance: num(get('Accommodation Allowance')),
          mealAllowance: num(get('Meal Allowance')),
        };
        if (Object.values(rates).some((v) => v !== undefined)) {
          // From the preload. A brand-new assayer cannot have a profile, so that case no longer
          // pays for a query whose answer is known.
          const activeProfile = existing ? activeProfileByAssayerId.get(saved.id) ?? null : null;

          const payload = {
            baseFee: rates.baseFee ?? activeProfile?.baseFee ?? 0,
            dailyRate: rates.dailyRate ?? activeProfile?.dailyRate ?? 0,
            hourlyRate: rates.hourlyRate ?? activeProfile?.hourlyRate ?? 0,
            travelReimbursement: rates.travelReimbursement ?? activeProfile?.travelReimbursement ?? 0,
            accommodationAllowance: rates.accommodationAllowance ?? activeProfile?.accommodationAllowance ?? 0,
            mealAllowance: rates.mealAllowance ?? activeProfile?.mealAllowance ?? 0,
          };

          if (activeProfile) {
            await this.commercialRepository.save({ ...activeProfile, ...payload, updatedBy: userId });
          } else {
            await this.createCommercialProfile(
              saved.id,
              { ...payload, currency: 'INR', effectiveStartDate: new Date().toISOString() },
              userId,
            );
          }
        }

        importedCount++;
      } catch (err: any) {
        errors.push(`Row ${rowNum}: ${err.message}`);
      }
    }

    return {
      importedCount,
      created: createdCount,
      updated: updatedCount,
      totalRows: rows.length,
      sheetName: sheet.sheetName,
      needingPhone,
      errors,
    };
  }

  /**
   * Lets an assayer change their own password.
   *
   * Until now there was no route anywhere that wrote `assayers.password_hash` outside bulk
   * import, and that write is guarded by `if (!existing)`. `POST /users/me/change-password`
   * queries the `users` repository, and assayers have no `users` row, so it 404s for them.
   * The practical effect: a field worker could never change the password they were issued,
   * and 24 of 25 live accounts were still on the importer's documented default.
   *
   * This is also the precondition for rotating that default — without a way for people to set
   * a new password, rotating it just locks 25 workers out of their jobs.
   */
  async changeOwnPassword(assayerId: string, currentPassword: string, newPassword: string): Promise<void> {
    const assayer = await this.assayerRepository.findOne({
      where: { id: assayerId },
      select: { id: true, passwordHash: true },
    });
    if (!assayer) throw new NotFoundException('Assayer not found.');
    if (!assayer.passwordHash) {
      throw new BadRequestException('This account has no password set. Ask your HR contact to set one for you.');
    }

    const ok = await bcrypt.compare(currentPassword, assayer.passwordHash);
    if (!ok) throw new UnauthorizedException('Your current password is not correct.');

    this.assertPasswordAcceptable(newPassword);

    await this.assayerRepository.update(assayerId, {
      passwordHash: await bcrypt.hash(newPassword, 12),
      // The holder has now chosen their own credential, so the forced-rotation flag clears.
      mustChangePassword: false,
      failedLoginAttempts: 0,
      lockedUntil: null,
      updatedBy: assayerId,
    });

    /**
     * Credential changes are audited.
     *
     * Neither this method nor resetPasswordByStaff recorded anything, while the equivalent
     * user paths emit USER_PASSWORD_CHANGED / USER_PASSWORD_RESET. On a system whose output
     * is legal audit evidence, a credential change with no trail cannot be investigated at
     * all — found while trying to establish who had changed an assayer's password and
     * discovering the answer was unrecoverable.
     */
    await this.auditService.recordEvent({
      category: EventCategory.USER,
      eventType: 'ASSAYER_PASSWORD_CHANGED',
      entityType: 'ASSAYER',
      entityId: assayerId,
      userId: assayerId,
      remarks: 'Assayer changed their own password.',
    });

    await this.recordActivity(assayerId, 'ASSAYER_PASSWORD_CHANGED', null, null, assayerId, 'Password changed by the assayer');
  }

  /** HR/admin resets an assayer's password — the only recovery path for someone locked out. */
  async resetPasswordByStaff(
    assayerId: string,
    newPassword: string | undefined,
    actorId: string,
  ): Promise<{ generatedPassword?: string }> {
    const assayer = await this.assayerRepository.findOne({ where: { id: assayerId }, select: { id: true } });
    if (!assayer) throw new NotFoundException('Assayer not found.');

    // When HR does not supply one, generate a readable temporary password and return it once.
    // The point of the reset is a locked-out field worker on the phone, so the credential has to
    // be sayable — hence a short memorable form rather than a random hex blob — and it is never
    // stored in readable form, only its hash.
    const wasGenerated = !newPassword;
    const password = newPassword ?? this.generateTemporaryPassword();

    this.assertPasswordAcceptable(password);

    await this.assayerRepository.update(assayerId, {
      passwordHash: await bcrypt.hash(password, 12),
      failedLoginAttempts: 0,
      lockedUntil: null,
      // A password chosen by HR is a temporary credential, not the assayer's own. Forcing a
      // change at next sign-in keeps a staff-known password from becoming the permanent one.
      mustChangePassword: true,
      updatedBy: actorId,
    });

    // Who reset whose credential, and when — see the note in changeOwnPassword.
    await this.auditService.recordEventSafe({
      category: EventCategory.USER,
      eventType: 'ASSAYER_PASSWORD_RESET',
      entityType: 'ASSAYER',
      entityId: assayerId,
      userId: actorId,
      remarks: 'Password reset by staff. The assayer must choose a new one at next sign-in.',
    });

    await this.recordActivity(assayerId, 'ASSAYER_PASSWORD_RESET', null, null, actorId, 'Password reset by staff');

    return wasGenerated ? { generatedPassword: password } : {};
  }

  /**
   * A short, sayable temporary password: two lowercase words joined by a digit and a symbol,
   * e.g. "tiger4mango!". Long enough to clear the length rule, memorable enough to read aloud
   * once, and never a shared default. Not meant to be kept — mustChangePassword forces a change
   * at first sign-in.
   */
  private generateTemporaryPassword(): string {
    const words = ['tiger', 'mango', 'river', 'stone', 'cloud', 'ember', 'ivory', 'coral', 'delta', 'flint', 'grove', 'larch'];
    // randomInt is a CSPRNG; Math.random must never mint a credential.
    const pick = () => words[randomInt(words.length)];
    const a = pick();
    let b = pick();
    while (b === a) b = pick();
    return `${a}${randomInt(10)}${b}!`;
  }

  /**
   * Deliberately modest rules. These users are field workers on cheap handsets, often typing
   * with one thumb in bad light — a complexity policy they cannot satisfy produces written-down
   * passwords, which is worse than a simple one they can remember. What it does refuse is the
   * shared defaults, because those are known to anyone holding the roster spreadsheet.
   */
  private assertPasswordAcceptable(password: string): void {
    const pw = (password ?? '').trim();
    if (pw.length < 8) {
      throw new BadRequestException('Please choose a password of at least 8 characters.');
    }
    const BANNED = ['assayer123', 'password@123', 'password', '12345678'];
    if (BANNED.includes(pw.toLowerCase())) {
      throw new BadRequestException('That password is too easy to guess. Please choose a different one.');
    }
  }

}
