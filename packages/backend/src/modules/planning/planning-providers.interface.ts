import { PlanningBranch, PlanningAssayer } from './planning-domain-contracts';
import { GlobalScope } from '../../infrastructure/scope/global-scope';

/**
 * `scope` is optional on both providers so the domain engine stays ignorant of *how* the
 * caller is narrowed — it passes whatever it was given straight through. Omitting it means
 * "everything", which is what the background planning jobs (no request, no principal) need.
 */
export interface PlanningBranchProvider {
  getBranchesForPlanning(projectId: string, scope?: Partial<GlobalScope>): Promise<PlanningBranch[]>;
}

export interface AssayerAvailabilityProvider {
  getAvailableAssayers(date: Date, scope?: Partial<GlobalScope>): Promise<PlanningAssayer[]>;
}

export interface WorkloadProvider {
  getAssayerCurrentWorkloads(assayerIds: string[]): Promise<Record<string, number>>;
}
