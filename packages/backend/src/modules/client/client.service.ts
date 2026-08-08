import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, In } from 'typeorm';
import { ClientEntity } from './client.entity';
import { ClientConfigurationEntity } from './client-configuration.entity';
import { ClientContactEntity } from './client-contact.entity';
import { ClientContractEntity } from './client-contract.entity';
import { ClientBillingEntity } from './client-billing.entity';
import { ClientBillingHistoryEntity } from './client-billing-history.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { EventCategory, ClientLifecycleStatus, ClientBillingStatus, ClientBillingEventType } from '@fapoms/shared';

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
    defaultBaseFee?: number;
    travelFeePerKm?: number;
    freeTravelAllowanceKm?: number;
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
    defaultBaseFee?: number;
    travelFeePerKm?: number;
    freeTravelAllowanceKm?: number;
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
  gstRate?: number;
  tdsRate?: number;
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

/** Ordered path of client lifecycle states from `from` to `target`, walking only
 *  allowed transitions (BFS). Returns [] when already there, or null when the
 *  target is unreachable — used by bulk operations to walk a batch forward. */
function findLifecyclePathTo(from: string, target: string): string[] | null {
  if (from === target) return [];
  const queue: { stage: string; path: string[] }[] = [{ stage: from, path: [] }];
  const visited = new Set<string>([from]);
  while (queue.length) {
    const { stage, path } = queue.shift()!;
    for (const next of VALID_LIFECYCLE_TRANSITIONS[stage] ?? []) {
      if (next === target) return [...path, next];
      if (!visited.has(next)) {
        visited.add(next);
        queue.push({ stage: next, path: [...path, next] });
      }
    }
  }
  return null;
}

