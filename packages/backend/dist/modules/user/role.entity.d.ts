import { BaseEntity } from '../../core/entities/base.entity';
import { PermissionEntity } from './permission.entity';
export declare class RoleEntity extends BaseEntity {
    name: string;
    displayName: string;
    description: string;
    permissions: PermissionEntity[];
}
