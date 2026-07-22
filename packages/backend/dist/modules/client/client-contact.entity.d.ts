import { BaseEntity } from '../../core/entities/base.entity';
import type { ClientEntity } from './client.entity';
export declare class ClientContactEntity extends BaseEntity {
    clientId: string;
    client: ClientEntity;
    name: string;
    email: string;
    phone: string;
    designation: string;
    department: string | null;
    isPrimary: boolean;
    notes: string | null;
}
