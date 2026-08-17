import { Injectable, NotFoundException } from '@nestjs/common';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import { ProjectQueryService } from '../project/project-query.service';
import { RecommendationEngine } from './recommendation.engine';
import { PlanningService, AssayerRecommendation } from './planning.service';
// Type-only: the report counts branches, and stays ignorant of whether a queue is watching.
import type { ProgressCallback } from '../../infrastructure/queue/queued-job';

export interface ProjectBranchCandidates {
  projectBranchId: string;
  branchId: string;
  branchCode: string;
  branchName: string;
  city: string;
  state: string;
  /** The shortlist — top N by score, N being the report's `candidatesPerBranch`. */
  candidates: AssayerRecommendation[];
  /** How many candidates the engine actually ranked for this branch, before the shortlist. */
  candidateCount: number;
}

export interface ProjectPlanningReport {
  projectId: string;
  projectName: string;
  projectNumber: string;
  totalUnassignedBranches: number;
  branches: ProjectBranchCandidates[];
  /** The shortlist depth each branch was trimmed to; compare against each `candidateCount`. */
  candidatesPerBranch: number;
}

@Injectable()
export class ProjectPlanningService {
  constructor(
    private readonly projectQueryService: ProjectQueryService,
    private readonly planningService: PlanningService,
  ) {}

  /**
   * How many ranked candidates each branch carries in a project-wide report.
   *
   * The report ran the engine per unassigned branch and returned every ranked candidate for
   * each, with its score breakdown and readable reasons: measured at 39 MB for a 200-branch
   * project. Nobody triages a queue by reading the 40th-best assayer for the 87th branch — the
   * shortlist is what the answer is for, and the full list is one branch-level call away.
   * `candidateCount` on each branch reports how many were actually ranked, so a truncated
   * shortlist never reads as "only five people were eligible".
   */
  private static readonly CANDIDATES_PER_BRANCH =
    Number(process.env.PROJECT_CANDIDATES_PER_BRANCH) || 5;

  /**
   * Retrieves recommended candidates for all unassigned branches of a project.
   *
   * @param onProgress Optional "branch N of M" hook, supplied when this runs as a queued job.
   *   The loop below runs the whole recommendation engine once per unassigned branch and is
   *   where all of the measured 12.2 s (200-branch project, scale database) goes, so it is the
   *   only phase worth reporting. The synchronous route passes nothing and behaves as before.
   */
  async getProjectPlanningCandidates(
    projectId: string,
    scope?: Partial<GlobalScope>,
    onProgress?: ProgressCallback,
  ): Promise<ProjectPlanningReport> {
    const project = await this.projectQueryService.findOne(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found.`);
    }

    // Scoped: planning is a territorial desk, and this endpoint returns branch identifiers plus
    // recommended assayers for every unassigned branch. Unscoped it handed a West operator the
    // whole national project — the branch list *and* the candidate assayers for each — because a
    // multi-region project legitimately appears in their project list the moment one of its
    // branches is in the West.
    const projectBranches = await this.projectQueryService.findProjectBranches(projectId, scope);
    
    // Filter to unassigned/imported/planning status branches
    const unassignedPBs = projectBranches.filter(
      (pb) => pb.status === 'IMPORTED' || pb.status === 'PLANNING' || pb.status === 'CANDIDATE_SEARCH'
    );

    const branchCandidatesList: ProjectBranchCandidates[] = [];

    for (const pb of unassignedPBs) {
      let candidates: AssayerRecommendation[] = [];
      try {
        candidates = await this.planningService.getRecommendedCandidates(pb.branchId);
      } catch (err) {
        // Log error and default to empty candidates list for robustness
        console.error(`Failed to load candidates for branch ${pb.branchId}:`, err);
      }

      branchCandidatesList.push({
        projectBranchId: pb.id,
        branchId: pb.branchId,
        branchCode: pb.branch.branchCode,
        branchName: pb.branch.name,
        city: pb.branch.city,
        state: pb.branch.state,
        // The shortlist, plus how deep the ranking actually went.
        candidates: candidates.slice(0, ProjectPlanningService.CANDIDATES_PER_BRANCH),
        candidateCount: candidates.length,
      });

      await onProgress?.(branchCandidatesList.length, unassignedPBs.length, 'Ranking candidates');
    }

    return {
      projectId: project.id,
      projectName: project.name,
      projectNumber: project.projectNumber,
      totalUnassignedBranches: unassignedPBs.length,
      branches: branchCandidatesList,
      candidatesPerBranch: ProjectPlanningService.CANDIDATES_PER_BRANCH,
    };
  }
}
