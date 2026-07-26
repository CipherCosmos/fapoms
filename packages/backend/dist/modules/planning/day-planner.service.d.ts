import { Repository } from 'typeorm';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { ProjectEntity } from '../project/project.entity';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssayerService } from '../assayer/assayer.service';
import { ClientEntity } from '../client/client.entity';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { RoutingService } from '../geo/routing.provider';
import { RecommendationEngine } from './recommendation.engine';
import { ConstraintEvaluator } from './constraint.evaluator';
export interface DayPlanStop {
    order: number;
    branchId: string;
    branchName: string;
    branchCode: string;
    address: string;
    latitude: number;
    longitude: number;
    estimatedAuditHours: number;
    travelFromPreviousKm: number;
    travelFromPreviousMinutes: number;
    estimatedArrival: string;
    estimatedDeparture: string;
}
export interface DayPlanCandidate {
    assayerId: string;
    assayerName: string;
    assayerCode: string;
    assayerCity: string;
    assayerPhone: string;
    overallScore: number;
    totalBranches: number;
    totalAuditHours: number;
    totalTravelKm: number;
    totalTravelMinutes: number;
    totalDayHours: number;
    estimatedBaseFee: number;
    estimatedTravelFee: number;
    estimatedTotalCost: number;
    dayStartTime: string;
    dayEndTime: string;
    utilizationPercent: number;
    stops: DayPlanStop[];
    clientPreferencesMatch: {
        skillsMatch: boolean;
        certificationsMatch: boolean;
        distanceWithinRange: boolean;
        isPreferredAssayer: boolean;
    };
}
export interface BranchCluster {
    clusterId: string;
    centerLatitude: number;
    centerLongitude: number;
    radiusKm: number;
    branches: Array<{
        id: string;
        branchId: string;
        branchName: string;
        branchCode: string;
        latitude: number;
        longitude: number;
        estimatedDurationHours: number;
        district: string;
        city: string;
    }>;
    totalEstimatedAuditHours: number;
    feasibleForOneDay: boolean;
}
export interface ProjectDayPlan {
    projectId: string;
    projectName: string;
    targetDate: string;
    clusters: Array<{
        cluster: BranchCluster;
        dayPlans: DayPlanCandidate[];
        bestPlan: DayPlanCandidate | null;
    }>;
    unclusteredBranches: Array<{
        branchId: string;
        branchName: string;
        reason: string;
    }>;
    summary: {
        totalClusters: number;
        totalBranchesCovered: number;
        totalAssayersNeeded: number;
        estimatedTotalCost: number;
        averageUtilization: number;
    };
}
export declare class DayPlannerService {
    private readonly projectBranchRepository;
    private readonly projectRepository;
    private readonly branchRepository;
    private readonly assayerRepository;
    private readonly clientRepository;
    private readonly commercialRepository;
    private readonly routingService;
    private readonly recommendationEngine;
    private readonly constraintEvaluator;
    private readonly assayerService;
    private readonly logger;
    constructor(projectBranchRepository: Repository<ProjectBranchEntity>, projectRepository: Repository<ProjectEntity>, branchRepository: Repository<BranchEntity>, assayerRepository: Repository<AssayerEntity>, clientRepository: Repository<ClientEntity>, commercialRepository: Repository<AssayerCommercialProfileEntity>, routingService: RoutingService, recommendationEngine: RecommendationEngine, constraintEvaluator: ConstraintEvaluator, assayerService: AssayerService);
    generateDayPlans(projectId: string, targetDate?: string): Promise<ProjectDayPlan>;
    private clusterBranches;
    private buildCluster;
    private splitInfeasibleCluster;
    private generateClusterDayPlans;
    private globalOptimizeAssignments;
    private minutesToTime;
    private emptyPlan;
}
