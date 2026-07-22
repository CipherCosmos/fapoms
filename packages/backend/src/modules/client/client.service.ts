import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClientEntity } from './client.entity';
import { ClientConfigurationEntity } from './client-configuration.entity';
import { ClientContactEntity } from './client-contact.entity';
import { ClientContractEntity } from './client-contract.entity';
import { ClientBillingEntity } from './client-billing.entity';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory, ClientLifecycleStatus } from '@fapoms/shared';

export interface CreateClientDto {
  clientCode: string;
  name: string;
  displayName: string;
  website?: string;
  industry?: string;
  clientType?: string;
  registrationNumber?: string;
  taxId?: string;
  contactPerson?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  priority?: string;
  budget?: number;
  preferredAssayers?: string[];
  restrictedAssayers?: string[];
  planningPreferences?: Record<string, any>;
  configuration?: {
    importMapping?: Record<string, string>;
    workingDays?: number[];
    defaultRadius?: number;
    slaRules?: Record<string, any>;
    serviceLevel?: string;
    maxResponseTimeHours?: number;
    penaltyRate?: number;
    serviceHours?: Record<string, any>;
  };
}

export interface UpdateClientDto {
  name?: string;
  displayName?: string;
  website?: string;
  industry?: string;
  clientType?: string;
  registrationNumber?: string;
  taxId?: string;
  contactPerson?: string;
  contactEmail?: string;
  contactPhone?: string;
  address?: string;
  priority?: string;
  budget?: number;
  preferredAssayers?: string[];
  restrictedAssayers?: string[];
  planningPreferences?: Record<string, any>;
  configuration?: {
    importMapping?: Record<string, string>;
    workingDays?: number[];
    defaultRadius?: number;
    slaRules?: Record<string, any>;
    serviceLevel?: string;
    maxResponseTimeHours?: number;
    penaltyRate?: number;
    serviceHours?: Record<string, any>;
    effectiveTo?: Date;
  };
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

export interface CreateContractDto {
  contractNumber: string;
  title: string;
  description?: string;
  signedDate?: string;
  effectiveFrom: string;
  effectiveTo?: string;
  value?: number;
  currency?: string;
  terms?: Record<string, any>;
  documentUrl?: string;
}

export interface UpdateContractDto {
  title?: string;
  description?: string;
  signedDate?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  value?: number;
  currency?: string;
  status?: string;
  terms?: Record<string, any>;
  documentUrl?: string;
}

export interface UpdateBillingDto {
  paymentTerms?: string;
  currency?: string;
  taxIdentifier?: string;
  invoiceCycle?: string;
  billingAddress?: string;
  bankAccount?: string;
  bankName?: string;
  ifscCode?: string;
  notes?: string;
}

const VALID_LIFECYCLE_TRANSITIONS: Record<string, string[]> = {
  [ClientLifecycleStatus.PROSPECT]: [ClientLifecycleStatus.ONBOARDING, ClientLifecycleStatus.ARCHIVED],
  [ClientLifecycleStatus.ONBOARDING]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.INACTIVE],
  [ClientLifecycleStatus.ACTIVE]: [ClientLifecycleStatus.SUSPENDED, ClientLifecycleStatus.UNDER_REVIEW, ClientLifecycleStatus.INACTIVE],
  [ClientLifecycleStatus.SUSPENDED]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.UNDER_REVIEW, ClientLifecycleStatus.TERMINATED],
  [ClientLifecycleStatus.UNDER_REVIEW]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.SUSPENDED, ClientLifecycleStatus.TERMINATED],
  [ClientLifecycleStatus.INACTIVE]: [ClientLifecycleStatus.ACTIVE, ClientLifecycleStatus.ARCHIVED],
  [ClientLifecycleStatus.TERMINATED]: [ClientLifecycleStatus.ARCHIVED],
  [ClientLifecycleStatus.ARCHIVED]: [],
};

