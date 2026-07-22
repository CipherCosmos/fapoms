import { ClientService, CreateClientDto, UpdateClientDto, CreateContactDto, UpdateContactDto, CreateContractDto, UpdateContractDto, UpdateBillingDto } from './client.service';
declare class CreateClientConfigDto {
    importMapping?: Record<string, string>;
    workingDays?: number[];
    defaultRadius?: number;
    slaRules?: Record<string, any>;
    serviceLevel?: string;
    maxResponseTimeHours?: number;
    penaltyRate?: number;
    serviceHours?: Record<string, any>;
}
declare class CreateClientRequestDto implements CreateClientDto {
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
    configuration?: CreateClientConfigDto;
}
declare class UpdateClientRequestDto implements UpdateClientDto {
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
    configuration?: CreateClientConfigDto;
}
declare class CreateContactRequestDto implements CreateContactDto {
    name: string;
    email: string;
    phone: string;
    designation: string;
    department?: string;
    isPrimary?: boolean;
    notes?: string;
}
declare class UpdateContactRequestDto implements UpdateContactDto {
    name?: string;
    email?: string;
    phone?: string;
    designation?: string;
    department?: string;
    isPrimary?: boolean;
    notes?: string;
}
declare class CreateContractRequestDto implements CreateContractDto {
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
declare class UpdateContractRequestDto implements UpdateContractDto {
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
declare class UpdateBillingRequestDto implements UpdateBillingDto {
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
declare class LifecycleTransitionDto {
    status: string;
    reason?: string;
}
export declare class ClientController {
    private readonly clientService;
    constructor(clientService: ClientService);
    create(dto: CreateClientRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./client.entity").ClientEntity;
    }>;
    findAll(page?: number, limit?: number): Promise<{
        success: boolean;
        data: import("./client.entity").ClientEntity[];
        meta: {
            pagination: {
                page: number;
                limit: number;
                total: number;
                totalPages: number;
                hasNext: boolean;
                hasPrevious: boolean;
            };
        };
    }>;
    findOne(id: string): Promise<{
        success: boolean;
        data: import("./client.entity").ClientEntity;
    }>;
    update(id: string, dto: UpdateClientRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./client.entity").ClientEntity;
    }>;
    remove(id: string, req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
    transitionLifecycle(id: string, dto: LifecycleTransitionDto, req: any): Promise<{
        success: boolean;
        data: import("./client.entity").ClientEntity;
    }>;
    findContacts(id: string): Promise<{
        success: boolean;
        data: import("./client-contact.entity").ClientContactEntity[];
    }>;
    addContact(id: string, dto: CreateContactRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./client-contact.entity").ClientContactEntity;
    }>;
    updateContact(contactId: string, dto: UpdateContactRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./client-contact.entity").ClientContactEntity;
    }>;
    removeContact(contactId: string, req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
    findContracts(id: string): Promise<{
        success: boolean;
        data: import("./client-contract.entity").ClientContractEntity[];
    }>;
    addContract(id: string, dto: CreateContractRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./client-contract.entity").ClientContractEntity;
    }>;
    updateContract(contractId: string, dto: UpdateContractRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./client-contract.entity").ClientContractEntity;
    }>;
    removeContract(contractId: string, req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
    findBilling(id: string): Promise<{
        success: boolean;
        data: import("./client-billing.entity").ClientBillingEntity | null;
    }>;
    upsertBilling(id: string, dto: UpdateBillingRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./client-billing.entity").ClientBillingEntity;
    }>;
}
export {};
