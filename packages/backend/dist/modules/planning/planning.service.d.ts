import { Repository } from 'typeorm';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
export interface AssayerRecommendation {
    id: string;
    assayerCode: string;
    displayName: string;
    phone: string;
    email: string | null;
    status: string;
    state: string;
    district: string;
    city: string;
    distanceKm: number | null;
}
export declare class PlanningService {
    private readonly branchRepository;
    private readonly assayerRepository;
    constructor(branchRepository: Repository<BranchEntity>, assayerRepository: Repository<AssayerEntity>);
    getRecommendedCandidates(branchId: string): Promise<AssayerRecommendation[]>;
}
