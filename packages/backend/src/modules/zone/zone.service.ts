/**
 * FAPOMS — Zone Service
 *
 * Coordinates operational zones (Part 2 §9, Part 5 §11).
 * Helps group regional operations.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ZoneEntity } from './zone.entity';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory } from '@fapoms/shared';

export interface CreateZoneDto {
  name: string;
  description?: string;
  clientId?: string;
  states?: string[];
  districts?: string[];
}

export interface UpdateZoneDto {
  name?: string;
  description?: string;
  states?: string[];
  districts?: string[];
}

@Injectable()
export class ZoneService {
  constructor(
    @InjectRepository(ZoneEntity)
    private readonly zoneRepository: Repository<ZoneEntity>,
    private readonly auditService: AuditService,
  ) {}

  async create(dto: CreateZoneDto, userId: string): Promise<ZoneEntity> {
    const zone = this.zoneRepository.create({
      name: dto.name,
      description: dto.description ?? null,
      clientId: dto.clientId ?? null,
      states: dto.states ?? [],
      districts: dto.districts ?? [],
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.zoneRepository.save(zone);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ZONE_CREATED',
      entityType: 'ZONE',
      entityId: saved.id,
      userId,
      remarks: `Created operational zone ${saved.name}`,
    });

    return saved;
  }

  async findOne(id: string): Promise<ZoneEntity> {
    const zone = await this.zoneRepository.findOne({ where: { id, isActive: true } });
    if (!zone) {
      throw new NotFoundException(`Zone ${id} not found.`);
    }
    return zone;
  }

  async findAll(page = 1, limit = 20, clientId?: string): Promise<{ zones: ZoneEntity[]; total: number }> {
    const query = this.zoneRepository.createQueryBuilder('zone')
      .where('zone.is_active = :isActive', { isActive: true });

    if (clientId) {
      query.andWhere('zone.client_id = :clientId', { clientId });
    }

    const [zones, total] = await query
      .orderBy('zone.name', 'ASC')
      .take(limit)
      .skip((page - 1) * limit)
      .getManyAndCount();

    return { zones, total };
  }

  async update(id: string, dto: UpdateZoneDto, userId: string): Promise<ZoneEntity> {
    const zone = await this.findOne(id);

    if (dto.name !== undefined) zone.name = dto.name;
    if (dto.description !== undefined) zone.description = dto.description;
    if (dto.states !== undefined) zone.states = dto.states;
    if (dto.districts !== undefined) zone.districts = dto.districts;

    zone.updatedBy = userId;
    const saved = await this.zoneRepository.save(zone);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ZONE_UPDATED',
      entityType: 'ZONE',
      entityId: id,
      userId,
      remarks: `Updated operational zone ${zone.name}`,
    });

    return saved;
  }

  async remove(id: string, userId: string): Promise<void> {
    const zone = await this.findOne(id);
    zone.isActive = false;
    zone.updatedBy = userId;
    await this.zoneRepository.save(zone);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ZONE_DELETED',
      entityType: 'ZONE',
      entityId: id,
      userId,
      remarks: `Soft deleted operational zone ${zone.name}`,
    });
  }
}
