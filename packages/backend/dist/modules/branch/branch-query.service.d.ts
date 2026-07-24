import { Repository } from 'typeorm';
import { BranchEntity } from './branch.entity';
export declare class BranchQueryService {
    private readonly branchRepository;
    constructor(branchRepository: Repository<BranchEntity>);
    findOne(id: string): Promise<BranchEntity>;
    findAll(page?: number, limit?: number, clientId?: string, region?: string, zoneId?: string): Promise<{
        branches: BranchEntity[];
        total: number;
    }>;
    findOneByCode(branchCode: string): Promise<BranchEntity | null>;
}
