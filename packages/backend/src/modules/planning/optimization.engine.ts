import { Injectable, NotFoundException } from '@nestjs/common';
import { ProjectQueryService } from '../project/project-query.service';
import { PlanningService, AssayerRecommendation } from './planning.service';
import { ConstraintEvaluator } from './constraint.evaluator';

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

    // Keep track of dynamically consumed workloads during planning
    // Key: assayerId, Value: number of assignments made in this run
    const simulatedWorkloadMap: Record<string, number> = {};

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
      const validCandidates = candidates.filter((c) => {
        const capacityLimit = 15; // default weekly workload capacity
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
