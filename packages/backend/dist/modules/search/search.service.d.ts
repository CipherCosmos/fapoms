import { Repository } from 'typeorm';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { ProjectEntity } from '../project/project.entity';
import { ClientEntity } from '../client/client.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
export declare class SearchService {
    private readonly branchRepo;
    private readonly assayerRepo;
    private readonly projectRepo;
    private readonly clientRepo;
    private readonly assignmentRepo;
    constructor(branchRepo: Repository<BranchEntity>, assayerRepo: Repository<AssayerEntity>, projectRepo: Repository<ProjectEntity>, clientRepo: Repository<ClientEntity>, assignmentRepo: Repository<AssignmentEntity>);
    searchAll(q: string): Promise<{
        branches: {
            id: string;
            name: string;
            code: string;
            city: string;
            state: string;
        }[];
        assayers: {
            id: string;
            name: string;
            code: string;
            phone: string;
        }[];
        projects: {
            id: string;
            name: string;
            projectNumber: string;
        }[];
        clients: {
            id: string;
            name: string;
            code: string;
        }[];
        assignments: {
            id: string;
            assignmentNumber: string;
            branchName: string;
            assayerName: string;
        }[];
    }>;
}
