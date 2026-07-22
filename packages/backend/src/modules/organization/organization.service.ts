import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrganizationEntity } from './organization.entity';
import { AuditService } from '../../core/audit/audit.service';
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
    return saved;
  }

  async findAll(page = 1, limit = 50): Promise<{ organizations: OrganizationEntity[]; total: number }> {
    const [organizations, total] = await this.organizationRepository.findAndCount({
      where: { isActive: true },
      skip: (page - 1) * limit,
      take: limit,
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
