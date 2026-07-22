import { BaseEntity } from '../../core/entities/base.entity';
export declare class OrganizationEntity extends BaseEntity {
    name: string;
    code: string;
    displayName: string | null;
    description: string | null;
    address: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    taxId: string | null;
    registrationNumber: string | null;
}
