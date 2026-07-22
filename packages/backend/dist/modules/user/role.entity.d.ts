import { BaseEntity } from '../../core/entities/base.entity';
import { PermissionEntity } from './permission.entity';
import { ResponsibilityEntity } from './responsibility.entity';
export declare class RoleEntity extends BaseEntity {
    name: string;
    displayName: string;
    description: string;
    permissions: PermissionEntity[];
    responsibilities: ResponsibilityEntity[];
}
