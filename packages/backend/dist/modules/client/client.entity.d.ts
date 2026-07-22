import { BaseEntity } from '../../core/entities/base.entity';
import type { ClientContactEntity } from './client-contact.entity';
import type { ClientContractEntity } from './client-contract.entity';
import type { ClientBillingEntity } from './client-billing.entity';
export declare class ClientEntity extends BaseEntity {
    clientCode: string;
    name: string;
    displayName: string;
    website: string | null;
    industry: string | null;
    clientType: string;
    registrationNumber: string | null;
    taxId: string | null;
    lifecycleStatus: string;
    organizationId: string | null;
    contactPerson: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    address: string | null;
    configuration: any;
    contacts: ClientContactEntity[];
    contracts: ClientContractEntity[];
    billing: ClientBillingEntity;
    priority: string;
    budget: number | null;
    preferredAssayers: string[] | null;
    restrictedAssayers: string[] | null;
    planningPreferences: Record<string, any> | null;
}
