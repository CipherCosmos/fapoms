import { BaseEntity } from '../../core/entities/base.entity';
import { PermissionEntity } from './permission.entity';
export declare class CapabilityEntity extends BaseEntity {
    name: string;
    displayName: string;
    description: string;
    category: string;
    permissions: PermissionEntity[];
}
