import { BaseEntity } from '../../core/entities/base.entity';
import { CoveragePlanVersionEntity } from './coverage-plan-version.entity';
export declare enum CoveragePlanStatus {
    DRAFT = "DRAFT",
    GENERATED = "GENERATED",
    UNDER_REVIEW = "UNDER_REVIEW",
    APPROVED = "APPROVED",
    LOCKED = "LOCKED",
    DEPLOYED = "DEPLOYED",
    ARCHIVED = "ARCHIVED"
}
export declare class CoveragePlanEntity extends BaseEntity {
    projectId: string;
    status: CoveragePlanStatus;
    currentVersion: number;
    versions: CoveragePlanVersionEntity[];
}
