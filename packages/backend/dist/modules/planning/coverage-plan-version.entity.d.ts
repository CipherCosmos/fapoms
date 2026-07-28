import { BaseEntity } from '../../core/entities/base.entity';
import { CoveragePlanEntity } from './coverage-plan.entity';
export declare class CoveragePlanVersionEntity extends BaseEntity {
    coveragePlanId: string;
    versionNumber: number;
    planData: any;
    overrides: any;
    changeJustification: string | null;
    coveragePlan: CoveragePlanEntity;
}
