import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual } from 'typeorm';
import { AssayerEntity } from './assayer.entity';
import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from './workforce-attribute.entity';
import { AssayerGovernmentDocumentEntity } from './assayer-government-document.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerRemarkEntity } from './assayer-remark.entity';
import { AssayerActivityEntity } from './assayer-activity.entity';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory, AssayerLifecycleStatus } from '@fapoms/shared';

async function geocodeAddress(address: string, city: string, district: string, state: string): Promise<{ lat: number; lng: number } | null> {
  const cleanQ = `${address}, ${city || district}, ${district}, ${state}, India`
    .replace(/\s+/g, ' ')
    .trim();
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleanQ)}&format=json&limit=1&countrycodes=in`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'fapoms-production-geocoder/1.0 (info@fapoms.com)'
      }
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json() as any[];
      if (data && data[0]) {
        return {
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon)
        };
      }
    }
  } catch (err) {
    console.error(`Error geocoding inside assayer service: ${cleanQ}`, err);
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
export class AssayerService {
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
  ) {}

  async findAll(page = 1, limit = 50): Promise<{ assayers: AssayerEntity[]; total: number }> {
    const [assayers, total] = await this.assayerRepository.findAndCount({
      where: { isActive: true },
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });
    return { assayers, total };
  }

  async findOne(id: string): Promise<AssayerEntity> {
    const assayer = await this.assayerRepository.findOne({ where: { id, isActive: true } });
    if (!assayer) throw new NotFoundException(`Assayer ${id} not found.`);
    return assayer;
  }

  async create(dto: CreateAssayerDto, userId: string): Promise<AssayerEntity> {
    const existing = await this.assayerRepository.findOne({ where: { assayerCode: dto.assayerCode } });
    if (existing) throw new ConflictException(`Assayer code ${dto.assayerCode} already exists.`);

    let lat = dto.latitude;
    let lng = dto.longitude;
    if (!lat || !lng) {
      const coords = await geocodeAddress(dto.address, dto.city, dto.district, dto.state);
      if (coords) {
        lat = coords.lat;
        lng = coords.lng;
      } else {
        lat = 19.076;
        lng = 72.8777;
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
      status: 'INACTIVE',
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.assayerRepository.save(assayer);
    await this.recordActivity(saved.id, 'ASSAYER_CREATED', null, AssayerLifecycleStatus.INVITED, userId, 'Assayer profile created');
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_CREATED',
      entityType: 'ASSAYER',
      entityId: saved.id,
      userId,
      remarks: `Created assayer profile: ${saved.displayName} (${saved.assayerCode})`,
    });
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
    await this.recordActivity(saved.id, 'ASSAYER_UPDATED', null, null, userId, 'Profile updated');
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_UPDATED',
      entityType: 'ASSAYER',
      entityId: saved.id,
      userId,
      remarks: `Updated assayer profile: ${saved.displayName}`,
    });
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
  }

  async transitionLifecycle(id: string, targetStatus: string, userId: string, reason?: string): Promise<AssayerEntity> {
    const assayer = await this.findOne(id);
    const currentStatus = assayer.lifecycleStatus;
    const allowed = LIFECYCLE_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(targetStatus)) {
      throw new BadRequestException(`Invalid lifecycle transition from '${currentStatus}' to '${targetStatus}'`);
    }
    assayer.lifecycleStatus = targetStatus;
    assayer.status = mapLifecycleToOperationalStatus(targetStatus);
    assayer.updatedBy = userId;
    if (targetStatus === AssayerLifecycleStatus.ARCHIVED) assayer.isActive = false;
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

    const total = await mgr.count('assignments', { where: { assayer_id: assayerId, is_active: true } });

    const completed = await mgr.count('assignments', {
      where: { assayer_id: assayerId, status: 7, is_active: true },
    });

    const cancelled = await mgr.count('assignments', {
      where: { assayer_id: assayerId, status: 8, is_active: true },
    });

    const onTimeResult = await mgr.query(
      `SELECT COUNT(*) as cnt FROM assignments a
       WHERE a.assayer_id = $1 AND a.status = $2
       AND a.completion_date IS NOT NULL AND a.scheduled_date IS NOT NULL
       AND a.completion_date <= a.scheduled_date`,
      [assayerId, 6],
    );

    const earningsResult = await mgr.query(
      `SELECT COALESCE(SUM(a.agreed_fee), 0) as total FROM assignments a
       WHERE a.assayer_id = $1 AND a.status IN ($2, $3)`,
      [assayerId, 6, 7],
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
  }

  async getProfile(assayerId: string): Promise<AssayerEntity> {
    const assayer = await this.assayerRepository.findOne({
      where: { id: assayerId, isActive: true },
    });
    if (!assayer) throw new NotFoundException(`Assayer ${assayerId} not found.`);
    return assayer;
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
    return { activities, total };
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
}
