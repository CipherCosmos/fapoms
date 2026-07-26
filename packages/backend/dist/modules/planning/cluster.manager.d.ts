import { BranchEntity } from '../branch/branch.entity';
export interface BranchCluster {
    id: string;
    name: string;
    branches: BranchEntity[];
    centerLatitude: number;
    centerLongitude: number;
}
export declare class ClusterManager {
    clusterBranches(branches: BranchEntity[], maxRadiusKm?: number): BranchCluster[];
    private calculateHaversineDistance;
}
