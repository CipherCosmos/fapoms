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
}

@Injectable()
export class AssayerService {
  constructor(
    @InjectRepository(AssayerEntity)
    private readonly assayerRepository: Repository<AssayerEntity>,
    private readonly auditService: AuditService,
  ) {}

  async create(dto: CreateAssayerDto, userId: string): Promise<AssayerEntity> {
    const existing = await this.assayerRepository.findOne({ where: { assayerCode: dto.assayerCode } });
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
      eventType: 'ASSAYER_REGISTERED',
      entityType: 'ASSAYER',
      entityId: saved.id,
      userId,
      remarks: `Registered assayer ${saved.displayName} (${saved.assayerCode})`,
    });

    return saved;
  }

  async findOne(id: string): Promise<AssayerEntity> {
    const assayer = await this.assayerRepository.findOne({ where: { id, isActive: true } });
    if (!assayer) {
      throw new NotFoundException(`Assayer ${id} not found.`);
    }
    return assayer;
  }

  async findAll(page = 1, limit = 20): Promise<{ assayers: AssayerEntity[]; total: number }> {
    const [assayers, total] = await this.assayerRepository.findAndCount({
      where: { isActive: true },
      take: limit,
      skip: (page - 1) * limit,
      order: { displayName: 'ASC' },
    });
    return { assayers, total };
  }

  async update(id: string, dto: UpdateAssayerDto, userId: string): Promise<AssayerEntity> {
    const assayer = await this.findOne(id);
    const prevStatus = assayer.status;

    Object.assign(assayer, dto);

    if (dto.firstName || dto.lastName) {
      assayer.displayName = `${assayer.firstName} ${assayer.lastName}`;
    }

    if (dto.latitude && dto.longitude) {
      assayer.location = {
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
      entityId: id,
      previousState: prevStatus,
      newState: saved.status,
      userId,
      remarks: `Updated assayer profile ${assayer.displayName}`,
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
}
