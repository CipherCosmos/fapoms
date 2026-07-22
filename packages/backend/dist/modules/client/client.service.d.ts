import { Repository } from 'typeorm';
import { ClientEntity } from './client.entity';
import { ClientConfigurationEntity } from './client-configuration.entity';
import { ClientContactEntity } from './client-contact.entity';
import { ClientContractEntity } from './client-contract.entity';
import { ClientBillingEntity } from './client-billing.entity';
import { AuditService } from '../../core/audit/audit.service';
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
export declare class ClientService {
    private readonly clientRepository;
    private readonly configRepository;
    private readonly contactRepository;
    private readonly contractRepository;
    private readonly billingRepository;
    private readonly auditService;
    constructor(clientRepository: Repository<ClientEntity>, configRepository: Repository<ClientConfigurationEntity>, contactRepository: Repository<ClientContactEntity>, contractRepository: Repository<ClientContractEntity>, billingRepository: Repository<ClientBillingEntity>, auditService: AuditService);
    create(dto: CreateClientDto, userId: string): Promise<ClientEntity>;
    findOne(id: string): Promise<ClientEntity>;
    findAll(page?: number, limit?: number): Promise<{
        clients: ClientEntity[];
        total: number;
    }>;
    update(id: string, dto: UpdateClientDto, userId: string): Promise<ClientEntity>;
    remove(id: string, userId: string): Promise<void>;
    transitionLifecycle(id: string, newStatus: string, userId: string, reason?: string): Promise<ClientEntity>;
    findContacts(clientId: string): Promise<ClientContactEntity[]>;
    addContact(clientId: string, dto: CreateContactDto, userId: string): Promise<ClientContactEntity>;
    updateContact(contactId: string, dto: UpdateContactDto, userId: string): Promise<ClientContactEntity>;
    removeContact(contactId: string, userId: string): Promise<void>;
    findContracts(clientId: string): Promise<ClientContractEntity[]>;
    addContract(clientId: string, dto: CreateContractDto, userId: string): Promise<ClientContractEntity>;
    updateContract(contractId: string, dto: UpdateContractDto, userId: string): Promise<ClientContractEntity>;
    removeContract(contractId: string, userId: string): Promise<void>;
    findBilling(clientId: string): Promise<ClientBillingEntity | null>;
    upsertBilling(clientId: string, dto: UpdateBillingDto, userId: string): Promise<ClientBillingEntity>;
}
