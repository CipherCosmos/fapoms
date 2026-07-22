import { BaseEntity } from '../../core/entities/base.entity';
import { ClientEntity } from '../client/client.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { ProjectStatus, Priority } from '@fapoms/shared';
export declare class ProjectEntity extends BaseEntity {
    projectNumber: string;
    name: string;
    description: string | null;
    organizationId: string | null;
    clientId: string;
    status: ProjectStatus;
    priority: Priority;
    startDate: Date | null;
    endDate: Date | null;
    budget: number | null;
    scope: string | null;
    requiredSkills: string[] | null;
    requiredCertifications: string[] | null;
    sla: Record<string, any> | null;
    risks: Record<string, any> | null;
    milestones: Record<string, any> | null;
    dependencies: Record<string, any> | null;
    client: ClientEntity;
    projectBranches: ProjectBranchEntity[];
}
