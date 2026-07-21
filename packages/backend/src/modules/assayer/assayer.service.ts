/**
 * FAPOMS — Assayer Service
 *
 * Manages the assayer profiles and geographic settings (Part 2 §6, Part 5 §5).
 */

import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AssayerEntity } from './assayer.entity';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory, AssayerStatus } from '@fapoms/shared';

export interface CreateAssayerDto {
  assayerCode: string;
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
  panNumber?: string;
  bankAccountNumber?: string;
  ifscCode?: string;
  notes?: string;
  employmentType?: string;
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
  status?: AssayerStatus;
  panNumber?: string;
  bankAccountNumber?: string;
  ifscCode?: string;
  notes?: string;
  employmentType?: string;
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
}

export interface CreateCommercialProfileDto {
  baseFee: number;
  hourlyRate: number;
  dailyRate: number;
  travelReimbursement: number;
  accommodationAllowance: number;
  mealAllowance: number;
  currency?: string;
  effectiveStartDate: string;
  effectiveEndDate?: string | null;
}

export interface UpdateCommercialProfileDto {
  baseFee?: number;
  hourlyRate?: number;
  dailyRate?: number;
  travelReimbursement?: number;
  accommodationAllowance?: number;
  mealAllowance?: number;
  currency?: string;
  effectiveStartDate?: string;
  effectiveEndDate?: string | null;
}

export interface CreateWorkforceAttributeDto {
  type: string;
  name: string;
  level?: string;
  expiryDate?: string;
  metadata?: Record<string, any>;
}

export interface UpdateWorkforceAttributeDto {
  name?: string;
  level?: string;
  expiryDate?: string | null;
  metadata?: Record<string, any>;
}

import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from './workforce-attribute.entity';
import { LessThanOrEqual, MoreThanOrEqual, IsNull } from 'typeorm';

@Injectable()
export class AssayerService {
  constructor(
    @InjectRepository(AssayerEntity)
    private readonly assayerRepository: Repository<AssayerEntity>,
    @InjectRepository(AssayerCommercialProfileEntity)
    private readonly commercialRepository: Repository<AssayerCommercialProfileEntity>,
    @InjectRepository(WorkforceAttributeEntity)
    private readonly workforceAttributeRepository: Repository<WorkforceAttributeEntity>,
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
    const assayer = await this.assayerRepository.findOne({
      where: { id, isActive: true },
    });
    if (!assayer) {
      throw new NotFoundException(`Assayer ${id} not found.`);
    }
    return assayer;
  }

  async create(dto: CreateAssayerDto, userId: string): Promise<AssayerEntity> {
    const existing = await this.assayerRepository.findOne({
      where: { assayerCode: dto.assayerCode },
    });
    if (existing) {
      throw new ConflictException(`Assayer code ${dto.assayerCode} already exists.`);
    }

    let location = null;
    if (dto.latitude && dto.longitude) {
      location = {
        type: 'Point',
        coordinates: [dto.longitude, dto.latitude],
      };
    }

    const assayer = this.assayerRepository.create({
      ...dto,
      displayName: `${dto.firstName} ${dto.lastName}`,
      location,
      status: AssayerStatus.REGISTERED,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.assayerRepository.save(assayer);

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
      if ((dto as any)[key] !== undefined) {
        (assayer as any)[key] = (dto as any)[key];
      }
    });

    if (dto.firstName || dto.lastName) {
      assayer.displayName = `${dto.firstName ?? assayer.firstName} ${dto.lastName ?? assayer.lastName}`;
    }

    if (dto.latitude && dto.longitude) {
      (assayer as any).location = {
        type: 'Point',
        coordinates: [dto.longitude, dto.latitude],
      };
    }

    assayer.updatedBy = userId;
    const saved = await this.assayerRepository.save(assayer);

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

  // Commercial Profile methods
  async createCommercialProfile(
    assayerId: string,
    dto: CreateCommercialProfileDto,
    userId: string,
  ): Promise<AssayerCommercialProfileEntity> {
    await this.findOne(assayerId); // Verify assayer exists

    const profile = this.commercialRepository.create({
      ...dto,
      assayerId,
      effectiveStartDate: new Date(dto.effectiveStartDate),
      effectiveEndDate: dto.effectiveEndDate ? new Date(dto.effectiveEndDate) : null,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.commercialRepository.save(profile);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_COMMERCIAL_PROFILE_CREATED',
      entityType: 'ASSAYER_COMMERCIAL_PROFILE',
      entityId: saved.id,
      userId,
      remarks: `Created commercial profile for assayer ${assayerId} with base fee ₹${dto.baseFee}`,
    });

    return saved;
  }

  async updateCommercialProfile(
    profileId: string,
    dto: UpdateCommercialProfileDto,
    userId: string,
  ): Promise<AssayerCommercialProfileEntity> {
    const profile = await this.commercialRepository.findOne({
      where: { id: profileId, isActive: true },
    });

    if (!profile) {
      throw new NotFoundException(`Commercial profile ${profileId} not found.`);
    }

    if (dto.baseFee !== undefined) profile.baseFee = dto.baseFee;
    if (dto.hourlyRate !== undefined) profile.hourlyRate = dto.hourlyRate;
    if (dto.dailyRate !== undefined) profile.dailyRate = dto.dailyRate;
    if (dto.travelReimbursement !== undefined) profile.travelReimbursement = dto.travelReimbursement;
    if (dto.accommodationAllowance !== undefined) profile.accommodationAllowance = dto.accommodationAllowance;
    if (dto.mealAllowance !== undefined) profile.mealAllowance = dto.mealAllowance;
    if (dto.currency !== undefined) profile.currency = dto.currency;
    if (dto.effectiveStartDate !== undefined) profile.effectiveStartDate = new Date(dto.effectiveStartDate);
    if (dto.effectiveEndDate !== undefined) {
      profile.effectiveEndDate = dto.effectiveEndDate ? new Date(dto.effectiveEndDate) : null;
    }

    profile.updatedBy = userId;
    const saved = await this.commercialRepository.save(profile);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSAYER_COMMERCIAL_PROFILE_UPDATED',
      entityType: 'ASSAYER_COMMERCIAL_PROFILE',
      entityId: saved.id,
      userId,
      remarks: `Updated commercial profile ${profileId}`,
    });

