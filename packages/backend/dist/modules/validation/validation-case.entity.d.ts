import { BaseEntity } from '../../core/entities/base.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { ValidationStatus } from '@fapoms/shared';
export declare class ValidationCaseEntity extends BaseEntity {
    projectBranchId: string;
    assessmentId: string | null;
    status: ValidationStatus;
    ocrResult: any | null;
    reviewerId: string | null;
    reviewedAt: Date | null;
    remarks: string | null;
    correctionNotes: string | null;
    projectBranch: ProjectBranchEntity;
    assessment: AssessmentEntity | null;
}
