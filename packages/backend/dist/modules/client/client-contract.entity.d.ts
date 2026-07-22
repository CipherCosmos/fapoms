import { BaseEntity } from '../../core/entities/base.entity';
import type { ClientEntity } from './client.entity';
export declare class ClientContractEntity extends BaseEntity {
    clientId: string;
    client: ClientEntity;
    contractNumber: string;
    title: string;
    description: string | null;
    signedDate: string | null;
    effectiveFrom: string;
    effectiveTo: string | null;
    value: number | null;
    currency: string;
    status: string;
    terms: Record<string, any> | null;
    documentUrl: string | null;
}
