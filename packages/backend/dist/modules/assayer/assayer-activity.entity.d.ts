import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerEntity } from './assayer.entity';
export declare class AssayerActivityEntity extends BaseEntity {
    assayerId: string;
    assayer: AssayerEntity;
    eventType: string;
    previousState: string | null;
    newState: string | null;
    performedBy: string;
    performedByName: string | null;
    remarks: string | null;
    metadata: Record<string, any> | null;
    occurredAt: Date;
}
