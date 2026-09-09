import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { CoverageBreakdown, ProjectBranchStatus, coverageFromCounts } from '@fapoms/shared';

@Injectable()
export class PlanningOrchestratorService {
  constructor(
    @InjectRepository(ProjectBranchEntity)
    private readonly projectBranchRepository: Repository<ProjectBranchEntity>,
  ) {}

  /**
   * The planning screen's coverage summary.
   *
   * The bucketing used to be written out here, and it disagreed with the client-facing workbook
   * about the same project on the same day — 9.1% here against 45.5% there, because this copy
   * had no COMPLETED bucket and dropped `AUDIT_COMPLETED` into `remaining`, and because `CLOSED`
   * and `VALIDATION_COMPLETED` were summed into the bucket labelled `scheduled`, reporting
   * finished audits to planners as work still to staff. The rule now comes from
   * `coverageFromCounts` in `@fapoms/shared`, which `reports.service.ts` and the planning
   * workspace header also read, so there is one answer and it is the same everywhere.
   *
   * The aggregation stays here: this asks the database for a `GROUP BY status` count rather than
   * pulling every branch row into memory to bucket-count them.
   */
  async getProjectCoverage(projectId: string): Promise<CoverageBreakdown> {
    const rows = await this.projectBranchRepository
      .createQueryBuilder('pb')
      .where('pb.projectId = :projectId', { projectId })
      .andWhere('pb.isActive = :isActive', { isActive: true })
      .select('pb.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('pb.status')
      .getRawMany<{ status: ProjectBranchStatus; count: string }>();

    return coverageFromCounts(rows.map((r) => [r.status, r.count] as const));
  }
}
