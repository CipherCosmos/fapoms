import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrganizationEntity } from './organization.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { EventCategory } from '@fapoms/shared';

export interface CreateOrganizationDto {
  code: string;
  name: string;
  displayName?: string;
  description?: string;
  address?: string;
  contactEmail?: string;
  contactPhone?: string;
  taxId?: string;
  registrationNumber?: string;
}

export interface UpdateOrganizationDto {
  name?: string;
  displayName?: string;
  address?: string;
  contactEmail?: string;
  contactPhone?: string;
}

@Injectable()
export class OrganizationService {
  constructor(
    @InjectRepository(OrganizationEntity)
    private readonly organizationRepository: Repository<OrganizationEntity>,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
  ) {}

  async create(dto: CreateOrganizationDto, userId: string): Promise<OrganizationEntity> {
    const existing = await this.organizationRepository.findOne({
      where: { code: dto.code },
    });
    if (existing) {
      throw new ConflictException(`Organization code ${dto.code} already exists.`);
    }

    const org = this.organizationRepository.create({
      ...dto,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.organizationRepository.save(org) as unknown as OrganizationEntity;
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ORGANIZATION_CREATED',
      entityType: 'ORGANIZATION',
      entityId: saved.id,
      userId,
      remarks: `Created organization: ${saved.name} (${saved.code})`,
    });

    try {
      this.eventPublisher.publish('organization:created', {
        eventType: 'organization:created',
        organizationId: saved.id,
        code: saved.code,
        name: saved.name,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish organization:created event:', err);
    }

    return saved;
  }

  async findAll(page = 1, limit = 50): Promise<{ organizations: OrganizationEntity[]; total: number }> {
    // Clamp so an uncapped `?limit=` cannot force a full-table read; 100 is above any real page.
    const take = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const currentPage = Math.max(Number(page) || 1, 1);
    const [organizations, total] = await this.organizationRepository.findAndCount({
      where: { isActive: true },
      skip: (currentPage - 1) * take,
      take,
      order: { createdAt: 'DESC' },
    });
    return { organizations, total };
  }

  async findOne(id: string): Promise<OrganizationEntity> {
    const org = await this.organizationRepository.findOne({
      where: { id, isActive: true },
    });
    if (!org) {
      throw new NotFoundException(`Organization ${id} not found.`);
    }
    return org;
  }

  async update(id: string, dto: UpdateOrganizationDto, userId: string): Promise<OrganizationEntity> {
    const org = await this.findOne(id);
    Object.assign(org, dto);
    org.updatedBy = userId;
    const saved = await this.organizationRepository.save(org) as unknown as OrganizationEntity;
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ORGANIZATION_UPDATED',
      entityType: 'ORGANIZATION',
      entityId: id,
      userId,
      remarks: `Updated organization: ${org.name}`,
    });

    try {
      this.eventPublisher.publish('organization:updated', {
        eventType: 'organization:updated',
        organizationId: saved.id,
        name: saved.name,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish organization:updated event:', err);
    }

    return saved;
  }

  async remove(id: string, userId: string): Promise<void> {
    const org = await this.findOne(id);
    org.isActive = false;
    org.updatedBy = userId;
    await this.organizationRepository.save(org);
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ORGANIZATION_DELETED',
      entityType: 'ORGANIZATION',
      entityId: id,
      userId,
      remarks: `Soft deleted organization: ${org.name}`,
    });
  }
}