const VALID_BILLING_TRANSITIONS: Record<string, string[]> = {
  [ClientBillingStatus.DRAFT]: [ClientBillingStatus.ACTIVE, ClientBillingStatus.INACTIVE],
  [ClientBillingStatus.ACTIVE]: [ClientBillingStatus.SUSPENDED, ClientBillingStatus.INACTIVE],
  [ClientBillingStatus.SUSPENDED]: [ClientBillingStatus.ACTIVE, ClientBillingStatus.INACTIVE],
  [ClientBillingStatus.INACTIVE]: [ClientBillingStatus.ACTIVE],
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
    @InjectRepository(ClientBillingHistoryEntity)
    private readonly billingHistoryRepository: Repository<ClientBillingHistoryEntity>,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
  ) {}

  // -----------------------------------------------------------------------
  // Client Profile
  // -----------------------------------------------------------------------

  async create(dto: CreateClientDto, userId: string, organizationId?: string | null): Promise<ClientEntity> {
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
      defaultBaseFee: dto.configuration?.defaultBaseFee ?? null,
      travelFeePerKm: dto.configuration?.travelFeePerKm ?? null,
      freeTravelAllowanceKm: dto.configuration?.freeTravelAllowanceKm ?? null,
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
      organizationId: organizationId ?? null,
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

    try {
      this.eventPublisher.publish('client:created', {
        eventType: 'client:created',
        clientId: saved.id,
        clientCode: saved.clientCode,
        name: saved.name,
        organizationId: saved.organizationId,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish client:created event:', err);
    }

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

  async findAll(
    page = 1,
    limit = 20,
    filters: {
      search?: string;
      status?: string;
      clientType?: string;
      priority?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<{ clients: ClientEntity[]; total: number }> {
    const where: Record<string, unknown> = { isActive: true };

    if (filters.search) {
      where.name = Like(`%${filters.search}%`);
    }
    if (filters.status) {
      where.lifecycleStatus = filters.status;
    }
    if (filters.clientType) {
      where.clientType = filters.clientType;
    }
    if (filters.priority) {
      where.priority = filters.priority;
    }

    const sortable = new Set([
      'name', 'displayName', 'clientCode', 'clientType', 'priority',
      'lifecycleStatus', 'industry', 'createdAt', 'updatedAt',
    ]);
    const sortBy: string = sortable.has(filters.sortBy ?? '') ? (filters.sortBy ?? 'name') : 'name';
    const sortOrder: 'ASC' | 'DESC' = filters.sortOrder === 'DESC' ? 'DESC' : 'ASC';

    const [clients, total] = await this.clientRepository.findAndCount({
      where,
      relations: ['configuration'],
      take: limit,
      skip: (page - 1) * limit,
      order: { [sortBy]: sortOrder },
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
      if (dto.configuration.defaultBaseFee !== undefined) conf.defaultBaseFee = dto.configuration.defaultBaseFee;
      if (dto.configuration.travelFeePerKm !== undefined) conf.travelFeePerKm = dto.configuration.travelFeePerKm;
      if (dto.configuration.freeTravelAllowanceKm !== undefined) conf.freeTravelAllowanceKm = dto.configuration.freeTravelAllowanceKm;
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

    try {
      this.eventPublisher.publish('client:updated', {
        eventType: 'client:updated',
        clientId: saved.id,
        name: saved.name,
        organizationId: saved.organizationId,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish client:updated event:', err);
    }

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
      category: EventCategory.WORKFLOW,
      eventType: 'CLIENT_LIFECYCLE_CHANGED',
      entityType: 'CLIENT',
      entityId: id,
      previousState: currentStatus,
      newState: newStatus,
      userId,
      remarks: reason || `Lifecycle transitioned from ${currentStatus} to ${newStatus}`,
    });

    try {
      this.eventPublisher.publish('client:status-changed', {
        eventType: 'client:status-changed',
        clientId: saved.id,
        name: saved.name,
        previousStatus: currentStatus,
        newStatus,
        organizationId: saved.organizationId,
        userId,
        reason,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish client:status-changed event:', err);
    }

    return saved;
  }

  /**
   * Migrate a batch of clients forward to a target lifecycle stage as one
   * operation. Each row is walked through the allowed state-machine path to the
   * target and every step runs the normal transition (validation, audit, domain
   * event). Rows that cannot reach the target are skipped; per-row errors are
   * isolated so one bad client never aborts the rest.
   */
  async bulkTransitionLifecycle(
    ids: string[],
    newStatus: string,
    userId: string,
    reason?: string,
  ): Promise<{
    succeeded: { id: string; from: string; to: string }[];
    skipped: { id: string; current: string; reason: string }[];
    failed: { id: string; reason: string }[];
  }> {
    const validTargets = Object.values(ClientLifecycleStatus);
    if (!validTargets.includes(newStatus as ClientLifecycleStatus)) {
      throw new BadRequestException(`Invalid target status: ${newStatus}`);
    }

    const succeeded: { id: string; from: string; to: string }[] = [];
    const skipped: { id: string; current: string; reason: string }[] = [];
    const failed: { id: string; reason: string }[] = [];

    for (const id of ids) {
      try {
        const client = await this.findOne(id);
        const from = client.lifecycleStatus;
        const path = findLifecyclePathTo(from, newStatus);
        if (path === null) {
          skipped.push({ id, current: from, reason: `No valid path from ${from} to ${newStatus}` });
          continue;
        }
        for (const step of path) {
          await this.transitionLifecycle(id, step, userId, reason);
        }
        succeeded.push({ id, from, to: newStatus });
      } catch (e) {
        failed.push({ id, reason: (e as Error).message });
      }
    }

    return { succeeded, skipped, failed };
  }

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

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'CLIENT_CONTACT_REMOVED',
      entityType: 'CLIENT',
      entityId: contact.clientId,
      userId,
      remarks: `Removed contact ${contact.name} from client`,
      metadata: { contactId: contact.id, name: contact.name, designation: contact.designation ?? null, email: contact.email ?? null, phone: contact.phone ?? null },
    });
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

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'CLIENT_CONTRACT_REMOVED',
      entityType: 'CLIENT',
      entityId: contract.clientId,
      userId,
      remarks: `Removed contract ${contract.contractNumber} - ${contract.title}`,
      metadata: {
        contractId: contract.id,
        contractNumber: contract.contractNumber,
        title: contract.title,
        effectiveFrom: contract.effectiveFrom,
        effectiveTo: contract.effectiveTo ?? null,
        value: contract.value ?? null,
        currency: contract.currency,
        status: contract.status,
      },
    });
  }

  // -----------------------------------------------------------------------
  // Billing
  // -----------------------------------------------------------------------

  async findBilling(clientId: string): Promise<ClientBillingEntity | null> {
    await this.findOne(clientId);
    return this.billingRepository.findOne({ where: { clientId, isActive: true } });
  }

  // Editable billing profile fields, in display order.
  private readonly BILLING_FIELDS: Array<{ key: keyof ClientBillingEntity; label: string }> = [
    { key: 'paymentTerms', label: 'Payment Terms' },
    { key: 'currency', label: 'Currency' },
    { key: 'taxIdentifier', label: 'Tax Identifier' },
    { key: 'invoiceCycle', label: 'Invoice Cycle' },
    { key: 'billingAddress', label: 'Billing Address' },
    { key: 'bankAccount', label: 'Bank Account' },
    { key: 'bankName', label: 'Bank Name' },
    { key: 'ifscCode', label: 'IFSC Code' },
    { key: 'notes', label: 'Notes' },
    { key: 'gstRate', label: 'GST Rate' },
    { key: 'tdsRate', label: 'TDS Rate' },
  ];

  private stringify(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    return String(value);
  }

  private async recordBillingHistory(
    clientId: string,
    userId: string,
    entry: Partial<ClientBillingHistoryEntity>,
  ): Promise<ClientBillingHistoryEntity> {
    return this.billingHistoryRepository.save(
      this.billingHistoryRepository.create({ clientId, createdBy: userId, updatedBy: userId, ...entry }),
    );
  }

  async upsertBilling(clientId: string, dto: UpdateBillingDto, userId: string): Promise<ClientBillingEntity> {
    await this.findOne(clientId);

    let billing = await this.billingRepository.findOne({ where: { clientId } });
    const changes: Array<{ field: string; label: string; fromValue: string | null; toValue: string | null }> = [];

    if (!billing) {
      billing = this.billingRepository.create({
        clientId,
        status: ClientBillingStatus.DRAFT,
        paymentTerms: dto.paymentTerms ?? 'NET30',
        currency: dto.currency ?? 'INR',
        taxIdentifier: dto.taxIdentifier ?? null,
        invoiceCycle: dto.invoiceCycle ?? 'MONTHLY',
        billingAddress: dto.billingAddress ?? '',
        bankAccount: dto.bankAccount ?? null,
        bankName: dto.bankName ?? null,
        ifscCode: dto.ifscCode ?? null,
        notes: dto.notes ?? null,
        gstRate: dto.gstRate ?? 18,
        tdsRate: dto.tdsRate ?? 10,
        createdBy: userId,
        updatedBy: userId,
      });
    } else {
      for (const f of this.BILLING_FIELDS) {
        const incoming = (dto as any)[f.key];
        if (incoming === undefined) continue;
        const fromValue = this.stringify(billing[f.key]);
        const toValue = this.stringify(incoming);
        if (fromValue !== toValue) {
          changes.push({ field: f.key, label: f.label, fromValue, toValue });
          (billing as any)[f.key] = incoming;
        }
      }
      billing.updatedBy = userId;
    }

    const saved = await this.billingRepository.save(billing);

    // Record profile edits on the timeline.
    if (changes.length > 0) {
      for (const change of changes) {
        await this.recordBillingHistory(clientId, userId, {
          eventType: ClientBillingEventType.PROFILE_UPDATE,
          field: change.field,
          remarks: `${change.label} updated`,
          fromValue: change.fromValue,
          toValue: change.toValue,
        });
      }
    }

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

  async transitionBillingStatus(
    clientId: string,
    targetStatus: ClientBillingStatus,
    userId: string,
    remarks?: string,
  ): Promise<ClientBillingEntity> {
    await this.findOne(clientId);

    const billing = await this.billingRepository.findOne({ where: { clientId } });
    if (!billing) {
      throw new NotFoundException('Billing profile not found for this client.');
    }

    const allowed = VALID_BILLING_TRANSITIONS[billing.status] ?? [];
    if (billing.status === targetStatus) {
      throw new ConflictException(`Billing is already ${targetStatus}.`);
    }
    if (!allowed.includes(targetStatus)) {
      throw new BadRequestException(
        `Cannot transition billing from ${billing.status} to ${targetStatus}. Allowed: ${allowed.join(', ') || 'none'}.`,
      );
    }

    const fromStatus = billing.status;
    billing.status = targetStatus;
    billing.updatedBy = userId;
    const saved = await this.billingRepository.save(billing);

    await this.recordBillingHistory(clientId, userId, {
      eventType: ClientBillingEventType.STATUS_CHANGE,
      fromStatus,
      toStatus: targetStatus,
      remarks: remarks ?? null,
    });

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'CLIENT_BILLING_STATUS_CHANGED',
      entityType: 'CLIENT',
      entityId: clientId,
      userId,
      remarks: `Billing status ${fromStatus} -> ${targetStatus}`,
    });

    return saved;
  }

  async addBillingRemark(clientId: string, remarks: string, userId: string): Promise<ClientBillingHistoryEntity> {
    await this.findOne(clientId);
    const billing = await this.billingRepository.findOne({ where: { clientId } });
    if (!billing) {
      throw new NotFoundException('Billing profile not found for this client.');
    }
    const entry = await this.recordBillingHistory(clientId, userId, {
      eventType: ClientBillingEventType.REMARK,
      remarks,
    });

    // Billing status changes reach audit_events; a remark against the same billing profile did
    // not, so a note explaining why an invoice was held existed only in the billing history and
    // was invisible to the client's unified trail.
    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'CLIENT_BILLING_REMARK_ADDED',
      entityType: 'CLIENT',
      entityId: clientId,
      userId,
      remarks,
      metadata: { billingHistoryId: entry.id },
    });

    return entry;
  }

  async findBillingHistory(clientId: string): Promise<ClientBillingHistoryEntity[]> {
    await this.findOne(clientId);
    return this.billingHistoryRepository.find({
      where: { clientId },
      order: { createdAt: 'DESC' },
    });
  }
}