    return saved;
  }

  async getCommercialProfiles(assayerId: string): Promise<AssayerCommercialProfileEntity[]> {
    return this.commercialRepository.find({
      where: { assayerId, isActive: true },
      order: { effectiveStartDate: 'DESC' },
    });
  }

  async getActiveCommercialProfile(
    assayerId: string,
    date: Date = new Date(),
  ): Promise<AssayerCommercialProfileEntity | null> {
    const profiles = await this.commercialRepository.find({
      where: {
        assayerId,
        isActive: true,
        effectiveStartDate: LessThanOrEqual(date),
      },
      order: { effectiveStartDate: 'DESC' },
    });

    for (const p of profiles) {
      if (!p.effectiveEndDate || p.effectiveEndDate >= date) {
        return p;
      }
    }
    return null;
  }

  // Workforce Attribute methods
  async addWorkforceAttribute(
    assayerId: string,
    dto: CreateWorkforceAttributeDto,
    userId: string,
  ): Promise<WorkforceAttributeEntity> {
    await this.findOne(assayerId);

    const attr = this.workforceAttributeRepository.create({
      ...dto,
      assayerId,
      expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.workforceAttributeRepository.save(attr);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'WORKFORCE_ATTRIBUTE_CREATED',
      entityType: 'WORKFORCE_ATTRIBUTE',
      entityId: saved.id,
      userId,
      remarks: `Added ${dto.type} '${dto.name}' to assayer ${assayerId}`,
    });

    return saved;
  }

  async updateWorkforceAttribute(
    attributeId: string,
    dto: UpdateWorkforceAttributeDto,
    userId: string,
  ): Promise<WorkforceAttributeEntity> {
    const attr = await this.workforceAttributeRepository.findOne({
      where: { id: attributeId, isActive: true },
    });

    if (!attr) {
      throw new NotFoundException(`Workforce attribute ${attributeId} not found.`);
    }

    if (dto.name !== undefined) attr.name = dto.name;
    if (dto.level !== undefined) attr.level = dto.level;
    if (dto.expiryDate !== undefined) attr.expiryDate = dto.expiryDate ? new Date(dto.expiryDate) : null;
    if (dto.metadata !== undefined) attr.metadata = dto.metadata;
    attr.updatedBy = userId;

    const saved = await this.workforceAttributeRepository.save(attr);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'WORKFORCE_ATTRIBUTE_UPDATED',
      entityType: 'WORKFORCE_ATTRIBUTE',
      entityId: saved.id,
      userId,
      remarks: `Updated workforce attribute ${attributeId}`,
    });

    return saved;
  }

  async removeWorkforceAttribute(attributeId: string, userId: string): Promise<void> {
    const attr = await this.workforceAttributeRepository.findOne({
      where: { id: attributeId, isActive: true },
    });

    if (!attr) {
      throw new NotFoundException(`Workforce attribute ${attributeId} not found.`);
    }

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
  }

  async getWorkforceAttributes(
    assayerId: string,
    type?: string,
  ): Promise<WorkforceAttributeEntity[]> {
    const where: any = { assayerId, isActive: true };
    if (type) where.type = type;

    return this.workforceAttributeRepository.find({
      where,
      order: { type: 'ASC', name: 'ASC' },
    });
  }
}
