import { Injectable, NotFoundException, ConflictException, BadRequestException, OnModuleInit, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, In } from 'typeorm';
import * as xlsx from 'xlsx';
import * as bcrypt from 'bcrypt';
import * as fs from 'fs';
import * as path from 'path';
import { AssayerEntity } from './assayer.entity';
import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from './workforce-attribute.entity';
import { AssayerGovernmentDocumentEntity } from './assayer-government-document.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerRemarkEntity } from './assayer-remark.entity';
import { AssayerActivityEntity } from './assayer-activity.entity';
import { AuditService } from '../../core/audit/audit.service';
import { AssayerStateMachine } from './assayer.state-machine';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { EventCategory, AssayerLifecycleStatus, AssayerStatus, AssignmentStatus, SystemRole } from '@fapoms/shared';

// Shared with the branch geocoder: one cache means a district or pincode looked up
// for a branch is free when an assayer in the same place is imported.
const GEO_CACHE_FILE = path.join(__dirname, '../../infrastructure/database/geocoding-cache.json');
let geoCache: Record<string, { lat: number; lng: number }> = {};
try {
  if (fs.existsSync(GEO_CACHE_FILE)) geoCache = JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8'));
} catch { /* start with an empty cache */ }
function saveGeoCache() {
  try { fs.writeFileSync(GEO_CACHE_FILE, JSON.stringify(geoCache, null, 2), 'utf8'); } catch { /* non-fatal */ }
}

/**
 * Resolves an assayer's home coordinates.
 *
 * Previously this built a single hyper-specific query — the full door-number
 * street address plus city plus district plus state — which Nominatim cannot
 * match for a residential address, so it returned null for essentially every
 * assayer and the caller silently substituted a hardcoded Mumbai coordinate.
 * The result looked like real data: 25 assayers all sitting on one pin, every
 * distance calculation wrong, and every distance-based filter and score in the
 * recommendation engine operating on fiction.
 *
 * Now it narrows progressively, matching how the branch geocoder already works:
 * a 6-digit pincode is the most precise thing a residential address reliably
 * carries, then locality, then district, then state. The first hit wins, so a
 * pincode gives a genuinely pin-point location and the wider queries only act as
 * a floor. Results are cached on disk because Nominatim is rate-limited to
 * roughly one request per second.
 *
 * Returns null when nothing resolves. The caller must treat that as "unknown"
 * rather than inventing a location.
 */