@Injectable()
export class ClientService {
  constructor(
    @InjectRepository(ClientEntity)
    private readonly clientRepository: Repository<ClientEntity>,
    @InjectRepository(ClientConfigurationEntity)
    private readonly configRepository: Repository<ClientConfigurationEntity>,
    @InjectRepository(ClientContactEntity)
    private readonly contactRepository: Repository<ClientContactEntity>,
    @InjectRepository(ClientContractEntity)
    private readonly contractRepository: Repository<ClientContractEntity>,
    @InjectRepository(ClientBillingEntity)
    private readonly billingRepository: Repository<ClientBillingEntity>,
    private readonly auditService: AuditService,
  ) {}

  // -----------------------------------------------------------------------
  // Client Profile
  // -----------------------------------------------------------------------

  async create(dto: CreateClientDto, userId: string): Promise<ClientEntity> {
    const existing = await this.clientRepository.findOne({ where: { clientCode: dto.clientCode } });
    if (existing) {
      throw new ConflictException(`Client code ${dto.clientCode} already exists.`);
    }

    const config = this.configRepository.create({
      importMapping: dto.configuration?.importMapping ?? {},
      workingDays: dto.configuration?.workingDays ?? [1, 2, 3, 4, 5],
      defaultRadius: dto.configuration?.defaultRadius ?? 50.0,
      slaRules: dto.configuration?.slaRules ?? {},
      serviceLevel: dto.configuration?.serviceLevel ?? null,
      maxResponseTimeHours: dto.configuration?.maxResponseTimeHours ?? null,
      penaltyRate: dto.configuration?.penaltyRate ?? null,
      serviceHours: dto.configuration?.serviceHours ?? null,
      effectiveFrom: new Date(),
      createdBy: userId,
      updatedBy: userId,
    });

    const client = this.clientRepository.create({
      clientCode: dto.clientCode,
      name: dto.name,
      displayName: dto.displayName,
      website: dto.website ?? null,
      industry: dto.industry ?? null,
      clientType: dto.clientType ?? 'OTHER',
      registrationNumber: dto.registrationNumber ?? null,
      taxId: dto.taxId ?? null,
      lifecycleStatus: ClientLifecycleStatus.PROSPECT,
      contactPerson: dto.contactPerson ?? null,
      contactEmail: dto.contactEmail ?? null,
      contactPhone: dto.contactPhone ?? null,
      address: dto.address ?? null,
      priority: dto.priority ?? 'MEDIUM',
      budget: dto.budget ?? null,
      preferredAssayers: dto.preferredAssayers ?? null,
      restrictedAssayers: dto.restrictedAssayers ?? null,
      planningPreferences: dto.planningPreferences ?? null,
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
      relations: ['configuration', 'contacts', 'contracts', 'billing'],
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
    if (dto.website !== undefined) client.website = dto.website;
    if (dto.industry !== undefined) client.industry = dto.industry;
    if (dto.clientType !== undefined) client.clientType = dto.clientType;
    if (dto.registrationNumber !== undefined) client.registrationNumber = dto.registrationNumber;
    if (dto.taxId !== undefined) client.taxId = dto.taxId;
    if (dto.contactPerson !== undefined) client.contactPerson = dto.contactPerson;
    if (dto.contactEmail !== undefined) client.contactEmail = dto.contactEmail;
    if (dto.contactPhone !== undefined) client.contactPhone = dto.contactPhone;
    if (dto.address !== undefined) client.address = dto.address;
    if (dto.priority !== undefined) client.priority = dto.priority;
    if (dto.budget !== undefined) client.budget = dto.budget;
    if (dto.preferredAssayers !== undefined) client.preferredAssayers = dto.preferredAssayers;
    if (dto.restrictedAssayers !== undefined) client.restrictedAssayers = dto.restrictedAssayers;
    if (dto.planningPreferences !== undefined) client.planningPreferences = dto.planningPreferences;

    if (dto.configuration && client.configuration) {
      const conf = client.configuration;
      if (dto.configuration.importMapping !== undefined) conf.importMapping = dto.configuration.importMapping;
      if (dto.configuration.workingDays !== undefined) conf.workingDays = dto.configuration.workingDays;
      if (dto.configuration.defaultRadius !== undefined) conf.defaultRadius = dto.configuration.defaultRadius;
      if (dto.configuration.slaRules !== undefined) conf.slaRules = dto.configuration.slaRules;
      if (dto.configuration.serviceLevel !== undefined) conf.serviceLevel = dto.configuration.serviceLevel;
      if (dto.configuration.maxResponseTimeHours !== undefined) conf.maxResponseTimeHours = dto.configuration.maxResponseTimeHours;
      if (dto.configuration.penaltyRate !== undefined) conf.penaltyRate = dto.configuration.penaltyRate;
      if (dto.configuration.serviceHours !== undefined) conf.serviceHours = dto.configuration.serviceHours;
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

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async transitionLifecycle(id: string, newStatus: string, userId: string, reason?: string): Promise<ClientEntity> {
    const client = await this.findOne(id);
    const currentStatus = client.lifecycleStatus;
    const allowed = VALID_LIFECYCLE_TRANSITIONS[currentStatus] || [];

    if (!allowed.includes(newStatus)) {
      throw new BadRequestException(
        `Cannot transition from ${currentStatus} to ${newStatus}. Allowed: ${allowed.join(', ') || 'none'}`,
      );
    }

    client.lifecycleStatus = newStatus;
    client.updatedBy = userId;
    const saved = await this.clientRepository.save(client);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'CLIENT_LIFECYCLE_CHANGED',
      entityType: 'CLIENT',
      entityId: id,
      previousState: currentStatus,
      newState: newStatus,
      userId,
      remarks: reason || `Lifecycle transitioned from ${currentStatus} to ${newStatus}`,
    });

    return saved;
  }

  // -----------------------------------------------------------------------
  // Contacts
  // -----------------------------------------------------------------------

  async findContacts(clientId: string): Promise<ClientContactEntity[]> {
    await this.findOne(clientId);
    return this.contactRepository.find({ where: { clientId, isActive: true } });
  }

  async addContact(clientId: string, dto: CreateContactDto, userId: string): Promise<ClientContactEntity> {
    await this.findOne(clientId);

    if (dto.isPrimary) {
      await this.contactRepository.update({ clientId, isPrimary: true }, { isPrimary: false });
    }

    const contact = this.contactRepository.create({
      clientId,
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
      eventType: 'CLIENT_CONTACT_CREATED',
      entityType: 'CLIENT',
      entityId: clientId,
      userId,
      remarks: `Added contact ${saved.name}`,
    });

    return saved;
  }

  async updateContact(contactId: string, dto: UpdateContactDto, userId: string): Promise<ClientContactEntity> {
    const contact = await this.contactRepository.findOne({ where: { id: contactId, isActive: true } });
    if (!contact) {
      throw new NotFoundException(`Contact ${contactId} not found.`);
    }

    if (dto.isPrimary) {
      await this.contactRepository.update({ clientId: contact.clientId, isPrimary: true }, { isPrimary: false });
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
  }

  // -----------------------------------------------------------------------
  // Contracts
  // -----------------------------------------------------------------------

  async findContracts(clientId: string): Promise<ClientContractEntity[]> {
    await this.findOne(clientId);
    return this.contractRepository.find({ where: { clientId, isActive: true }, order: { createdAt: 'DESC' } });
  }

  async addContract(clientId: string, dto: CreateContractDto, userId: string): Promise<ClientContractEntity> {
    await this.findOne(clientId);

    const existing = await this.contractRepository.findOne({ where: { contractNumber: dto.contractNumber } });
    if (existing) {
      throw new ConflictException(`Contract number ${dto.contractNumber} already exists.`);
    }

    const contract = this.contractRepository.create({
      clientId,
      contractNumber: dto.contractNumber,
      title: dto.title,
      description: dto.description ?? null,
      signedDate: dto.signedDate ?? null,
      effectiveFrom: dto.effectiveFrom,
      effectiveTo: dto.effectiveTo ?? null,
      value: dto.value ?? null,
      currency: dto.currency ?? 'INR',
      status: 'DRAFT',
      terms: dto.terms ?? null,
      documentUrl: dto.documentUrl ?? null,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.contractRepository.save(contract);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'CLIENT_CONTRACT_CREATED',
      entityType: 'CLIENT',
      entityId: clientId,
      userId,
      remarks: `Added contract ${saved.contractNumber} - ${saved.title}`,
    });

    return saved;
  }

  async updateContract(contractId: string, dto: UpdateContractDto, userId: string): Promise<ClientContractEntity> {
    const contract = await this.contractRepository.findOne({ where: { id: contractId, isActive: true } });
    if (!contract) {
      throw new NotFoundException(`Contract ${contractId} not found.`);
    }

    if (dto.title !== undefined) contract.title = dto.title;
    if (dto.description !== undefined) contract.description = dto.description;
    if (dto.signedDate !== undefined) contract.signedDate = dto.signedDate;
    if (dto.effectiveFrom !== undefined) contract.effectiveFrom = dto.effectiveFrom;
    if (dto.effectiveTo !== undefined) contract.effectiveTo = dto.effectiveTo;
    if (dto.value !== undefined) contract.value = dto.value;
    if (dto.currency !== undefined) contract.currency = dto.currency;
    if (dto.status !== undefined) contract.status = dto.status;
    if (dto.terms !== undefined) contract.terms = dto.terms;
    if (dto.documentUrl !== undefined) contract.documentUrl = dto.documentUrl;

    contract.updatedBy = userId;
    const saved = await this.contractRepository.save(contract);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'CLIENT_CONTRACT_UPDATED',
      entityType: 'CLIENT',
      entityId: contract.clientId,
      userId,
      remarks: `Updated contract ${saved.contractNumber}`,
    });

    return saved;
  }

  async removeContract(contractId: string, userId: string): Promise<void> {
    const contract = await this.contractRepository.findOne({ where: { id: contractId, isActive: true } });
    if (!contract) {
      throw new NotFoundException(`Contract ${contractId} not found.`);
    }
    contract.isActive = false;
    contract.updatedBy = userId;
    await this.contractRepository.save(contract);
  }

  // -----------------------------------------------------------------------
  // Billing
  // -----------------------------------------------------------------------

  async findBilling(clientId: string): Promise<ClientBillingEntity | null> {
    await this.findOne(clientId);
    return this.billingRepository.findOne({ where: { clientId, isActive: true } });
  }

  async upsertBilling(clientId: string, dto: UpdateBillingDto, userId: string): Promise<ClientBillingEntity> {
    await this.findOne(clientId);

    let billing = await this.billingRepository.findOne({ where: { clientId } });

    if (!billing) {
      billing = this.billingRepository.create({
        clientId,
        paymentTerms: dto.paymentTerms ?? 'NET30',
        currency: dto.currency ?? 'INR',
        taxIdentifier: dto.taxIdentifier ?? null,
        invoiceCycle: dto.invoiceCycle ?? 'MONTHLY',
        billingAddress: dto.billingAddress ?? '',
        bankAccount: dto.bankAccount ?? null,
        bankName: dto.bankName ?? null,
        ifscCode: dto.ifscCode ?? null,
        notes: dto.notes ?? null,
        createdBy: userId,
        updatedBy: userId,
      });
    } else {
      if (dto.paymentTerms !== undefined) billing.paymentTerms = dto.paymentTerms;
      if (dto.currency !== undefined) billing.currency = dto.currency;
      if (dto.taxIdentifier !== undefined) billing.taxIdentifier = dto.taxIdentifier;
      if (dto.invoiceCycle !== undefined) billing.invoiceCycle = dto.invoiceCycle;
      if (dto.billingAddress !== undefined) billing.billingAddress = dto.billingAddress;
      if (dto.bankAccount !== undefined) billing.bankAccount = dto.bankAccount;
      if (dto.bankName !== undefined) billing.bankName = dto.bankName;
      if (dto.ifscCode !== undefined) billing.ifscCode = dto.ifscCode;
      if (dto.notes !== undefined) billing.notes = dto.notes;
      billing.updatedBy = userId;
    }

    const saved = await this.billingRepository.save(billing);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'CLIENT_BILLING_UPDATED',
      entityType: 'CLIENT',
      entityId: clientId,
      userId,
      remarks: `Updated billing for client ${clientId}`,
    });

    return saved;
  }
}
