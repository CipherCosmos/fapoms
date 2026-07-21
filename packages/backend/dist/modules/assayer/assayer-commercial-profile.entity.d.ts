import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerEntity } from './assayer.entity';
export declare class AssayerCommercialProfileEntity extends BaseEntity {
    assayerId: string;
    assayer: AssayerEntity;
    baseFee: number;
    hourlyRate: number;
    dailyRate: number;
    travelReimbursement: number;
    accommodationAllowance: number;
    mealAllowance: number;
    currency: string;
    effectiveStartDate: Date;
    effectiveEndDate: Date | null;
}
