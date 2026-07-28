import { PlanningBranch, PlanningAssayer } from './planning-domain-contracts';
export interface PlanningBranchProvider {
    getBranchesForPlanning(projectId: string): Promise<PlanningBranch[]>;
}
export interface AssayerAvailabilityProvider {
    getAvailableAssayers(date: Date): Promise<PlanningAssayer[]>;
}
export interface WorkloadProvider {
    getAssayerCurrentWorkloads(assayerIds: string[]): Promise<Record<string, number>>;
}
