import { BaseEntity } from '../../core/entities/base.entity';
import { CapabilityEntity } from './capability.entity';
export declare class ResponsibilityEntity extends BaseEntity {
    name: string;
    displayName: string;
    description: string;
    capabilities: CapabilityEntity[];
}
