/**
 * FAPOMS — Client Service
 *
 * Manages the corporate clients lifecycle and configuration (Part 2 §2, Part 5 §3).
 */

import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClientEntity } from './client.entity';
import { ClientConfigurationEntity } from './client-configuration.entity';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory } from '@fapoms/shared';

export interface CreateClientDto {
  clientCode: string;
  name: string;
  displayName: string;
  contactPerson?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  configuration?: {
    importMapping?: Record<string, string>;
    workingDays?: number[];
    defaultRadius?: number;
    slaRules?: Record<string, any>;
  };
}

export interface UpdateClientDto {
  name?: string;
  displayName?: string;
  contactPerson?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  configuration?: {
    importMapping?: Record<string, string>;
    workingDays?: number[];
    defaultRadius?: number;
    slaRules?: Record<string, any>;
    effectiveTo?: Date;
  };
}

@Injectable()
export class ClientService {
  constructor(
    @InjectRepository(ClientEntity)
    private readonly clientRepository: Repository<ClientEntity>,
    @InjectRepository(ClientConfigurationEntity)
    private readonly configRepository: Repository<ClientConfigurationEntity>,
    private readonly auditService: AuditService,
  ) {}

  async create(dto: CreateClientDto, userId: string): Promise<ClientEntity> {
    const existing = await this.clientRepository.findOne({ where: { clientCode: dto.clientCode } });
    if (existing) {
      throw new ConflictException(`Client code ${dto.clientCode} already exists.`);
    }

    const config = this.configRepository.create({
      importMapping: dto.configuration?.importMapping ?? {},
      workingDays: dto.configuration?.workingDays ?? [1, 2, 3, 4, 5], // Mon-Fri
      defaultRadius: dto.configuration?.defaultRadius ?? 50.0,
      slaRules: dto.configuration?.slaRules ?? {},
      effectiveFrom: new Date(),
      createdBy: userId,
      updatedBy: userId,
    });

    const client = this.clientRepository.create({
      clientCode: dto.clientCode,
      name: dto.name,
      displayName: dto.displayName,
      contactPerson: dto.contactPerson ?? null,
      contactEmail: dto.contactEmail ?? null,
      contactPhone: dto.contactPhone ?? null,
      address: dto.address ?? null,
      createdBy: userId,
      updatedBy: userId,
      configuration: config,
    });

    const saved = await this.clientRepository.save(client);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'CLIENT_CREATED',
      entityType: 'CLIENT',
      entityId: saved.id,
      userId,
      remarks: `Created client ${saved.name} (${saved.clientCode})`,
    });

    return saved;
  }

  async findOne(id: string): Promise<ClientEntity> {
    const client = await this.clientRepository.findOne({
      where: { id, isActive: true },
      relations: ['configuration'],
    });
    if (!client) {
      throw new NotFoundException(`Client ${id} not found.`);
    }
    return client;
  }

  async findAll(page = 1, limit = 20): Promise<{ clients: ClientEntity[]; total: number }> {
    const [clients, total] = await this.clientRepository.findAndCount({
      where: { isActive: true },
      relations: ['configuration'],
      take: limit,
      skip: (page - 1) * limit,
      order: { name: 'ASC' },
    });
    return { clients, total };
  }

  async update(id: string, dto: UpdateClientDto, userId: string): Promise<ClientEntity> {
    const client = await this.findOne(id);

    if (dto.name !== undefined) client.name = dto.name;
    if (dto.displayName !== undefined) client.displayName = dto.displayName;
    if (dto.contactPerson !== undefined) client.contactPerson = dto.contactPerson;
    if (dto.contactEmail !== undefined) client.contactEmail = dto.contactEmail;
    if (dto.contactPhone !== undefined) client.contactPhone = dto.contactPhone;
    if (dto.address !== undefined) client.address = dto.address;

    if (dto.configuration && client.configuration) {
      const conf = client.configuration;
      if (dto.configuration.importMapping !== undefined) conf.importMapping = dto.configuration.importMapping;
      if (dto.configuration.workingDays !== undefined) conf.workingDays = dto.configuration.workingDays;
      if (dto.configuration.defaultRadius !== undefined) conf.defaultRadius = dto.configuration.defaultRadius;
      if (dto.configuration.slaRules !== undefined) conf.slaRules = dto.configuration.slaRules;
      if (dto.configuration.effectiveTo !== undefined) conf.effectiveTo = dto.configuration.effectiveTo;
      conf.updatedBy = userId;
    }

    client.updatedBy = userId;
    const saved = await this.clientRepository.save(client);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'CLIENT_UPDATED',
      entityType: 'CLIENT',
      entityId: id,
      userId,
      remarks: `Updated client ${client.name}`,
    });

    return saved;
  }

  async remove(id: string, userId: string): Promise<void> {
    const client = await this.findOne(id);
    client.isActive = false;
    client.updatedBy = userId;
    await this.clientRepository.save(client);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'CLIENT_DELETED',
      entityType: 'CLIENT',
      entityId: id,
      userId,
      remarks: `Soft deleted client ${client.name}`,
    });
  }
}
