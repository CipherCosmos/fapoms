import { BaseEntity } from '../../core/entities/base.entity';
export declare class PermissionEntity extends BaseEntity {
    resource: string;
    action: string;
    scope: string;
    description: string;
}
