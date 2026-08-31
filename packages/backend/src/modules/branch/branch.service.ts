import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as XLSX from 'xlsx';
import { BranchEntity } from './branch.entity';
import { BranchContactEntity } from './branch-contact.entity';
import { BranchDocumentEntity } from './branch-document.entity';
import { ClientService } from '../client/client.service';
import { ZoneEntity } from '../zone/zone.entity';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from '../geo/geo.entities';
import { AuditService } from '../../core/audit/audit.service';
import { BranchQueryService } from './branch-query.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { EventCategory, resolveRegion, canonicalStateName, stateFromCity } from '@fapoms/shared';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import { autocompleteIndia, isPlaceLookupConfigured } from '../geo/india-autocomplete.helper';
import { geocodeIndia } from '../geo/india-geocoder';
import { resolveCoordinates, needsBetterFix, GeoFields } from '../geo/coordinate-resolution';
import { GeoPrecisionService } from '../geo/geo-precision.service';

async function geocodeAddress(address: string, city: string, district: string, state: string, pincode?: string | null): Promise<{ lat: number; lng: number } | null> {
  const res = await geocodeIndia(address, city, district, state, pincode);
  return res ? { lat: res.lat, lng: res.lng } : null;
}

/** A header reduced to letters and digits, lower-cased — so "STATE", "State" and "state" are one. */
const normHeader = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * What each branch field may be called in a real bank's file — matched loosely, not exactly.
 *
 * Every bank exports its own headings: "BRANCH" for the code, "BRANCH_NAME", "STATE",
 * "Branch Address". Forcing the operator to rename columns (or fill in a mapping) before an
 * import would run was ceremony; the alias below lets the file be uploaded as it arrived. A
 * client's explicit `importMapping` still wins where it is set. Compared on `normHeader`, so
 * casing, spaces and underscores never matter.
 */
const BRANCH_IMPORT_ALIASES: Record<string, string[]> = {
  // Normalised (letters+digits, lower-cased), so "SOL ID", "Sol Id", "sol_id", "SOL-ID" all
  // reduce to "solid"; "Branch Code", "BRANCH_NAME", "Branch Address" likewise.
  branchCode: ['branchcode', 'branch', 'brcode', 'branchid', 'branchno', 'branchnumber', 'branchcd', 'bcode'],
  solId: ['solid', 'sol', 'solno', 'solnumber', 'solcode', 'solmapid'],
  name: ['branchname', 'name', 'branchnm', 'nameofbranch'],
  address: ['address', 'branchaddress', 'addr', 'fulladdress', 'completeaddress', 'branchadd'],
  state: ['state', 'statename'],
  district: ['district', 'dist', 'districtname'],
  city: ['city', 'town', 'citytown', 'cityname', 'place'],
  pincode: ['pincode', 'pin', 'postalcode', 'zip', 'zipcode', 'pinno', 'pincodeno'],
  latitude: ['latitude', 'lat'],
  longitude: ['longitude', 'lng', 'long', 'lon', 'longtitude'],
};

/**
 * Map each branch field to the actual header a file uses. The client's explicit `importMapping`
 * wins where set; otherwise the first header whose normalised form is a known alias is taken.
 * Exported so the tolerant matching can be pinned without a whole workbook.
 */
export function resolveBranchHeaders(headers: string[], mapping: Record<string, string> = {}): Record<string, string> {
  const fieldHeader: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(BRANCH_IMPORT_ALIASES)) {
    const explicit = mapping[field];
    if (explicit && headers.includes(explicit)) { fieldHeader[field] = explicit; continue; }
    const hit = headers.find((h) => aliases.includes(normHeader(h)));
    if (hit) fieldHeader[field] = hit;
  }
  return fieldHeader;
}

export interface CreateBranchDto {
  /**
   * Optional. Blank means "allocate the next free one" — see `allocateBranchCode()`.
   *
   * Still typed as possibly-present because every existing caller (the Excel importer, the
   * mobile app, the seed) supplies one, and a supplied code is always honoured.
   */
  branchCode?: string;
  solId?: string;
  name: string;
  address?: string;
  /** The one geography field a branch cannot be planned without: region, zone and holidays. */
  state: string;
  district?: string;
  city?: string;
  pincode?: string;
  region?: string;
  territory?: string;
  zoneId?: string;
  branchType?: string;
  phone?: string;
  email?: string;
  managerName?: string;
  openingDate?: string;
  lastAuditDate?: string;
  operatingHours?: Record<string, any>;
  latitude?: number;
  longitude?: number;
  clientId?: string;
  riskScore?: number;
  riskCategory?: string;
  complexity?: string;
  estimatedDurationHours?: number;
  requiredCompetencies?: string[];
}

