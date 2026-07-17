import { BaseEntity } from '../../core/entities/base.entity';
import { ClientEntity } from '../client/client.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { ProjectStatus, Priority } from '@fapoms/shared';
export declare class ProjectEntity extends BaseEntity {
    projectNumber: string;
    name: string;
    description: string | null;
    clientId: string;
    status: ProjectStatus;
    priority: Priority;
    startDate: Date | null;
    endDate: Date | null;
    client: ClientEntity;
    projectBranches: ProjectBranchEntity[];
}
