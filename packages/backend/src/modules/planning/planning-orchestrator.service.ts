import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { ProjectBranchStatus } from '@fapoms/shared';

@Injectable()
export class PlanningOrchestratorService {
  constructor(
    @InjectRepository(ProjectBranchEntity)
    private readonly projectBranchRepository: Repository<ProjectBranchEntity>,
  ) {}

  async getProjectCoverage(projectId: string) {
    const branches = await this.projectBranchRepository.find({
      where: { projectId, isActive: true },
    });

    const total = branches.length;
    const scheduled = branches.filter(
      (b) => b.status === ProjectBranchStatus.SCHEDULED || b.status === ProjectBranchStatus.CLOSED || b.status === ProjectBranchStatus.VALIDATION_COMPLETED
    ).length;
    const confirmed = branches.filter(
      (b) => b.status === ProjectBranchStatus.ASSIGNMENT_CONFIRMED
    ).length;
    const remaining = total - (scheduled + confirmed);

    const coveragePercentage = total > 0 ? parseFloat((((scheduled + confirmed) / total) * 100).toFixed(1)) : 0;

    return {
      total,
      scheduled,
      confirmed,
      remaining,
      coveragePercentage,
    };
  }
}
