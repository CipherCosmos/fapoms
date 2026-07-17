import { BaseEntity } from '../../core/entities/base.entity';
import { ProjectEntity } from './project.entity';
import { BranchEntity } from '../branch/branch.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectBranchStatus, Priority } from '@fapoms/shared';
export declare class ProjectBranchEntity extends BaseEntity {
    projectId: string;
    branchId: string;
    status: ProjectBranchStatus;
    priority: Priority;
    zoneId: string | null;
    scheduledDate: Date | null;
    remarks: string | null;
    project: ProjectEntity;
    branch: BranchEntity;
    assignment: AssignmentEntity | null;
}
