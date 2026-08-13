import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
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
import { EventCategory, resolveRegion } from '@fapoms/shared';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import { autocompleteIndia } from '../geo/india-autocomplete.helper';
import { geocodeIndia } from '../geo/india-geocoder';
import { resolveCoordinates, GeoFields } from '../geo/coordinate-resolution';

async function geocodeAddress(address: string, city: string, district: string, state: string, pincode?: string | null): Promise<{ lat: number; lng: number } | null> {
  const res = await geocodeIndia(address, city, district, state, pincode);
  return res ? { lat: res.lat, lng: res.lng } : null;
}

export interface CreateBranchDto {
  branchCode: string;
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
  designation: string;
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
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // -----------------------------------------------------------------------
  // Branch Profile
  // -----------------------------------------------------------------------

  async create(dto: CreateBranchDto, userId: string, organizationId?: string | null): Promise<BranchEntity> {
    await this.validateGeography(dto.state, dto.district, dto.city);

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
      branchCode: dto.branchCode,
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
  ): Promise<{ branches: BranchEntity[]; total: number }> {
    return this.branchQueryService.findAll(page, limit, scope);
  }

  async scopeFacets(scope: Partial<GlobalScope> = {}) {
    return this.branchQueryService.scopeFacets(scope);
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
      designation: dto.designation,
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
    const mapping = client.configuration?.importMapping;

    if (!mapping || Object.keys(mapping).length === 0) {
      throw new BadRequestException('Client import mappings are not configured.');
    }

    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet);

    const errors: string[] = [];
    let importedCount = 0;

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const rowNum = index + 2;

      try {
        const branchCode = String(row[mapping['branchCode'] || 'Branch Code'] || '').trim();
        const solId = String(row[mapping['solId'] || 'SOL ID'] || '').trim();
        const name = String(row[mapping['name'] || 'Branch Name'] || '').trim();
        const address = String(row[mapping['address'] || 'Address'] || '').trim();
        const state = String(row[mapping['state'] || 'State'] || '').trim();
        const district = String(row[mapping['district'] || 'District'] || '').trim();
        const city = String(row[mapping['city'] || 'City'] || '').trim();
        const pincode = String(row[mapping['pincode'] || 'Pincode'] || '').trim();
        const latitude = parseFloat(row[mapping['latitude'] || 'Latitude']);
        const longitude = parseFloat(row[mapping['longitude'] || 'Longitude']);

        if (!branchCode || !name || !address || !state || !district || !city) {
          errors.push(`Row ${rowNum}: Missing required fields`);
          continue;
        }

        try {
          await this.validateGeography(state, district, city);
        } catch (geoErr: any) {
          errors.push(`Row ${rowNum}: Geography validation failed - ${geoErr.message}`);
          continue;
        }

        const existing = await this.branchRepository.findOne({
          where: { branchCode, clientId, isActive: true },
        });

        if (existing) {
          existing.name = name;
          existing.address = address;
          existing.state = state;
          existing.district = district;
          existing.city = city;
          existing.pincode = pincode || null;
          existing.latitude = isNaN(latitude) ? null : latitude;
          existing.longitude = isNaN(longitude) ? null : longitude;
          existing.updatedBy = userId;
          if (!isNaN(latitude) && !isNaN(longitude)) {
            existing.location = { type: 'Point', coordinates: [longitude, latitude] };
          }
          await this.branchRepository.save(existing);
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
            latitude: isNaN(latitude) ? null : latitude,
            longitude: isNaN(longitude) ? null : longitude,
            clientId,
            location: (!isNaN(latitude) && !isNaN(longitude)) ? { type: 'Point', coordinates: [longitude, latitude] } : null,
            createdBy: userId,
            updatedBy: userId,
          });
          await this.branchRepository.save(branch);
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
    if (!district?.trim() || !city?.trim()) {
      // Nothing to cross-check the state against, so confirm the state alone is real.
      const stateKnown = await this.stateRepository.findOne({ where: { name: state } });
      if (stateKnown) return;
      const stateLive = await autocompleteIndia(state);
      if (!stateLive.some((p) => p.type === 'state' || p.state.toLowerCase() === state.toLowerCase())) {
        throw new BadRequestException(
          `Could not verify '${state}' as a real state. Check the spelling — it sets the region, zone and holiday calendar for this branch.`,
        );
      }
      return;
    }

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
