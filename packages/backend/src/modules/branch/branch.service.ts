import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BranchEntity } from './branch.entity';
import { BranchContactEntity } from './branch-contact.entity';
import { BranchDocumentEntity } from './branch-document.entity';
import { ClientService } from '../client/client.service';
import { ZoneEntity } from '../zone/zone.entity';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from '../geo/geo.entities';
import { AuditService } from '../../core/audit/audit.service';
import { BranchQueryService } from './branch-query.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { EventCategory, resolveRegion, canonicalStateName } from '@fapoms/shared';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import { autocompleteIndia, isPlaceLookupConfigured } from '../geo/india-autocomplete.helper';
import { resolveCoordinates, GeoFields } from '../geo/coordinate-resolution';
import { GeoPrecisionService } from '../geo/geo-precision.service';

/** A header reduced to letters and digits, lower-cased — so "STATE", "State" and "state" are one. */
const normHeader = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * What each branch field may be called in a real bank's file — matched loosely, not exactly.
 *
 * Every bank exports its own headings: "BRANCH" for the SOL id, "BRANCH_NAME", "STATE",
 * "Branch Address". Forcing the operator to rename columns (or fill in a mapping) before an
 * import would run was ceremony; the alias below lets the file be uploaded as it arrived. A
 * client's explicit `importMapping` still wins where it is set. Compared on `normHeader`, so
 * casing, spaces and underscores never matter.
 */
