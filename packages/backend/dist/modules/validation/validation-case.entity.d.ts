import { BaseEntity } from '../../core/entities/base.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { ValidationStatus } from '@fapoms/shared';
export declare class ValidationCaseEntity extends BaseEntity {
    projectBranchId: string;
    status: ValidationStatus;
    ocrResult: any | null;
    reviewerId: string | null;
    reviewedAt: Date | null;
    remarks: string | null;
    correctionNotes: string | null;
    projectBranch: ProjectBranchEntity;
}
