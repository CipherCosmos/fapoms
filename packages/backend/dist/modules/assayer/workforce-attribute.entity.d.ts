import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerEntity } from './assayer.entity';
export declare class WorkforceAttributeEntity extends BaseEntity {
    assayerId: string;
    assayer: AssayerEntity;
    type: string;
    name: string;
    level: string | null;
    expiryDate: Date | null;
    metadata: Record<string, any> | null;
}
