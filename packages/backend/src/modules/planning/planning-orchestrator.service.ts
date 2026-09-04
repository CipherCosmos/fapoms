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
    // Aggregate the status distribution in the database instead of pulling
    // every branch row into app memory just to bucket-count them.
    const rows = await this.projectBranchRepository
      .createQueryBuilder('pb')
      .where('pb.projectId = :projectId', { projectId })
      .andWhere('pb.isActive = :isActive', { isActive: true })
      .select('pb.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('pb.status')
      .getRawMany<{ status: ProjectBranchStatus; count: string }>();

    const countsByStatus = new Map<ProjectBranchStatus, number>(
      rows.map((r) => [r.status, parseInt(r.count, 10)]),
    );

    const total = Array.from(countsByStatus.values()).reduce((sum, c) => sum + c, 0);
    const scheduled =
      (countsByStatus.get(ProjectBranchStatus.SCHEDULED) ?? 0) +
      (countsByStatus.get(ProjectBranchStatus.CLOSED) ?? 0) +
      (countsByStatus.get(ProjectBranchStatus.VALIDATION_COMPLETED) ?? 0);
    const confirmed = countsByStatus.get(ProjectBranchStatus.ASSIGNMENT_CONFIRMED) ?? 0;
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
