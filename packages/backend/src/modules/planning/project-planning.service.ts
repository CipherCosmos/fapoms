import { Injectable, NotFoundException } from '@nestjs/common';
import { ProjectQueryService } from '../project/project-query.service';
import { RecommendationEngine } from './recommendation.engine';
import { PlanningService, AssayerRecommendation } from './planning.service';

export interface ProjectBranchCandidates {
  projectBranchId: string;
  branchId: string;
  branchCode: string;
  branchName: string;
  city: string;
  state: string;
  candidates: AssayerRecommendation[];
}

export interface ProjectPlanningReport {
  projectId: string;
  projectName: string;
  projectNumber: string;
  totalUnassignedBranches: number;
  branches: ProjectBranchCandidates[];
}

@Injectable()
export class ProjectPlanningService {
  constructor(
    private readonly projectQueryService: ProjectQueryService,
    private readonly planningService: PlanningService,
  ) {}

  /**
   * Retrieves recommended candidates for all unassigned branches of a project.
   */
  async getProjectPlanningCandidates(projectId: string): Promise<ProjectPlanningReport> {
    const project = await this.projectQueryService.findOne(projectId);
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found.`);
    }

    const projectBranches = await this.projectQueryService.findProjectBranches(projectId);
    
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
        candidates,
      });
    }

    return {
      projectId: project.id,
      projectName: project.name,
      projectNumber: project.projectNumber,
      totalUnassignedBranches: unassignedPBs.length,
      branches: branchCandidatesList,
    };
  }
}