export interface UpdateBranchDto {
  branchCode?: string;
  solId?: string;
  name?: string;
  address?: string;
  state?: string;
  district?: string;
  city?: string;
  pincode?: string;
  region?: string;
  territory?: string;
  zoneId?: string;
  branchType?: string;
  phone?: string;
  email?: string;
  managerName?: string;
  openingDate?: string;
  lastAuditDate?: string;
  operatingHours?: Record<string, any>;
  latitude?: number;
  longitude?: number;
  clientId?: string;
  riskScore?: number;
  riskCategory?: string;
  complexity?: string;
  estimatedDurationHours?: number;
  requiredCompetencies?: string[];
}

export interface CreateContactDto {
  name: string;
  email: string;
  phone: string;
  /**
   * Optional. A contact you only have a phone number for is still worth recording — refusing the
   * save until a job title is invented is how "Manager" ends up against half the roster.
   */
  designation?: string;
  department?: string;
  isPrimary?: boolean;
  notes?: string;
}

export interface UpdateContactDto {
  name?: string;
  email?: string;
  phone?: string;
  designation?: string;
  department?: string;
  isPrimary?: boolean;
  notes?: string;
}

export interface CreateDocumentDto {
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType?: string;
  category: string;
  remarks?: string;
}

@Injectable()
export class BranchService {
  constructor(
    @InjectRepository(BranchEntity)
    private readonly branchRepository: Repository<BranchEntity>,
    @InjectRepository(BranchContactEntity)
    private readonly contactRepository: Repository<BranchContactEntity>,
    @InjectRepository(BranchDocumentEntity)
    private readonly documentRepository: Repository<BranchDocumentEntity>,
    @InjectRepository(ZoneEntity)
    private readonly zoneRepository: Repository<ZoneEntity>,
    @InjectRepository(GeoStateEntity)
    private readonly stateRepository: Repository<GeoStateEntity>,
    @InjectRepository(GeoDistrictEntity)
    private readonly districtRepository: Repository<GeoDistrictEntity>,
    @InjectRepository(GeoCityEntity)
    private readonly cityRepository: Repository<GeoCityEntity>,
    private readonly clientService: ClientService,
    private readonly auditService: AuditService,
    private readonly branchQueryService: BranchQueryService,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly geoPrecision: GeoPrecisionService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // -----------------------------------------------------------------------
  // Branch Profile
  // -----------------------------------------------------------------------

  /**
   * The next free `BR-####`, allocated server-side.
   *
   * The office does not hold a branch-code register — the number only has to be unique and
   * ordered, which is exactly the sort of fact the database already knows and the person filling
   * in the form does not. Mirrors `AssayerService.allocateAssayerCode`, deliberately: one house
   * style for "left blank, one is assigned for you".
   *
   * `withDeleted` matters. A soft-deleted branch still occupies its code, and a highest-of-the-
   * living scan re-issues the code of the last branch anyone removed — which then collides with
   * it in every report that reads deleted rows.
   *
   * Concurrency: the scan-and-increment is racy on its own (two simultaneous creates read the
   * same highest), so the caller retries — see `create`. Branch codes repeat across clients by
   * design (two banks each have their own "BR-0001"), so the uniqueness that backs this is
   * per-client — `UQ_branches_client_branch_code`, added in 1792900000000 — and the create path
   * also re-checks by hand to turn a collision into a readable message rather than a raw index
   * error.
   */
  private async allocateBranchCode(): Promise<string> {
    const rows = await this.branchRepository.find({ select: ['branchCode'], withDeleted: true } as any);
    const highest = rows.reduce((max, r) => {
      const m = /^BR-(\d+)$/.exec(r.branchCode ?? '');
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    return `BR-${String(highest + 1).padStart(4, '0')}`;
  }

  async create(dto: CreateBranchDto, userId: string, organizationId?: string | null): Promise<BranchEntity> {
    /**
     * A hand-typed code is honoured as-is; a blank one is allocated here, and only here.
     *
     * The retry exists for the two-people-at-once case: both read the same highest code, the
     * first save wins, and the second finds its allocation taken and simply asks for the next
     * one. A user-supplied code never retries — that must still surface as a conflict rather
     * than silently save under a different code than the one that was typed.
     */
    const supplied = dto.branchCode?.trim();
    if (supplied) {
      dto = { ...dto, branchCode: supplied };
    } else {
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = await this.allocateBranchCode();
        const taken = await this.branchRepository.findOne({
          where: { branchCode: candidate },
          withDeleted: true,
        });
        if (!taken) { dto = { ...dto, branchCode: candidate }; break; }
      }
      if (!dto.branchCode) {
        throw new BadRequestException('Could not allocate a branch code just now. Please try again.');
      }
    }

    await this.validateGeography(dto.state, dto.district, dto.city);

    // A branch is identified by its ids per client, never its name — two banks share a branch
    // name at one address, and one bank reuses a name across towns. Refuse a Branch Code or a
    // SOL ID this client already uses, with a message that names the conflict, rather than
    // letting the database reject it with one nobody in the office can read.
    if (dto.clientId) {
      const codeTaken = await this.branchRepository.findOne({
        where: { branchCode: dto.branchCode, clientId: dto.clientId, isActive: true },
      });
      if (codeTaken) {
        throw new ConflictException(`Branch Code '${dto.branchCode}' is already used by another branch for this client.`);
      }
      if (dto.solId) {
        const solTaken = await this.branchRepository.findOne({
          where: { solId: dto.solId, clientId: dto.clientId, isActive: true },
        });
        if (solTaken) {
          throw new ConflictException(`SOL ID '${dto.solId}' is already used by another branch for this client.`);
        }
      }
    }

    if (dto.zoneId) {
      const zone = await this.zoneRepository.findOne({ where: { id: dto.zoneId } });
      if (!zone) {
        throw new BadRequestException(`Zone ${dto.zoneId} not found.`);
      }
    }

    /**
     * Resolved through the shared chain, which reaches the free OSM tiers and — crucially —
     * records how precise the answer is. This used to call a Google-only helper that returns
     * null without an API key, silently leaving `latitude`/`longitude` undefined and writing a
     * `{type:'Point', coordinates:[undefined, undefined]}` geometry. `precise` is on: this is
     * one interactive save, so a second of rate-limited lookup is the right trade for a
     * coordinate that is actually near the branch.
     */
    const geo = await resolveCoordinates({
      address: dto.address,
      city: dto.city,
      district: dto.district,
      state: dto.state,
      pincode: dto.pincode,
      name: dto.name,
      brand: dto.clientId ? (await this.clientService.findOne(dto.clientId).catch(() => null))?.name : null,
      suppliedLat: dto.latitude,
      suppliedLng: dto.longitude,
      // A coordinate typed into the Add Branch form was put there by a person on purpose.
      suppliedIsManual: dto.latitude != null && dto.longitude != null,
    });

    const geoFields: Partial<GeoFields> = geo ?? {};
    const branch = this.branchRepository.create({
      branchCode: dto.branchCode!,   // guaranteed above: supplied, or allocated
      solId: dto.solId ?? null,
      name: dto.name,
      // NOT NULL columns that are optional on admission — empty is what the importer already
      // stores for an unknown field, and it reads as blank everywhere rather than crashing the
      // insert. See CreateBranchDto for why state is the only geography field that is mandatory.
      address: dto.address ?? '',
      state: dto.state,
      district: dto.district ?? '',
      city: dto.city ?? '',
      pincode: dto.pincode ?? null,
      // Canonicalised on write, state first. Letting a caller store an arbitrary string here
      // is what made the column unfilterable in the first place; the migration that cleaned it
      // up would be undone by the next import otherwise.
      region: resolveRegion(dto.region) ?? resolveRegion(dto.state) ?? null,
      territory: dto.territory ?? null,
      zoneId: dto.zoneId ?? null,
      branchType: dto.branchType ?? null,
      phone: dto.phone ?? null,
      email: dto.email ?? null,
      managerName: dto.managerName ?? null,
      openingDate: dto.openingDate ?? null,
      lastAuditDate: dto.lastAuditDate ?? null,
      operatingHours: dto.operatingHours ?? null,
      ...geoFields,
      clientId: dto.clientId ?? null,
      riskScore: dto.riskScore ?? 0,
      riskCategory: dto.riskCategory ?? null,
      complexity: dto.complexity ?? 'STANDARD',
      estimatedDurationHours: dto.estimatedDurationHours ?? 8.00,
      requiredCompetencies: dto.requiredCompetencies ?? null,
      organizationId: organizationId ?? null,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.branchRepository.save(branch);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'BRANCH_CREATED',
      entityType: 'BRANCH',
      entityId: saved.id,
      userId,
      remarks: `Created branch ${saved.name} (${saved.branchCode})`,
    });

    try {
      this.eventPublisher.publish('branch:created', {
        eventType: 'branch:created',
        branchId: saved.id,
        branchCode: saved.branchCode,
        name: saved.name,
        clientId: saved.clientId,
        organizationId: saved.organizationId,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish branch:created event:', err);
    }

    return saved;
  }

  async findOne(id: string): Promise<BranchEntity> {
    return this.branchQueryService.findOne(id);
  }

  async findAll(
    page = 1,
    limit = 20,
    scope: Partial<GlobalScope> = {},
    filters: { search?: string; risk?: string; type?: string } = {},
  ): Promise<{ branches: BranchEntity[]; total: number }> {
    return this.branchQueryService.findAll(page, limit, scope, filters);
  }

  async scopeFacets(scope: Partial<GlobalScope> = {}) {
    return this.branchQueryService.scopeFacets(scope);
  }

  async summary(
    scope: Partial<GlobalScope> = {},
    filters: { search?: string; risk?: string; type?: string } = {},
  ) {
    return this.branchQueryService.summary(scope, filters);
  }

  async update(id: string, dto: UpdateBranchDto, userId: string): Promise<BranchEntity> {
    const branch = await this.findOne(id);

    if (dto.state !== undefined || dto.district !== undefined || dto.city !== undefined) {
      await this.validateGeography(
        dto.state ?? branch.state,
        dto.district ?? branch.district,
        dto.city ?? branch.city,
      );
    }

    if (dto.zoneId !== undefined && dto.zoneId !== null) {
      const zone = await this.zoneRepository.findOne({ where: { id: dto.zoneId } });
      if (!zone) throw new BadRequestException(`Zone ${dto.zoneId} not found.`);
    }

    const addressChanged = dto.address !== undefined && dto.address !== branch.address;
    const cityChanged = dto.city !== undefined && dto.city !== branch.city;
    const districtChanged = dto.district !== undefined && dto.district !== branch.district;
    const stateChanged = dto.state !== undefined && dto.state !== branch.state;
    const coordsSupplied = dto.latitude !== undefined && dto.longitude !== undefined;

    /**
     * Re-resolve only when the address actually moved, or the caller supplied a pin.
     *
     * `resolveCoordinates` returns null to mean "leave this alone", which is how a hand-placed
     * pin survives an edit to the branch's phone number — or to its address. Someone who has
     * stood at the branch knows better than any geocoder, and a correction they made is exactly
     * the data an automated re-resolve would destroy most quietly.
     */
    if (addressChanged || cityChanged || districtChanged || stateChanged || coordsSupplied) {
      const geo = await resolveCoordinates(
        {
          address: dto.address ?? branch.address,
          city: dto.city ?? branch.city,
          district: dto.district ?? branch.district,
          state: dto.state ?? branch.state,
          pincode: dto.pincode ?? branch.pincode,
          name: dto.name ?? branch.name,
          suppliedLat: dto.latitude,
          suppliedLng: dto.longitude,
          suppliedIsManual: coordsSupplied,
        },
        branch,
      );
      if (geo) Object.assign(branch, geo);
    }

    if (dto.branchCode !== undefined) branch.branchCode = dto.branchCode;
    if (dto.solId !== undefined) branch.solId = dto.solId;
    if (dto.name !== undefined) branch.name = dto.name;
    if (dto.address !== undefined) branch.address = dto.address;
    if (dto.state !== undefined) branch.state = dto.state;
    if (dto.district !== undefined) branch.district = dto.district;
    if (dto.city !== undefined) branch.city = dto.city;
    if (dto.pincode !== undefined) branch.pincode = dto.pincode;
    // Region follows the state unless the caller names one explicitly, and is canonicalised
    // either way — see the matching note on create().
    if (dto.region !== undefined) {
      branch.region = resolveRegion(dto.region) ?? resolveRegion(branch.state) ?? null;
    } else if (dto.state !== undefined) {
      branch.region = resolveRegion(dto.state) ?? branch.region;
    }
    if (dto.territory !== undefined) branch.territory = dto.territory;
    if (dto.zoneId !== undefined) branch.zoneId = dto.zoneId;
    if (dto.branchType !== undefined) branch.branchType = dto.branchType;
    if (dto.phone !== undefined) branch.phone = dto.phone;
    if (dto.email !== undefined) branch.email = dto.email;
    if (dto.managerName !== undefined) branch.managerName = dto.managerName;
    if (dto.openingDate !== undefined) branch.openingDate = dto.openingDate;
    if (dto.lastAuditDate !== undefined) branch.lastAuditDate = dto.lastAuditDate;
    if (dto.operatingHours !== undefined) branch.operatingHours = dto.operatingHours;
    // Coordinates are set above by resolveCoordinates, which also records their precision.
    // Assigning them again here would strip that provenance back off.
    if (dto.clientId !== undefined) branch.clientId = dto.clientId;
    if (dto.riskScore !== undefined) branch.riskScore = dto.riskScore;
    if (dto.riskCategory !== undefined) branch.riskCategory = dto.riskCategory;
    if (dto.complexity !== undefined) branch.complexity = dto.complexity;
    if (dto.estimatedDurationHours !== undefined) branch.estimatedDurationHours = dto.estimatedDurationHours;
    if (dto.requiredCompetencies !== undefined) branch.requiredCompetencies = dto.requiredCompetencies;
    branch.updatedBy = userId;

    const saved = await this.branchRepository.save(branch);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'BRANCH_UPDATED',
      entityType: 'BRANCH',
      entityId: saved.id,
      userId,
      remarks: `Updated branch ${saved.name} (${saved.branchCode})`,
    });

    try {
      this.eventPublisher.publish('branch:updated', {
        eventType: 'branch:updated',
        branchId: saved.id,
        name: saved.name,
        clientId: saved.clientId,
        organizationId: saved.organizationId,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish branch:updated event:', err);
    }

    return saved;
  }

  async remove(id: string, userId: string): Promise<void> {
    const branch = await this.findOne(id);
    branch.isActive = false;
    branch.updatedBy = userId;
    await this.branchRepository.save(branch);

    // Deactivate associated contacts
    await this.dataSource.query(
      `UPDATE branch_contacts SET is_active = false, updated_by = $1 WHERE branch_id = $2 AND is_active = true`,
      [userId, id],
    );

    // Deactivate associated documents
    await this.dataSource.query(
      `UPDATE branch_documents SET is_active = false, updated_by = $1 WHERE branch_id = $2 AND is_active = true`,
      [userId, id],
    );

    // Deactivate associated project branches
    await this.dataSource.query(
      `UPDATE project_branches SET is_active = false, updated_by = $1 WHERE branch_id = $2 AND is_active = true`,
      [userId, id],
    );

    /**
     * And the assessments raised against it.
     *
     * An assessment is created alongside every project-branch link, so leaving them live is the
     * same defect the project-branch line above already fixes: the branch disappears from the
     * branch list while its work item stays in the validation and data-entry queues, pointing at
     * a record nobody can open.
     */
    await this.dataSource.query(
      `UPDATE assessments SET is_active = false, updated_by = $1 WHERE branch_id = $2 AND is_active = true`,
      [userId, id],
    );

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'BRANCH_DELETED',
      entityType: 'BRANCH',
      entityId: id,
      userId,
      remarks: `Soft deleted branch ${branch.name} and cascaded deactivation to contacts, documents, project branches, and assessments`,
    });
  }

  // -----------------------------------------------------------------------
  // Contacts
  // -----------------------------------------------------------------------

  async findContacts(branchId: string): Promise<BranchContactEntity[]> {
    await this.findOne(branchId);
    return this.contactRepository.find({ where: { branchId, isActive: true } });
  }

  async addContact(branchId: string, dto: CreateContactDto, userId: string): Promise<BranchContactEntity> {
    await this.findOne(branchId);

    if (dto.isPrimary) {
      await this.contactRepository.update({ branchId, isPrimary: true }, { isPrimary: false });
    }

    const contact = this.contactRepository.create({
      branchId,
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      // NOT NULL column, optional on admission — empty reads as blank everywhere, the same
      // treatment `address` already gets on the branch itself.
      designation: dto.designation ?? '',
      department: dto.department ?? null,
      isPrimary: dto.isPrimary ?? false,
      notes: dto.notes ?? null,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.contactRepository.save(contact);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'BRANCH_CONTACT_CREATED',
      entityType: 'BRANCH',
      entityId: branchId,
      userId,
      remarks: `Added contact ${saved.name} to branch`,
    });

    return saved;
  }

  async updateContact(contactId: string, dto: UpdateContactDto, userId: string): Promise<BranchContactEntity> {
    const contact = await this.contactRepository.findOne({ where: { id: contactId, isActive: true } });
    if (!contact) {
      throw new NotFoundException(`Contact ${contactId} not found.`);
    }

    if (dto.isPrimary) {
      await this.contactRepository.update({ branchId: contact.branchId, isPrimary: true }, { isPrimary: false });
    }

    if (dto.name !== undefined) contact.name = dto.name;
    if (dto.email !== undefined) contact.email = dto.email;
    if (dto.phone !== undefined) contact.phone = dto.phone;
    if (dto.designation !== undefined) contact.designation = dto.designation;
    if (dto.department !== undefined) contact.department = dto.department;
    if (dto.isPrimary !== undefined) contact.isPrimary = dto.isPrimary;
    if (dto.notes !== undefined) contact.notes = dto.notes;

    contact.updatedBy = userId;
    return this.contactRepository.save(contact);
  }

  async removeContact(contactId: string, userId: string): Promise<void> {
    const contact = await this.contactRepository.findOne({ where: { id: contactId, isActive: true } });
    if (!contact) {
      throw new NotFoundException(`Contact ${contactId} not found.`);
    }
    contact.isActive = false;
    contact.updatedBy = userId;
    await this.contactRepository.save(contact);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'BRANCH_CONTACT_REMOVED',
      entityType: 'BRANCH',
      entityId: contact.branchId,
      userId,
      remarks: `Removed contact ${contact.name} from branch`,
      metadata: { contactId: contact.id, name: contact.name, designation: contact.designation ?? null, email: contact.email ?? null, phone: contact.phone ?? null },
    });
  }

