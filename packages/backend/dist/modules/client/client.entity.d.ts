import { BaseEntity } from '../../core/entities/base.entity';
export declare class ClientEntity extends BaseEntity {
    clientCode: string;
    name: string;
    displayName: string;
    contactPerson: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    address: string | null;
    configuration: any;
}
