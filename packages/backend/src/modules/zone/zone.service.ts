/**
 * FAPOMS — Zone Service
 *
 * Coordinates operational zones (Part 2 §9, Part 5 §11).
 * Helps group regional operations.
 */

import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, Not, ILike, IsNull } from 'typeorm';

import { ZoneEntity } from './zone.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
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
    private readonly eventPublisher: DomainEventPublisher,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * A zone is chosen by name — in the branch form, in the planning filter, in the scope switcher —
   * and never by id, so two zones sharing a name within the same scope are indistinguishable at
   * every point of use.
   *
   * The check is deliberately per-client rather than global: "West Zone" legitimately exists once
   * for each bank, and the Client Scope column is what tells those apart. It is only a collision
   * when the scope matches too, which includes two unscoped zones of the same name.
   */
  private async assertNameIsFree(name: string, clientId: string | null, excludeId?: string): Promise<void> {
    const clash = await this.zoneRepository.findOne({
      where: {
        name: ILike(name.trim()),
        clientId: clientId ?? IsNull(),
        isActive: true,
        ...(excludeId ? { id: Not(excludeId) } : {}),
      },
    });
    if (clash) {
      throw new ConflictException(
        clientId
          ? `A zone called "${clash.name}" already exists for this client. Give this one a different name.`
          : `An unscoped zone called "${clash.name}" already exists. Give this one a different name, or scope it to a client.`,
      );
    }
  }

  async create(dto: CreateZoneDto, userId: string): Promise<ZoneEntity> {
    await this.assertNameIsFree(dto.name, dto.clientId ?? null);

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

    this.eventPublisher.publish('zone:created', {
      eventType: 'zone:created',
      aggregateId: saved.id,
      userId,
      clientId: saved.clientId,
      payload: { id: saved.id, name: saved.name, clientId: saved.clientId },
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

    if (dto.name !== undefined && dto.name.trim() !== zone.name) {
      await this.assertNameIsFree(dto.name, zone.clientId, id);
    }

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

    this.eventPublisher.publish('zone:updated', {
      eventType: 'zone:updated',
      aggregateId: id,
      userId,
      clientId: zone.clientId,
      payload: { id, name: zone.name },
    });

    return saved;
  }

  async remove(id: string, userId: string): Promise<void> {
    const zone = await this.findOne(id);
    zone.isActive = false;
    zone.updatedBy = userId;
    await this.zoneRepository.save(zone);

    // Unassign deactivated zone from branches and project_branches
    await this.dataSource.query(
      `UPDATE branches SET zone_id = NULL, updated_by = $1 WHERE zone_id = $2`,
      [userId, id],
    );
    await this.dataSource.query(
      `UPDATE project_branches SET zone_id = NULL, updated_by = $1 WHERE zone_id = $2`,
      [userId, id],
    );

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ZONE_DELETED',
      entityType: 'ZONE',
      entityId: id,
      userId,
      remarks: `Soft deleted operational zone ${zone.name} and unassigned it from branches`,
    });

    this.eventPublisher.publish('zone:deleted', {
      eventType: 'zone:deleted',
      aggregateId: id,
      userId,
      clientId: zone.clientId,
      payload: { id, name: zone.name },
    });
  }
}
