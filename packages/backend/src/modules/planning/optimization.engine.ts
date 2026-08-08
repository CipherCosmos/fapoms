import { Injectable, NotFoundException, Inject } from '@nestjs/common';
import { ProjectQueryService } from '../project/project-query.service';
import { PlanningService, AssayerRecommendation } from './planning.service';
import { ConstraintEvaluator } from './constraint.evaluator';
import { DEFAULT_WEEKLY_CAPACITY } from '../assignment/assignment-workload';
import { WorkloadProvider } from './planning-providers.interface';

export interface OptimizationMatching {
  projectBranchId: string;
  branchId: string;
  branchName: string;
  assignedAssayerId: string;
  assignedAssayerName: string;
  score: number;
}

export interface OptimizationPlan {
  projectId: string;
  projectName: string;
  totalBranchesMatched: number;
  totalBranchesUnmatched: number;
  assignments: OptimizationMatching[];
  unmatchedBranches: Array<{ projectBranchId: string; branchId: string; branchName: string }>;
}

@Injectable()
export class OptimizationEngine {
  constructor(
    private readonly projectQueryService: ProjectQueryService,
    private readonly planningService: PlanningService,
    @Inject('WorkloadProvider')
    private readonly workloadProvider: WorkloadProvider,
  ) {}

  /**
   * Generates an optimized deployment plan for the project using a greedy solver.
   */
  async generateProjectDeploymentPlan(projectId: string): Promise<OptimizationPlan> {
    const project = await this.projectQueryService.findOne(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found.`);
    }

    const projectBranches = await this.projectQueryService.findProjectBranches(projectId);
    // Unassigned branches
    const unassignedPBs = projectBranches.filter(
      (pb) => pb.status === 'IMPORTED' || pb.status === 'PLANNING' || pb.status === 'CANDIDATE_SEARCH'
    );

    /**
     * Workload consumed as this run allocates, seeded with what each assayer already owes.
     *
     * This map used to start empty, so the optimizer believed every assayer was completely free
     * however much work they were already committed to, and would pile a full notional week on
     * top of an existing one. It is now seeded from the same reader the coverage planner uses.
     */
    const simulatedWorkloadMap: Record<string, number> = {};
    const capacityByAssayer: Record<string, number> = {};

    const assignments: OptimizationMatching[] = [];
    const unmatchedBranches: Array<{ projectBranchId: string; branchId: string; branchName: string }> = [];

    for (const pb of unassignedPBs) {
      let candidates: AssayerRecommendation[] = [];
      try {
        candidates = await this.planningService.getRecommendedCandidates(pb.branchId);
      } catch (err) {
        console.error(`Failed to fetch recommendations for branch ${pb.branchId}:`, err);
      }

      // Filter out candidates whose simulated workload capacity has been reached in this run.
      // Filter out candidates with very low scores (under 30) for quality assurance.
      // Seed each newly-seen candidate with their real committed load and their own cap, rather
      // than assuming everyone is idle and everyone's limit is the same number.
      const unseen = candidates.map((c) => c.id).filter((id) => !(id in simulatedWorkloadMap));
      if (unseen.length > 0) {
        const existing = await this.workloadProvider.getAssayerCurrentWorkloads(unseen);
        for (const id of unseen) {
          simulatedWorkloadMap[id] = existing[id] ?? 0;
        }
      }
      for (const c of candidates) {
        capacityByAssayer[c.id] = c.maxWeeklyWorkload || DEFAULT_WEEKLY_CAPACITY;
      }

      // Filter out candidates whose capacity is exhausted, and very low scores (under 30).
      const validCandidates = candidates.filter((c) => {
        const capacityLimit = capacityByAssayer[c.id] ?? DEFAULT_WEEKLY_CAPACITY;
        const currentSimulatedLoad = simulatedWorkloadMap[c.id] || 0;
        return currentSimulatedLoad < capacityLimit && (c.score === undefined || c.score >= 30);
      });

      if (validCandidates.length > 0) {
        // Greedy choice: assign highest scoring candidate
        const bestCandidate = validCandidates[0];
        assignments.push({
          projectBranchId: pb.id,
          branchId: pb.branchId,
          branchName: pb.branch.name,
          assignedAssayerId: bestCandidate.id,
          assignedAssayerName: bestCandidate.displayName,
          score: bestCandidate.score || 0,
        });

        // Track workload allocation
        simulatedWorkloadMap[bestCandidate.id] = (simulatedWorkloadMap[bestCandidate.id] || 0) + 1;
      } else {
        unmatchedBranches.push({
          projectBranchId: pb.id,
          branchId: pb.branchId,
          branchName: pb.branch.name,
        });
      }
    }

    return {
      projectId: project.id,
      projectName: project.name,
      totalBranchesMatched: assignments.length,
      totalBranchesUnmatched: unmatchedBranches.length,
      assignments,
      unmatchedBranches,
    };
  }
}
