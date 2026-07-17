import { BaseEntity } from '../../core/entities/base.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { ProjectEntity } from '../project/project.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssignmentStatus } from '@fapoms/shared';
export declare class AssignmentEntity extends BaseEntity {
    assignmentNumber: string;
    projectBranchId: string;
    projectId: string;
    assayerId: string;
    status: AssignmentStatus;
    proposedFee: number | null;
    agreedFee: number | null;
    scheduledDate: Date | null;
    completionDate: Date | null;
    remarks: string | null;
    cancelReason: string | null;
    rejectReason: string | null;
    projectBranch: ProjectBranchEntity;
    project: ProjectEntity;
    assayer: AssayerEntity;
}