  // -----------------------------------------------------------------------
  // Documents
  // -----------------------------------------------------------------------

  async findDocuments(branchId: string): Promise<BranchDocumentEntity[]> {
    await this.findOne(branchId);
    return this.documentRepository.find({ where: { branchId, isActive: true }, order: { createdAt: 'DESC' } });
  }

  async addDocument(branchId: string, dto: CreateDocumentDto, userId: string): Promise<BranchDocumentEntity> {
    await this.findOne(branchId);

    const doc = this.documentRepository.create({
      branchId,
      fileName: dto.fileName,
      filePath: dto.filePath,
      fileSize: dto.fileSize,
      mimeType: dto.mimeType ?? null,
      category: dto.category,
      remarks: dto.remarks ?? null,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.documentRepository.save(doc);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'BRANCH_DOCUMENT_CREATED',
      entityType: 'BRANCH',
      entityId: branchId,
      userId,
      remarks: `Added document ${saved.fileName} to branch`,
    });

    return saved;
  }

  async removeDocument(documentId: string, userId: string): Promise<void> {
    const doc = await this.documentRepository.findOne({ where: { id: documentId, isActive: true } });
    if (!doc) {
      throw new NotFoundException(`Document ${documentId} not found.`);
    }
    doc.isActive = false;
    doc.updatedBy = userId;
    await this.documentRepository.save(doc);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'BRANCH_DOCUMENT_REMOVED',
      entityType: 'BRANCH',
      entityId: doc.branchId,
      userId,
      remarks: `Removed document ${doc.fileName} from branch`,
      metadata: { documentId: doc.id, fileName: doc.fileName, category: doc.category, filePath: doc.filePath },
    });
  }

  // -----------------------------------------------------------------------
  // Excel Import (unchanged pattern)
  // -----------------------------------------------------------------------

  async importExcel(
    fileBuffer: Buffer,
    clientId: string,
    userId: string,
  ): Promise<{ importedCount: number; errors: string[] }> {
    const client = await this.clientService.findOne(clientId);

    /**
     * The column mapping is an override, not a prerequisite.
     *
     * Every lookup below already falls back to a standard heading — `Branch Code`, `SOL ID`,
     * `Branch Name` and so on — and those defaults are the same words the client's
     * configuration screen offers as labels. So a file with the standard headings needed no
     * mapping at all; the operator was made to type the defaults back in before the import
     * would run, and a newly created client starts with an empty mapping, which meant every
     * new client was blocked on this ceremony.
     *
     * It stays configurable because clients really do differ — one bank's file says
     * `Branch Code` and another's says `BrCode` — but only the clients that differ have to say
     * so. A mapping entry that is absent means "this file uses the standard heading".
     */
    const mapping: Record<string, string> = client.configuration?.importMapping ?? {};

    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet);

    /**
     * Resolve each field to the actual header this file uses, ONCE. The client's explicit
     * mapping wins; otherwise the first header whose normalised form is a known alias is taken.
     * So "BRANCH", "BRANCH_NAME", "STATE", "Branch Address" all land on the right field with no
     * reshaping and no per-client setup.
     */
    const headers = rows.length ? Object.keys(rows[0] as object) : [];
    const fieldHeader = resolveBranchHeaders(headers, mapping);
    const cell = (row: Record<string, any>, field: string): string =>
      fieldHeader[field] ? String(row[fieldHeader[field]] ?? '').trim() : '';

    const errors: string[] = [];

    // Rows that landed on a coarse tier, handed to the precision worker once the loop is done.

    const coarseIds: string[] = [];
    let importedCount = 0;

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const rowNum = index + 2;

      try {
        let branchCode = cell(row, 'branchCode');
        const solId = cell(row, 'solId');
        // Some files identify a branch only by the bank's SOL id, with no separate code column.
        // The SOL then serves as our code too — both stay unique per client, and they match on
        // re-import.
        if (!branchCode && solId) branchCode = solId;
        const name = cell(row, 'name');
        const address = cell(row, 'address');
        let state = cell(row, 'state');
        const district = cell(row, 'district');
        const city = cell(row, 'city');

        // Bank files often put a city in the State column ("Chennai", "Bangalore"). The state drives
        // this branch's region, zone and holiday calendar, so rather than reject the row, recover the
        // real state from the city — from the state cell itself, or, failing that, from the City
        // column — before the geography check runs. A city we don't know still falls through to the
        // normal state validation below, so a genuine typo is still caught.
        if (state && !canonicalStateName(state)) {
          const recovered = stateFromCity(state) ?? (city ? stateFromCity(city) : null);
          if (recovered) state = recovered;
        }
        const pincode = cell(row, 'pincode');
        const latitude = parseFloat(cell(row, 'latitude'));
        const longitude = parseFloat(cell(row, 'longitude'));

        // A branch needs an identity, a name and a state — the state sets its region, zone and
        // holiday calendar. District, city and address are welcome but not required: a file that
        // carries coordinates (this one does) places the branch exactly without them, and one
        // that doesn't still resolves from state + pincode.
        if (!branchCode || !name || !state) {
          const missing = [!branchCode && 'branch code', !name && 'branch name', !state && 'state'].filter(Boolean).join(', ');
          errors.push(`Row ${rowNum}: missing ${missing}.`);
          continue;
        }

        try {
          await this.validateGeography(state, district, city);
        } catch (geoErr: any) {
          errors.push(`Row ${rowNum}: Geography validation failed - ${geoErr.message}`);
          continue;
        }

        /**
         * A branch is identified by the bank's own SOL ID and our Branch Code — per client, and
         * never by name, because two different banks run a branch of the same name at the same
         * address ("MG Road") and one bank reuses a name across towns. So the match is on the
         * ids, SOL ID first (the lender's authoritative one). If the file's SOL ID and Branch
         * Code point at two *different* existing branches, the row disagrees with itself and is
         * refused rather than silently merged into the wrong record.
         */
        const bySol = solId
          ? await this.branchRepository.findOne({ where: { solId, clientId, isActive: true } })
          : null;
        const byCode = await this.branchRepository.findOne({ where: { branchCode, clientId, isActive: true } });
        if (bySol && byCode && bySol.id !== byCode.id) {
          errors.push(`Row ${rowNum}: SOL ID '${solId}' and Branch Code '${branchCode}' already belong to two different branches for this client — fix whichever is wrong before re-importing.`);
          continue;
        }
        const existing = bySol ?? byCode;

        /**
         * Located through the same chain as every other branch write.
         *
         * This importer used to store `null` coordinates whenever the sheet had none — no
         * geocode, no precision stamp — so a branch brought in this way had no pin at all: absent
         * from the planning map, distance "unknown", and invisible to the precision sweep
         * because it carried no `geo_source` to be judged by. The project importer, a different
         * door into the same table, geocoded every row. Two importers, two answers.
         *
         * Same trade as the project importer: the fast tiers here (`precise: false`), because
         * this is a bulk loop and the free providers allow about one lookup a second; the rows
         * that land coarse are handed to the precision worker below, so they are upgraded in the
         * background instead of waiting to be noticed. A coordinate pair the sheet does carry is
         * honoured (`resolveCoordinates` rule 1), and a manual pin on an existing row is never
         * overwritten (rule 2) — which is why `existing` is passed.
         */
        const geo = await resolveCoordinates(
          {
            address, city, district, state, pincode: pincode || null, name, brand: client.name,
            suppliedLat: isNaN(latitude) ? null : latitude,
            suppliedLng: isNaN(longitude) ? null : longitude,
            precise: false,
          },
          existing ?? null,
        );
        const geoFields: Partial<GeoFields> = geo ?? {};

        let saved: BranchEntity;
        if (existing) {
          // Matched by one id, so keep BOTH in step: a row found by SOL ID may carry a corrected
          // Branch Code, and a row found by Branch Code may be gaining its SOL ID for the first
          // time. A blank SOL ID in the file never erases one already on the record.
          existing.branchCode = branchCode;
          if (solId) existing.solId = solId;
          existing.name = name;
          existing.address = address;
          existing.state = state;
          existing.district = district;
          existing.city = city;
          existing.pincode = pincode || null;
          existing.updatedBy = userId;
          Object.assign(existing, geoFields);
          saved = await this.branchRepository.save(existing);
        } else {
          const branch = this.branchRepository.create({
            branchCode,
            solId: solId || null,
            name,
            address,
            state,
            district,
            city,
            pincode: pincode || null,
            clientId,
            ...geoFields,
            createdBy: userId,
            updatedBy: userId,
          });
          saved = await this.branchRepository.save(branch);
        }
        if (saved?.id && needsBetterFix(saved.geoSource ?? null, saved.geoAccuracyMeters ?? null)) {
          coarseIds.push(saved.id);
        }

        importedCount++;
      } catch (err: any) {
        errors.push(`Row ${rowNum}: Unexpected parse error - ${err.message}`);
      }
    }

    if (importedCount > 0) {
      await this.auditService.recordEvent({
        category: EventCategory.OPERATIONAL,
        eventType: 'BRANCHES_BULK_IMPORT',
        entityType: 'CLIENT',
        entityId: clientId,
        userId,
        remarks: `Bulk imported/updated ${importedCount} branches. Errors: ${errors.length}`,
      });
    }

    // Same hand-off as the project importer: coarse rows are upgraded in the background, and the
    // nightly sweep catches anything this enqueue cannot. Fire-and-forget on purpose.
    void this.geoPrecision.enqueueBackfill('branch', coarseIds, `client import ${clientId}`);

    return { importedCount, errors };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Verify only what the caller actually supplied.
   *
   * District and city are optional on admission, and this used to pass them straight into a
   * reference lookup and then into `autocompleteIndia(undefined)` — which cannot verify a place
   * that was never claimed, and would refuse a branch for failing to confirm a blank. A state on
   * its own is still checked; the finer geography is checked only when it is given.
   */
  private async validateGeography(state: string, district?: string, city?: string): Promise<void> {
    // The state is checked offline. `canonicalStateName` knows every state and union territory
    // under any spelling, and the state is the field that actually drives behaviour — it sets the
    // region, the zone and the public-holiday calendar. Checking it here keeps the protection that
    // matters without depending on an outside service.
    if (!canonicalStateName(state)) {
      const stateKnown = await this.stateRepository.findOne({ where: { name: state } });
      if (!stateKnown) {
        throw new BadRequestException(
          `Could not verify '${state}' as a real state. Check the spelling — it sets the region, zone and holiday calendar for this branch.`,
        );
      }
    }

    if (!district?.trim() || !city?.trim()) return;

    /**
     * District and city can only be cross-checked against the live place lookup, and that lookup
     * is optional: with no API key it answers every query with an empty list, which this code
     * used to read as "no such place".
     *
     * The curated reference tables hold 22 cities, so in practice *no* real branch matched them
     * and every create and edit was refused — with a message blaming the operator's spelling for
     * a missing key. Verify when the lookup can answer; do not invent a failure when it cannot.
     */
    if (!isPlaceLookupConfigured()) return;

    const stateEntity = await this.stateRepository.findOne({ where: { name: state } });
    const districtEntity = stateEntity
      ? await this.districtRepository.findOne({ where: { name: district, stateId: stateEntity.id } })
      : null;
    const cityEntity = districtEntity
      ? await this.cityRepository.findOne({ where: { name: city, districtId: districtEntity.id } })
      : null;

    // The curated reference tables only cover a handful of states. If a real
    // place is not in them, confirm it exists via live geo search rather than
    // rejecting a legitimate branch — a hard-coded map can't know every district.
    if (!cityEntity) {
      const live = await autocompleteIndia(city);
      const found = live.some(
        (p) =>
          p.district &&
          p.state &&
          p.district.toLowerCase() === district.toLowerCase() &&
          p.state.toLowerCase() === state.toLowerCase(),
      );
      const stateLive = await autocompleteIndia(state);
      const stateExists = stateLive.some(
        (p) => p.type === 'state' || p.state.toLowerCase() === state.toLowerCase(),
      );
      if (!found && !stateExists) {
        throw new BadRequestException(
          `Could not verify '${city}, ${district}, ${state}' as a real place. Check the spelling of the state, district and city.`,
        );
      }
    }
  }

  async registerImportedBranch(dto: Partial<BranchEntity>, userId: string): Promise<BranchEntity> {
    const branch = this.branchRepository.create({
      ...dto,
      createdBy: userId,
      updatedBy: userId,
    });
    return this.branchRepository.save(branch);
  }

  async findOrCreateZone(name: string, clientId: string, states: string[]): Promise<ZoneEntity> {
    let zone = await this.zoneRepository.findOne({ where: { name, clientId, isActive: true } });
    if (!zone) {
      zone = this.zoneRepository.create({
        name,
        clientId,
        states,
        districts: []
      });
      zone = await this.zoneRepository.save(zone);
    }
    return zone;
  }
}