async function geocodeAddress(
  address: string,
  city: string,
  district: string,
  state: string,
): Promise<{ lat: number; lng: number } | null> {
  const pincode = (address || '').match(/\b\d{6}\b/)?.[0] ?? null;

  const queries = [
    pincode ? `${pincode}, India` : null,
    city && district ? `${city}, ${district}, ${state}, India` : null,
    city ? `${city}, ${state}, India` : null,
    district ? `${district}, ${state}, India` : null,
    state ? `${state}, India` : null,
  ].filter((q): q is string => !!q && q.trim().length > 6);

  for (const q of queries) {
    const key = q.replace(/\s+/g, ' ').trim();
    if (geoCache[key]) return geoCache[key];

    // Nominatim's usage policy is ~1 req/sec; exceeding it gets the caller blocked.
    await new Promise((r) => setTimeout(r, 1100));
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(key)}&format=json&limit=1&countrycodes=in`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'fapoms-production-geocoder/1.0 (info@fapoms.com)' },
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = (await res.json()) as any[];
        if (data?.[0]) {
          const coords = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
          geoCache[key] = coords;
          saveGeoCache();
          return coords;
        }
      }
    } catch {
      // Try the next, broader query rather than failing the whole import.
    }
  }
  return null;
}

const LIFECYCLE_TRANSITIONS: Record<string, string[]> = {
  [AssayerLifecycleStatus.INVITED]: [AssayerLifecycleStatus.DOCUMENT_VERIFICATION],
  [AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: [AssayerLifecycleStatus.BACKGROUND_VERIFICATION, AssayerLifecycleStatus.INACTIVE],
  [AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: [AssayerLifecycleStatus.TRAINING, AssayerLifecycleStatus.INACTIVE],
  [AssayerLifecycleStatus.TRAINING]: [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.INACTIVE],
  [AssayerLifecycleStatus.ACTIVE]: [AssayerLifecycleStatus.ON_LEAVE, AssayerLifecycleStatus.SUSPENDED, AssayerLifecycleStatus.INACTIVE, AssayerLifecycleStatus.RESIGNED],
  [AssayerLifecycleStatus.ON_LEAVE]: [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.INACTIVE],
  [AssayerLifecycleStatus.SUSPENDED]: [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.TERMINATED],
  [AssayerLifecycleStatus.INACTIVE]: [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.ARCHIVED],
  [AssayerLifecycleStatus.RESIGNED]: [AssayerLifecycleStatus.ARCHIVED],
  [AssayerLifecycleStatus.TERMINATED]: [AssayerLifecycleStatus.ARCHIVED],
};

function mapLifecycleToOperationalStatus(lifecycle: string): string {
  if (lifecycle === AssayerLifecycleStatus.ACTIVE || lifecycle === AssayerLifecycleStatus.ON_LEAVE) return 'ACTIVE';
  if (lifecycle === AssayerLifecycleStatus.SUSPENDED) return 'SUSPENDED';
  return 'INACTIVE';
}

export interface CreateAssayerDto {
  assayerCode: string;
  employeeId?: string;
  employeeCode?: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone: string;
  alternatePhone?: string;
  address: string;
  state: string;
  district: string;
  city: string;
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
}

export interface UpdateAssayerDto {
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
  organizationId?: string;
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
}

export interface CreateGovernmentDocumentDto {
  documentType: string;
  documentNumber: string;
  expiryDate?: string;
  filePaths?: string[];
  remarks?: string;
}

export interface UpdateGovernmentDocumentDto {
  documentNumber?: string;
  expiryDate?: string | null;
  verificationStatus?: string;
  verifiedBy?: string;
  filePaths?: string[];
  remarks?: string;
}

export interface CreateAssayerDocumentDto {
  documentType: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType?: string;
  parentDocumentId?: string;
  remarks?: string;
}

export interface CreateRemarkDto {
  content: string;
  category: string;
  visibility: string;
  attachmentPaths?: string[];
  rating?: number;
}

export interface UpdateRemarkDto {
  content?: string;
  category?: string;
  visibility?: string;
  attachmentPaths?: string[];
  rating?: number;
}

export interface UpdateAssayerDocumentDto {
  documentType?: string;
  fileName?: string;
  filePath?: string;
  fileSize?: number;
  mimeType?: string;
  remarks?: string;
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
    @InjectRepository(AssayerGovernmentDocumentEntity)
    private readonly govDocRepository: Repository<AssayerGovernmentDocumentEntity>,
    @InjectRepository(AssayerDocumentEntity)
    private readonly assayerDocRepository: Repository<AssayerDocumentEntity>,
    @InjectRepository(AssayerRemarkEntity)
    private readonly remarkRepository: Repository<AssayerRemarkEntity>,
    @InjectRepository(AssayerActivityEntity)
    private readonly activityRepository: Repository<AssayerActivityEntity>,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly workflowEngine: WorkflowEngine,
  ) {}

  onModuleInit() {
    this.workflowEngine.registerWorkflow('assayer', [
      { from: [AssayerLifecycleStatus.INVITED], to: AssayerLifecycleStatus.DOCUMENT_VERIFICATION },
      { from: [AssayerLifecycleStatus.DOCUMENT_VERIFICATION], to: AssayerLifecycleStatus.BACKGROUND_VERIFICATION },
      { from: [AssayerLifecycleStatus.DOCUMENT_VERIFICATION], to: AssayerLifecycleStatus.INACTIVE },
      { from: [AssayerLifecycleStatus.BACKGROUND_VERIFICATION], to: AssayerLifecycleStatus.TRAINING },
      { from: [AssayerLifecycleStatus.BACKGROUND_VERIFICATION], to: AssayerLifecycleStatus.INACTIVE },
      { from: [AssayerLifecycleStatus.TRAINING], to: AssayerLifecycleStatus.ACTIVE },
      { from: [AssayerLifecycleStatus.TRAINING], to: AssayerLifecycleStatus.INACTIVE },
      { from: [AssayerLifecycleStatus.ACTIVE], to: AssayerLifecycleStatus.ON_LEAVE },
      { from: [AssayerLifecycleStatus.ACTIVE], to: AssayerLifecycleStatus.SUSPENDED },
      { from: [AssayerLifecycleStatus.ACTIVE], to: AssayerLifecycleStatus.INACTIVE },
      { from: [AssayerLifecycleStatus.ACTIVE], to: AssayerLifecycleStatus.RESIGNED },
      { from: [AssayerLifecycleStatus.ON_LEAVE], to: AssayerLifecycleStatus.ACTIVE },
      { from: [AssayerLifecycleStatus.ON_LEAVE], to: AssayerLifecycleStatus.INACTIVE },
      { from: [AssayerLifecycleStatus.SUSPENDED], to: AssayerLifecycleStatus.ACTIVE },
      { from: [AssayerLifecycleStatus.SUSPENDED], to: AssayerLifecycleStatus.TERMINATED },
      { from: [AssayerLifecycleStatus.INACTIVE], to: AssayerLifecycleStatus.ACTIVE },
      { from: [AssayerLifecycleStatus.INACTIVE], to: AssayerLifecycleStatus.ARCHIVED },
      { from: [AssayerLifecycleStatus.RESIGNED], to: AssayerLifecycleStatus.ARCHIVED },
      { from: [AssayerLifecycleStatus.TERMINATED], to: AssayerLifecycleStatus.ARCHIVED },
    ]);
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

  private async syncWorkforceAttributes(assayerId: string, dto: CreateAssayerDto | UpdateAssayerDto, userId: string): Promise<void> {
    const syncedFields = ['skills', 'certifications', 'languages', 'specializations'] as const;
    const hasAny = syncedFields.some(f => (dto as any)[f] !== undefined);
    if (!hasAny) return;

    // Remove old workforce attrs for these types
    await this.workforceAttributeRepository.delete({
      assayerId,
      type: In(['SKILL', 'CERTIFICATION', 'LANGUAGE', 'SPECIALIZATION']),
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

  async findAll(page = 1, limit = 50): Promise<{ assayers: AssayerEntity[]; total: number }> {
    const [assayers, total] = await this.assayerRepository.findAndCount({
      where: { isActive: true },
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

  async create(dto: CreateAssayerDto, userId: string, organizationId?: string | null): Promise<AssayerEntity> {
    const existing = await this.assayerRepository.findOne({ where: { assayerCode: dto.assayerCode } });
    if (existing) throw new ConflictException(`Assayer code ${dto.assayerCode} already exists.`);

    let lat = dto.latitude;
    let lng = dto.longitude;
    if (!lat || !lng) {
      const coords = await geocodeAddress(dto.address, dto.city, dto.district, dto.state);
      // Left null when nothing resolves. This used to fall back to a hardcoded
      // Mumbai coordinate, which is worse than no location at all: the assayer
      // appears on the map somewhere they have never been, and every distance
      // filter and travel-cost calculation silently uses that fiction. An unknown
      // location is visible and fixable; a plausible wrong one is neither.
      lat = coords?.lat ?? undefined;
      lng = coords?.lng ?? undefined;
      if (!coords) {
        this.logger.warn(
          `Assayer ${dto.assayerCode}: could not resolve coordinates from "${dto.address}" ` +
          `(${dto.city}, ${dto.district}, ${dto.state}). Saved without a location — ` +
          `they will not appear on the map and distance-based matching will skip them.`,
        );
      }
    }
    const location = { type: 'Point', coordinates: [lng, lat] };

    const assayer = this.assayerRepository.create({
      ...dto,
      joiningDate: dto.joiningDate ? new Date(dto.joiningDate) : null,
      displayName: `${dto.firstName} ${dto.lastName}`,
      latitude: lat,
      longitude: lng,
      location,
      lifecycleStatus: AssayerLifecycleStatus.INVITED,
      status: AssayerStatus.INACTIVE,
      organizationId: organizationId ?? null,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.assayerRepository.save(assayer);
    await this.syncWorkforceAttributes(saved.id, dto, userId);
    await this.recordActivity(saved.id, 'ASSAYER_CREATED', null, AssayerLifecycleStatus.INVITED, userId, 'Assayer profile created');
    await this.auditService.recordEvent({
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
    Object.keys(dto).forEach((key) => {
      if ((dto as any)[key] !== undefined) (assayer as any)[key] = (dto as any)[key];
    });
    if (dto.firstName || dto.lastName) {
      assayer.displayName = `${dto.firstName ?? assayer.firstName} ${dto.lastName ?? assayer.lastName}`;
    }
    if (dto.joiningDate) assayer.joiningDate = new Date(dto.joiningDate);
    if (dto.exitDate) assayer.exitDate = new Date(dto.exitDate);
    if (dto.terminationDate) assayer.terminationDate = new Date(dto.terminationDate);
    let lat = dto.latitude !== undefined ? dto.latitude : assayer.latitude;
    let lng = dto.longitude !== undefined ? dto.longitude : assayer.longitude;

    const addressChanged = dto.address !== undefined && dto.address !== assayer.address;
    const cityChanged = dto.city !== undefined && dto.city !== assayer.city;
    const districtChanged = dto.district !== undefined && dto.district !== assayer.district;
    const stateChanged = dto.state !== undefined && dto.state !== assayer.state;

    if ((addressChanged || cityChanged || districtChanged || stateChanged) && dto.latitude === undefined && dto.longitude === undefined) {
      const coords = await geocodeAddress(
        dto.address ?? assayer.address,
        dto.city ?? assayer.city,
        dto.district ?? assayer.district,
        dto.state ?? assayer.state
      );
      if (coords) {
        lat = coords.lat;
        lng = coords.lng;
      }
    }

    if (lat && lng) {
      assayer.latitude = lat;
      assayer.longitude = lng;
      (assayer as any).location = { type: 'Point', coordinates: [lng, lat] };
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

  async remove(id: string, userId: string): Promise<void> {
    const assayer = await this.findOne(id);
    assayer.isActive = false;
    assayer.updatedBy = userId;
    await this.assayerRepository.save(assayer);
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_DELETED',
      entityType: 'ASSAYER',
      entityId: id,
      userId,
      remarks: `Soft deleted assayer profile ${assayer.displayName}`,
    });
    await this.eventPublisher.publish('assayer:deleted', {
      eventType: 'assayer:deleted',
      aggregateId: id,
      userId,
      organizationId: assayer.organizationId,
      payload: { id, displayName: assayer.displayName },
    });
  }

  async transitionLifecycle(id: string, targetStatus: string, userId: string, reason?: string): Promise<AssayerEntity> {
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

  private async doTransitionLifecycle(
    id: string,
    targetStatus: AssayerLifecycleStatus,
    userId: string,
    reason?: string,
    role = SystemRole.SUPER_ADMINISTRATOR,
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
        await this.recordActivity(saved.id, 'LIFECYCLE_TRANSITION', currentStatus, targetStatus, userId, reason || null);
        await this.auditService.recordEvent({
          category: EventCategory.OPERATIONAL,
          eventType: 'ASSAYER_LIFECYCLE_TRANSITION',
          entityType: 'ASSAYER',
          entityId: saved.id,
          previousState: currentStatus,
          newState: targetStatus,
          userId,
          remarks: reason || `Lifecycle transition: ${currentStatus} → ${targetStatus}`,
        });
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

  // ---- Government Documents ----

  async addGovernmentDocument(assayerId: string, dto: CreateGovernmentDocumentDto, userId: string): Promise<AssayerGovernmentDocumentEntity> {
    await this.findOne(assayerId);
    const existing = await this.govDocRepository.findOne({ where: { assayerId, documentType: dto.documentType, isActive: true } });
    if (existing) throw new ConflictException(`Active ${dto.documentType} document already exists for this assayer. Remove the existing document before adding a new one.`);
    const doc = this.govDocRepository.create({
      assayerId,
      ...dto,
      expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
      filePaths: dto.filePaths || [],
      verificationStatus: 'PENDING',
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.govDocRepository.save(doc);
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'GOVERNMENT_DOCUMENT_ADDED',
      entityType: 'ASSAYER_GOVERNMENT_DOCUMENT',
      entityId: saved.id,
      userId,
      remarks: `Added ${dto.documentType} document for assayer ${assayerId}`,
    });
    await this.recordActivity(assayerId, 'GOVERNMENT_DOCUMENT_ADDED', null, null, userId, `Added ${dto.documentType} document`);
    return saved;
  }

  async updateGovernmentDocument(docId: string, dto: UpdateGovernmentDocumentDto, userId: string): Promise<AssayerGovernmentDocumentEntity> {
    const doc = await this.govDocRepository.findOne({ where: { id: docId, isActive: true } });
    if (!doc) throw new NotFoundException(`Government document ${docId} not found.`);
    if (dto.documentNumber !== undefined) doc.documentNumber = dto.documentNumber;
    if (dto.expiryDate !== undefined) doc.expiryDate = dto.expiryDate ? new Date(dto.expiryDate) : null;
    if (dto.verificationStatus !== undefined) {
      doc.verificationStatus = dto.verificationStatus;
      if (dto.verificationStatus === 'VERIFIED' || dto.verificationStatus === 'REJECTED') {
        doc.verifiedAt = new Date();
        doc.verifiedBy = dto.verifiedBy || userId;
      }
    }
    if (dto.filePaths !== undefined) doc.filePaths = dto.filePaths;
    if (dto.remarks !== undefined) doc.remarks = dto.remarks;
    doc.updatedBy = userId;
    const saved = await this.govDocRepository.save(doc);
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'GOVERNMENT_DOCUMENT_UPDATED',
      entityType: 'ASSAYER_GOVERNMENT_DOCUMENT',
      entityId: saved.id,
      userId,
      remarks: `Updated ${doc.documentType} document status: ${doc.verificationStatus}`,
    });
    await this.recordActivity(doc.assayerId, 'GOVERNMENT_DOCUMENT_UPDATED', null, null, userId, `Updated ${doc.documentType} document`);
    return saved;
  }

  async getGovernmentDocuments(assayerId: string): Promise<AssayerGovernmentDocumentEntity[]> {
    return this.govDocRepository.find({
      where: { assayerId, isActive: true },
      order: { documentType: 'ASC' },
    });
  }

  async removeGovernmentDocument(docId: string, userId: string): Promise<void> {
    const doc = await this.govDocRepository.findOne({ where: { id: docId, isActive: true } });
    if (!doc) throw new NotFoundException(`Government document ${docId} not found.`);
    doc.isActive = false;
    doc.updatedBy = userId;
    await this.govDocRepository.save(doc);
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'GOVERNMENT_DOCUMENT_REMOVED',
      entityType: 'ASSAYER_GOVERNMENT_DOCUMENT',
      entityId: docId,
      userId,
      remarks: `Removed ${doc.documentType} document`,
    });
    await this.recordActivity(doc.assayerId, 'GOVERNMENT_DOCUMENT_REMOVED', null, null, userId, `Removed ${doc.documentType} document`);
  }

  // ---- Assayer Documents ----

  async addAssayerDocument(assayerId: string, dto: CreateAssayerDocumentDto, userId: string): Promise<AssayerDocumentEntity> {
    await this.findOne(assayerId);
    let docVersion = 1;
    if (dto.parentDocumentId) {
      const parent = await this.assayerDocRepository.findOne({ where: { id: dto.parentDocumentId } });
      if (parent) docVersion = parent.docVersion + 1;
    }
    const doc = this.assayerDocRepository.create({
      assayerId,
      ...dto,
      docVersion,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.assayerDocRepository.save(doc);
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_DOCUMENT_ADDED',
      entityType: 'ASSAYER_DOCUMENT',
      entityId: saved.id,
      userId,
      remarks: `Added ${dto.documentType} (v${docVersion}) for assayer ${assayerId}`,
    });
    await this.recordActivity(assayerId, 'ASSAYER_DOCUMENT_ADDED', null, null, userId, `Added ${dto.documentType} (v${docVersion})`);
    return saved;
  }

  async getAssayerDocuments(assayerId: string): Promise<AssayerDocumentEntity[]> {
    return this.assayerDocRepository.find({
      where: { assayerId, isActive: true },
      order: { documentType: 'ASC', docVersion: 'DESC' },
    });
  }

  async updateAssayerDocument(docId: string, dto: UpdateAssayerDocumentDto, userId: string): Promise<AssayerDocumentEntity> {
    const doc = await this.assayerDocRepository.findOne({ where: { id: docId, isActive: true } });
    if (!doc) throw new NotFoundException(`Assayer document ${docId} not found.`);
    if (dto.documentType !== undefined) doc.documentType = dto.documentType;
    if (dto.fileName !== undefined) doc.fileName = dto.fileName;
    if (dto.filePath !== undefined) doc.filePath = dto.filePath;
    if (dto.fileSize !== undefined) doc.fileSize = dto.fileSize;
    if (dto.mimeType !== undefined) doc.mimeType = dto.mimeType;
    if (dto.remarks !== undefined) doc.remarks = dto.remarks;
    doc.updatedBy = userId;
    const saved = await this.assayerDocRepository.save(doc);
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_DOCUMENT_UPDATED',
      entityType: 'ASSAYER_DOCUMENT',
      entityId: docId,
      userId,
      remarks: `Updated ${doc.documentType} document (v${doc.docVersion})`,
    });
    await this.recordActivity(doc.assayerId, 'ASSAYER_DOCUMENT_UPDATED', null, null, userId, `Updated ${doc.documentType} document`);
    return saved;
  }

  async removeAssayerDocument(docId: string, userId: string): Promise<void> {
    const doc = await this.assayerDocRepository.findOne({ where: { id: docId, isActive: true } });
    if (!doc) throw new NotFoundException(`Assayer document ${docId} not found.`);
    doc.isActive = false;
    doc.updatedBy = userId;
    await this.assayerDocRepository.save(doc);
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_DOCUMENT_REMOVED',
      entityType: 'ASSAYER_DOCUMENT',
      entityId: docId,
      userId,
      remarks: `Removed ${doc.documentType} document (v${doc.docVersion})`,
    });
    await this.recordActivity(doc.assayerId, 'ASSAYER_DOCUMENT_REMOVED', null, null, userId, `Removed ${doc.documentType} document`);
  }

  // ---- Remarks ----

  async addRemark(assayerId: string, dto: CreateRemarkDto, userId: string, userName: string): Promise<AssayerRemarkEntity> {
    await this.findOne(assayerId);
    const remark = this.remarkRepository.create({
      assayerId,
      authorId: userId,
      authorName: userName,
      content: dto.content,
      category: dto.category,
      visibility: dto.visibility,
      attachmentPaths: dto.attachmentPaths || [],
      rating: dto.rating ?? null,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.remarkRepository.save(remark);
    if (dto.rating != null) {
      await this.recomputeAverageRating(assayerId);
    }
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_REMARK_ADDED',
      entityType: 'ASSAYER_REMARK',
      entityId: saved.id,
      userId,
      remarks: `Remark added for assayer ${assayerId} (${dto.category})`,
    });
    await this.recordActivity(assayerId, 'ASSAYER_REMARK_ADDED', null, null, userId, `Remark added (${dto.category})`);
    return saved;
  }

  async updateRemark(remarkId: string, dto: UpdateRemarkDto, userId: string): Promise<AssayerRemarkEntity> {
    const remark = await this.remarkRepository.findOne({ where: { id: remarkId, isActive: true } });
    if (!remark) throw new NotFoundException(`Remark ${remarkId} not found.`);
    if (dto.content !== undefined) remark.content = dto.content;
    if (dto.category !== undefined) remark.category = dto.category;
    if (dto.visibility !== undefined) remark.visibility = dto.visibility;
    if (dto.attachmentPaths !== undefined) remark.attachmentPaths = dto.attachmentPaths;
    if (dto.rating !== undefined) remark.rating = dto.rating;
    remark.updatedBy = userId;
    const saved = await this.remarkRepository.save(remark);
    if (dto.rating !== undefined) {
      await this.recomputeAverageRating(remark.assayerId);
    }
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_REMARK_UPDATED',
      entityType: 'ASSAYER_REMARK',
      entityId: remarkId,
      userId,
      remarks: `Remark updated for assayer ${remark.assayerId}`,
    });
    await this.recordActivity(remark.assayerId, 'ASSAYER_REMARK_UPDATED', null, null, userId, `Remark updated`);
    return saved;
  }

  async removeRemark(remarkId: string, userId: string): Promise<void> {
    const remark = await this.remarkRepository.findOne({ where: { id: remarkId, isActive: true } });
    if (!remark) throw new NotFoundException(`Remark ${remarkId} not found.`);
    remark.isActive = false;
    remark.updatedBy = userId;
    await this.remarkRepository.save(remark);
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_REMARK_REMOVED',
      entityType: 'ASSAYER_REMARK',
      entityId: remarkId,
      userId,
      remarks: `Remark removed for assayer ${remark.assayerId}`,
    });
    await this.recordActivity(remark.assayerId, 'ASSAYER_REMARK_REMOVED', null, null, userId, `Remark removed`);
  }

  async getRemarks(assayerId: string, visibility?: string, page = 1, limit = 20): Promise<{ remarks: AssayerRemarkEntity[]; total: number }> {
    const where: any = { assayerId, isActive: true };
    if (visibility) where.visibility = visibility;
    const [remarks, total] = await this.remarkRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { remarks, total };
  }

  // ---- Stats & Profile ----

  async recomputeAverageRating(assayerId: string): Promise<void> {
    const result = await this.remarkRepository
      .createQueryBuilder('r')
      .select('AVG(r.rating)', 'avg')
      .where('r.assayerId = :assayerId', { assayerId })
      .andWhere('r.rating IS NOT NULL')
      .andWhere('r.isActive = :isActive', { isActive: true })
      .getRawOne();
    const avg = result?.avg ? parseFloat(Number(result.avg).toFixed(2)) : 0;
    await this.assayerRepository.update(assayerId, { averageRating: avg });
  }

  async updateAssayerStats(assayerId: string): Promise<void> {
    const mgr = this.assayerRepository.manager;

    const total = await mgr.count('assignments', { where: { assayerId, isActive: true } });

    // NOTE: 'AUDIT_COMPLETED'/'VALIDATION_COMPLETED'/'CLOSED' are ProjectBranchStatus values,
    // not AssignmentStatus values — they belong only in the pb.status clause. Putting them in
    // a.status IN (...) makes Postgres reject the whole query (invalid enum value for
    // assignments_status_enum), which silently no-ops every call via the caller's catch block.
    const completedResult = await mgr.query(
      `SELECT COUNT(*) as cnt FROM assignments a
       LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
       WHERE a.assayer_id = $1 AND a.is_active = true
       AND (a.status = 'COMPLETED' OR pb.status IN ('AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'))`,
      [assayerId],
    );
    const completed = Number(completedResult[0]?.cnt ?? 0);

    const cancelled = await mgr.count('assignments', {
      where: { assayerId, status: AssignmentStatus.CANCELLED, isActive: true },
    });

    const onTimeResult = await mgr.query(
      `SELECT COUNT(*) as cnt FROM assignments a
       LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
       WHERE a.assayer_id = $1 AND a.is_active = true
       AND (a.status = 'COMPLETED' OR pb.status IN ('AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'))
       AND (a.completion_date IS NULL OR a.scheduled_date IS NULL OR a.completion_date <= a.scheduled_date)`,
      [assayerId],
    );

    // Earnings come from the billing engine's payables — the record finance
    // actually pays against — rather than being re-derived from assignment fees.
    // Summing agreed fees here produced a third rival answer (no travel, no TDS)
    // that disagreed with both the payable and what the mobile app displayed, so
    // the assayer, the app and finance each saw a different number for one job.
    // Falls back to the fee-based estimate only for work not yet booked as payable.
    const earningsResult = await mgr.query(
      `SELECT COALESCE(
                (SELECT SUM(p.total_amount) FROM assayer_payables p
                  WHERE p.assayer_id = $1 AND p.is_active = true
                    AND p.status NOT IN ('DISPUTED', 'ON_HOLD')),
                (SELECT SUM(COALESCE(a.agreed_fee, a.proposed_fee)) FROM assignments a
                   LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
                  WHERE a.assayer_id = $1 AND a.is_active = true
                    AND (a.status IN ('ACCEPTED', 'COMPLETED')
                         OR pb.status IN ('ASSIGNMENT_CONFIRMED', 'AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'))),
                0
              ) as total`,
      [assayerId],
    );

    const lastAssignment = await mgr.query(
      `SELECT updated_at FROM assignments a
       WHERE a.assayer_id = $1 AND a.is_active = true
       ORDER BY a.updated_at DESC LIMIT 1`,
      [assayerId],
    );

    await this.assayerRepository.update(assayerId, {
      totalAssignments: total,
      completedAssignments: completed,
      cancelledAssignments: cancelled,
      onTimeCompletions: Number(onTimeResult[0]?.cnt ?? 0),
      totalEarnings: Number(earningsResult[0]?.total ?? 0),
      lastAssignmentDate: lastAssignment[0]?.updated_at ?? null,
    });
    await this.recomputeAverageRating(assayerId);
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

    // Money still owed to this assayer, derived from real payables in the billing
    // engine. This used to be a `running_balance` column on the assayer that only
    // the (now removed) ledger module wrote, via a code path that never ran — so it
    // read 0 for everyone and the mobile earnings card never displayed.
    const balanceRes = await mgr.query(
      `SELECT COALESCE(SUM(total_amount - paid_amount), 0) AS owed,
              COALESCE(SUM(paid_amount), 0)                AS paid,
              COALESCE(SUM(total_amount) FILTER (WHERE status = 'PENDING'), 0) AS awaiting_approval
         FROM assayer_payables
        WHERE assayer_id = $1 AND is_active = true
          AND status NOT IN ('DISPUTED', 'ON_HOLD')`,
      [target.id],
    ).catch(() => [{ owed: 0, paid: 0, awaiting_approval: 0 }]);
    // The same three figures finance sees, so the assayer's app and the finance
    // console can never disagree about what a job was worth.
    (target as any).runningBalance = Number(balanceRes[0]?.owed ?? 0);
    (target as any).earningsPaid = Number(balanceRes[0]?.paid ?? 0);
    (target as any).earningsAwaitingApproval = Number(balanceRes[0]?.awaiting_approval ?? 0);

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
    await this.recordActivity(assayerId, 'COMMERCIAL_PROFILE_CREATED', null, null, userId, `Commercial profile created with base fee ₹${dto.baseFee}`);
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
    await this.recordActivity(profile.assayerId, 'COMMERCIAL_PROFILE_UPDATED', null, null, userId, `Commercial profile updated`);
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

  // ---- Workforce Attributes ----

  async addWorkforceAttribute(assayerId: string, dto: any, userId: string): Promise<WorkforceAttributeEntity> {
    await this.findOne(assayerId);
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
      eventType: 'WORKFORCE_ATTRIBUTE_DELETED',
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
      // Required — the record cannot function without these
      'Assayer code', 'Assayer Name', 'Phone', 'Residence Address', 'Initial Password',
      // Location / coverage
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
      { Field: 'Phone', Required: 'Yes', Description: "The assayer's login identifier AND how dispatch notifications reach them. A record without it cannot be used." },
      { Field: 'Residence Address', Required: 'Yes', Description: 'Full address. Used to compute travel distance to branches; a 6-digit pincode inside this text is picked up automatically.' },
      { Field: 'Initial Password', Required: 'No', Description: "Password the assayer signs in with. Defaults to 'assayer123' when blank. Only applied when the assayer is first created — re-importing a roster never resets an existing password." },
      { Field: 'Location', Required: 'No', Description: 'Town or locality, e.g. Kunnamangalam. Stored as the city.' },
      { Field: 'District', Required: 'No', Description: 'Used for travel distance and coverage planning.' },
      { Field: 'State', Required: 'No', Description: 'Used to apply state-specific public holidays to this assayer.' },
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

  async uploadFromExcel(fileBuffer: Buffer, userId: string): Promise<{ importedCount: number; errors: string[] }> {
    const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows: any[] = xlsx.utils.sheet_to_json(worksheet);

    const errors: string[] = [];
    let importedCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      try {
        // Accepts both the canonical header and the spelling used in the client's
        // own roster ("Assayer code"), so a file exported from their system imports
        // without being hand-edited first.
        const assayerCode = (row['Assayer Code'] || row['Assayer code'] || '').toString().trim();
        if (!assayerCode) {
          errors.push(`Row ${rowNum}: Assayer Code is required`);
          continue;
        }

        // Rosters carry one combined name column; the record stores first/last
        // separately. Split on whitespace, treating the final token as the surname
        // and everything before it as the given name, so "R Jeganathan" and
        // "Shinil T" both resolve sensibly.
        let firstName = (row['First Name'] || '').toString().trim();
        let lastName = (row['Last Name'] || '').toString().trim();
        const combinedName = (row['Assayer Name'] || row['Name'] || '').toString().trim();
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

        // Phone is the assayer's login identifier and the channel dispatch
        // notifications go to, so a record without one cannot actually be used.
        const phone = (row['Phone'] || row['Mobile'] || row['Contact Number'] || '').toString().trim();
        if (!phone) {
          errors.push(`Row ${rowNum} (${assayerCode}): Phone is required — it is the login identifier and how dispatch notifications reach this assayer`);
          continue;
        }

        const dto: any = {
          assayerCode,
          firstName,
          lastName,
          displayName: (row['Display Name'] || '').toString().trim() || `${firstName} ${lastName}`,
          email: (row['Email'] || '').toString().trim() || undefined,
          phone,
          alternatePhone: (row['Alternate Phone'] || '').toString().trim() || undefined,
          address: (row['Address'] || row['Residence Address'] || '').toString().trim(),
          state: (row['State'] || '').toString().trim(),
          district: (row['District'] || '').toString().trim(),
          // Rosters name the town/locality "Location"; it maps to city.
          city: (row['City'] || row['Location'] || '').toString().trim(),
          // Rosters rarely carry a separate pincode column — it is embedded in the
          // residence address, so recover it rather than dropping it.
          pincode: (row['Pincode'] || '').toString().trim()
            || (String(row['Residence Address'] || '').match(/\b\d{6}\b/)?.[0] ?? undefined),
          // Zone is the operating region on a roster. Normalised because the same
          // zone appears with inconsistent casing ("North" vs "north"), which would
          // otherwise create two distinct regions.
          region: ((row['Region'] || row['Zone'] || '').toString().trim() || undefined)
            && (row['Region'] || row['Zone']).toString().trim().replace(/\b\w/g, (c: string) => c.toUpperCase()),
          employeeId: (row['Employee ID'] || '').toString().trim() || undefined,
          employeeCode: (row['Employee Code'] || '').toString().trim() || undefined,
          employmentType: (row['Employment Type'] || '').toString().trim() || undefined,
          department: (row['Department'] || '').toString().trim() || undefined,
          joiningDate: (row['Joining Date'] || '').toString().trim() || undefined,
          panNumber: (row['PAN Number'] || '').toString().trim() || undefined,
          bankAccountNumber: (row['Bank Account Number'] || '').toString().trim() || undefined,
          ifscCode: (row['IFSC Code'] || '').toString().trim() || undefined,
          experienceYears: parseInt(row['Experience (Years)'], 10) || undefined,
          performanceRating: parseFloat(row['Performance Rating']) || undefined,
          maxDailyWorkload: parseInt(row['Max Daily Workload'], 10) || undefined,
          maxWeeklyWorkload: parseInt(row['Max Weekly Workload'], 10) || undefined,
          emergencyContactName: (row['Emergency Contact Name'] || '').toString().trim() || undefined,
          emergencyContactPhone: (row['Emergency Contact Phone'] || '').toString().trim() || undefined,
          emergencyContactRelation: (row['Emergency Contact Relation'] || '').toString().trim() || undefined,
          workingHours: undefined,
        };

        // Parse array fields
        const skills = (row['Skills (comma-separated)'] || row['Skills'] || '').toString().trim();
        if (skills) dto.skills = skills.split(',').map((s: string) => s.trim()).filter(Boolean);

        const languages = (row['Languages (comma-separated)'] || row['Languages'] || '').toString().trim();
        if (languages) dto.languages = languages.split(',').map((s: string) => s.trim()).filter(Boolean);

        const prefs = (row['Preferred Regions (comma-separated)'] || row['Preferred Regions'] || '').toString().trim();
        if (prefs) dto.preferredRegions = prefs.split(',').map((s: string) => s.trim()).filter(Boolean);

        const specializations = (row['Specializations (comma-separated)'] || row['Specializations'] || '').toString().trim();
        if (specializations) dto.specializations = specializations.split(',').map((s: string) => s.trim()).filter(Boolean);

        // Parse certifications: "Name|YYYY-MM-DD;Name2|YYYY-MM-DD"
        const certs = (row['Certifications (semicolon-separated: Name|YYYY-MM-DD)'] || row['Certifications'] || '').toString().trim();
        if (certs) {
          dto.certifications = certs.split(';').map((c: string) => {
            const [name, expiryDate] = c.split('|').map((p: string) => p.trim());
            return { name: name || c.trim(), expiryDate: expiryDate || undefined };
          }).filter((c: any) => c.name);
        }

        // Parse working hours
        const whStart = (row['Working Hours Start'] || '').toString().trim();
        const whEnd = (row['Working Hours End'] || '').toString().trim();
        if (whStart && whEnd) {
          dto.workingHours = { start: whStart, end: whEnd };
        }

        // Check if assayer exists by code
        const existing = await this.assayerRepository.findOne({ where: { assayerCode } });
        const saved = existing
          ? await this.update(existing.id, dto, userId)
          : await this.create(dto, userId);

        // A bulk-imported assayer had no password, so every one of them could be
        // created successfully and then never sign in — the import looked like it
        // worked while producing accounts that could not be used. Set an initial
        // password on creation (from the sheet if supplied, otherwise the documented
        // default) so an imported assayer can actually log in. Never overwrite an
        // existing password: re-importing a roster must not reset live credentials.
        if (!existing) {
          const supplied = (row['Initial Password'] || row['Password'] || '').toString().trim();
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
          baseFee: num(row['Base Fee']),
          dailyRate: num(row['Daily Rate']),
          hourlyRate: num(row['Hourly Rate']),
          travelReimbursement: num(row['Travel Reimbursement']),
          accommodationAllowance: num(row['Accommodation Allowance']),
          mealAllowance: num(row['Meal Allowance']),
        };
        if (Object.values(rates).some((v) => v !== undefined)) {
          const activeProfile = await this.commercialRepository.findOne({
            where: { assayerId: saved.id, isActive: true },
            order: { effectiveStartDate: 'DESC' },
          }).catch(() => null);

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

    return { importedCount, errors };
  }
}