const BRANCH_IMPORT_ALIASES: Record<string, string[]> = {
  // Normalised (letters+digits, lower-cased), so "SOL ID", "Sol Id", "sol_id", "SOL-ID" all
  // reduce to "solid"; "Branch Code", "BRANCH_NAME", "Branch Address" likewise. The SOL id is a
  // branch's single identity, so the columns a bank uses to name it — "SOL ID", but also the plain
  // "BRANCH"/"Branch Code" that hold the same number — all resolve to it.
  solId: ['solid', 'sol', 'solno', 'solnumber', 'solcode', 'solmapid',
          'branchcode', 'branch', 'brcode', 'branchid', 'branchno', 'branchnumber', 'branchcd', 'bcode'],
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
   * The SOL ID — the bank's own unique branch identifier, and ours. Required: it is the single
   * identity a branch has (a bank file's "BRANCH" column carries it), unique per client.
   */
  solId: string;
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

  async create(dto: CreateBranchDto, userId: string, organizationId?: string | null): Promise<BranchEntity> {
    // The SOL ID is a branch's single identity, supplied by the operator or the file — never
    // generated. A blank one is a data error, refused here rather than saved as an empty identity.
    const solId = dto.solId?.trim();
    if (!solId) {
      throw new BadRequestException('A SOL ID is required — it is the branch\'s unique identifier.');
    }
    dto = { ...dto, solId };

    await this.validateGeography(dto.state, dto.district, dto.city);

    // A branch is identified by its SOL ID per client, never its name — two banks share a branch
    // name at one address, and one bank reuses a name across towns. Refuse a SOL ID this client
    // already uses, with a message that names the conflict, rather than letting the database reject
    // it with one nobody in the office can read.
    if (dto.clientId) {
      const solTaken = await this.findBySolId(solId, dto.clientId);
      if (solTaken) throw this.solIdConflict(solId, solTaken);
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
      solId: dto.solId!,   // guaranteed above: required, trimmed
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

    /**
     * The check above and this write are not one atomic act.
     *
     * Two operators adding the same branch at the same moment — or an import running while someone
     * adds a branch by hand — both find the SOL ID free and both insert. The database's unique index
     * is what actually keeps the data correct; without this catch, the loser sees a raw
     * `duplicate key value violates unique constraint "UQ_branches_client_sol_id"` as a 500, which
     * says nothing and looks like the system broke rather than like the branch already existing.
     */
    let saved: BranchEntity;
    try {
      saved = await this.branchRepository.save(branch);
    } catch (err: any) {
      // 23505 = unique_violation. Re-read so the message can name the branch that won the race.
      if (err?.code === '23505' && dto.clientId) {
        const winner = await this.findBySolId(solId, dto.clientId);
        if (winner) throw this.solIdConflict(solId, winner);
      }
      throw err;
    }

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'BRANCH_CREATED',
      entityType: 'BRANCH',
      entityId: saved.id,
      userId,
      remarks: `Created branch ${saved.name} (${saved.solId})`,
    });

    try {
      this.eventPublisher.publish('branch:created', {
        eventType: 'branch:created',
        branchId: saved.id,
        solId: saved.solId,
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

    /**
     * The SOL ID is checked on edit exactly as it is on create.
     *
     * It was not checked at all: `update` did `if (dto.solId !== undefined) branch.solId = dto.solId`
     * and saved. So the one field that IS a branch's identity — the field every import, every
     * assignment and every re-import matches on — could be blanked or pointed at another branch's
     * SOL ID from the edit form, while `create` a hundred lines above refused both. A blank one
     * makes the branch unmatchable by any future import of that client's list, which shows up much
     * later as a duplicate rather than as an error here.
     */
    if (dto.solId !== undefined) {
      const solId = dto.solId?.trim();
      if (!solId) {
        throw new BadRequestException("A SOL ID is required — it is the branch's unique identifier.");
      }
      if (solId !== branch.solId) {
        const clientId = dto.clientId ?? branch.clientId;
        const taken = clientId ? await this.findBySolId(solId, clientId, branch.id) : null;
        if (taken) throw this.solIdConflict(solId, taken);
      }
      dto = { ...dto, solId };
    }

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
      remarks: `Updated branch ${saved.name} (${saved.solId})`,
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

  /**
   * Bring an archived branch back, because a client's own list still names it.
   *
   * Called only by the importer. A named act rather than an `isActive` field on `UpdateBranchDto`,
   * for two reasons: reviving a branch is a real event that belongs in the audit trail under its
   * own name, and a boolean on the edit DTO would let any caller of `PATCH /branches/:id` flip a
   * branch's existence as a side effect of changing its phone number.
   *
   * Deliberately does NOT revive the branch's contacts, documents or project links. `remove()`
   * deactivated those as a cascade, and a re-import says the *branch* exists again — it says
   * nothing about whether a two-year-old contact list or a closed project's link should come back.
   * Reviving those silently would restore stale records nobody asked for; the branch alone is what
   * the file asserts.
   */
  async restoreArchived(id: string, userId: string): Promise<BranchEntity> {
    /**
     * Read straight from the repository, not through `findOne`.
     *
     * `BranchQueryService.findOne` ends `.andWhere('branch.isActive = true')` — correctly, it backs
     * the detail view — so it cannot see the very row this method exists to bring back. Called that
     * way, restoring an archived branch threw `Branch <uuid> not found.` and the importer recorded
     * the row as skipped: the duplicate was gone, but so was the branch.
     */
    const branch = await this.branchRepository.findOne({ where: { id } });
    if (!branch) throw new NotFoundException(`Branch ${id} not found.`);
    if (branch.isActive) return branch;

    branch.isActive = true;
    branch.updatedBy = userId;
    const saved = await this.branchRepository.save(branch);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'BRANCH_RESTORED',
      entityType: 'BRANCH',
      entityId: saved.id,
      userId,
      remarks: `Restored archived branch ${saved.name} (${saved.solId}) — named again by an import.`,
    });

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
  /**
   * `importExcel` was removed. There is one branch-sheet importer now:
   * `ProjectService.uploadBranchesFromExcel`, reached through
   * `project/branch-import.controller.ts` for a client's branch master and through
   * `POST /projects/:id/branches/upload` for a project.
   *
   * This one ran a geography check, a `findOne` and a geocode per row inside the HTTP request —
   * thousands of sequential round trips on the real 3,759-row client file, against a 300-second
   * socket timeout. The comment that used to sit on its geocoding line said it plainly:
   * *"door into the same table, geocoded every row. Two importers, two answers."*
   */


  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Is this SOL ID already spoken for on this client — including by an archived branch?
   *
   * The `WHERE is_active = true` that used to be here (and is still on the database's unique index,
   * `UQ_branches_client_sol_id`) is what let a branch be duplicated: archive branch 4021, re-import
   * or re-create it, and a *second* row appears with the same client and SOL ID beside the archived
   * original. Postgres allows it because the partial index does not constrain inactive rows, and
   * nothing in the code looked. The result is two branches the operator cannot tell apart, one of
   * which carries all the history.
   *
   * Deliberately not fixed by widening the index: archived rows really do need to coexist with a
   * live successor in some estates, and a migration that fails on production data at deploy time is
   * a worse outcome than a check in the one place that creates them. The index still guards the
   * live set; this guards against reviving the ambiguity.
   *
   * @param excludeId A branch that may legitimately hold this SOL ID — itself, when editing.
   */
  private async findBySolId(solId: string, clientId: string, excludeId?: string): Promise<BranchEntity | null> {
    const found = await this.branchRepository.find({
      where: { solId, clientId },
      select: ['id', 'name', 'isActive'],
      take: 2,
    });
    return found.find((b) => b.id !== excludeId) ?? null;
  }

  /**
   * The refusal, worded for whoever is looking at the screen.
   *
   * An archived match gets its own sentence because the operator has no way to discover it — the
   * branch is not in any list they can see, so "already used by another branch" reads as a bug in
   * the system rather than as a fact about their own data.
   */
  private solIdConflict(solId: string, existing: BranchEntity): ConflictException {
    return new ConflictException(
      existing.isActive
        ? `SOL ID '${solId}' is already used by "${existing.name}" for this client.`
        : `SOL ID '${solId}' belongs to "${existing.name}", an archived branch of this client. `
          + 'Restore that branch instead of creating a second one, or give this branch a different SOL ID — '
          + 'two branches sharing a SOL ID cannot be told apart by any later import.',
    );
  }

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
