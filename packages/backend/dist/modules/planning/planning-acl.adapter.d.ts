import { PlanningBranchProvider, AssayerAvailabilityProvider, WorkloadProvider } from './planning-providers.interface';
import { PlanningBranch, PlanningAssayer } from './planning-domain-contracts';
import { Repository } from 'typeorm';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssayerService } from '../assayer/assayer.service';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
export declare class PlanningAntiCorruptionLayer implements PlanningBranchProvider, AssayerAvailabilityProvider, WorkloadProvider {
    private readonly branchRepository;
    private readonly assayerRepository;
    private readonly assignmentRepository;
    private readonly projectBranchRepository;
    private readonly assayerService;
    constructor(branchRepository: Repository<BranchEntity>, assayerRepository: Repository<AssayerEntity>, assignmentRepository: Repository<AssignmentEntity>, projectBranchRepository: Repository<ProjectBranchEntity>, assayerService: AssayerService);
    getBranchesForPlanning(projectId: string): Promise<PlanningBranch[]>;
    getAvailableAssayers(date: Date): Promise<PlanningAssayer[]>;
    getAssayerCurrentWorkloads(assayerIds: string[]): Promise<Record<string, number>>;
}
