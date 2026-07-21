import { BaseEntity } from '../../core/entities/base.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectEntity } from '../project/project.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { ScheduleStatus } from '@fapoms/shared';
export declare class ScheduleEntity extends BaseEntity {
    assignmentId: string;
    projectId: string;
    assayerId: string;
    scheduledDate: Date;
    status: ScheduleStatus;
    remarks: string | null;
    assignment: AssignmentEntity;
    project: ProjectEntity;
    assayer: AssayerEntity;
}
