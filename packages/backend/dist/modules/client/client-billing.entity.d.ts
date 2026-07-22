import { BaseEntity } from '../../core/entities/base.entity';
import type { ClientEntity } from './client.entity';
export declare class ClientBillingEntity extends BaseEntity {
    clientId: string;
    client: ClientEntity;
    paymentTerms: string;
    currency: string;
    taxIdentifier: string | null;
    invoiceCycle: string;
    billingAddress: string;
    bankAccount: string | null;
    bankName: string | null;
    ifscCode: string | null;
    notes: string | null;
}
