import { Injectable } from '@nestjs/common';
import { PlanningBranchProvider, AssayerAvailabilityProvider, WorkloadProvider } from './planning-providers.interface';
import { PlanningBranch, BranchId, PlanningAssayer, AssayerId, SkillSet } from './planning-domain-contracts';
import { GeoCoordinate } from '../../core/value-objects/geo-coordinate.value-object';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity, AssayerWithWorkforceAttributes } from '../assayer/assayer.entity';
import { AssayerService } from '../assayer/assayer.service';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssayerStatus } from '@fapoms/shared';
import { COMMITTED_ASSIGNMENT_STATUSES } from '../assignment/assignment-workload';

@Injectable()
export class PlanningAntiCorruptionLayer
  implements PlanningBranchProvider, AssayerAvailabilityProvider, WorkloadProvider
{
  constructor(
    @InjectRepository(BranchEntity)
    private readonly branchRepository: Repository<BranchEntity>,
    @InjectRepository(AssayerEntity)
    private readonly assayerRepository: Repository<AssayerEntity>,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    @InjectRepository(ProjectBranchEntity)
    private readonly projectBranchRepository: Repository<ProjectBranchEntity>,
    private readonly assayerService: AssayerService,
  ) {}

  async getBranchesForPlanning(projectId: string): Promise<PlanningBranch[]> {
    const projectBranches = await this.projectBranchRepository.find({
      where: { projectId, isActive: true },
      relations: ['branch'],
    });

    return projectBranches.map((pb) => {
      const b = pb.branch;
      return {
        branchId: new BranchId(b.id),
        branchCode: b.branchCode,
        name: b.name,
        location: new GeoCoordinate(b.latitude || 0, b.longitude || 0),
        city: b.city,
        state: b.state,
        requiredSkills: new SkillSet(b.requiredCompetencies || []),
      };
    });
  }

  async getAvailableAssayers(date: Date): Promise<PlanningAssayer[]> {
    const assayers = await this.assayerRepository.find({
      where: { isActive: true, status: AssayerStatus.ACTIVE },
    });
    await this.assayerService.hydrateAllWorkforceAttributes(assayers);

    return (assayers as AssayerWithWorkforceAttributes[]).map((a) => {
      return {
        assayerId: new AssayerId(a.id),
        displayName: a.displayName,
        status: a.status,
        location: new GeoCoordinate(a.effectiveLatitude || 0, a.effectiveLongitude || 0),
        skills: new SkillSet(a.skills || []),
        maxWeeklyWorkload: a.maxWeeklyWorkload || 15,
      };
    });
  }

  async getAssayerCurrentWorkloads(assayerIds: string[]): Promise<Record<string, number>> {
    if (assayerIds.length === 0) return {};

    /**
     * Committed work only. This used to load every assignment with `isActive = true` and no
     * status filter, then count them — and because terminal states deliberately keep isActive
     * set, completed, rejected and cancelled work all counted as current load. The coverage
     * planner hard-filters candidates on this number, so assayers were being dropped from
     * plans for work they had already delivered.
     */
    const rows = await this.assignmentRepository
      .createQueryBuilder('a')
      .select('a.assayerId', 'assayerId')
      .addSelect('COUNT(*)', 'count')
      .where('a.assayerId IN (:...assayerIds)', { assayerIds })
      .andWhere('a.status IN (:...statuses)', { statuses: COMMITTED_ASSIGNMENT_STATUSES })
      .andWhere('a.isActive = true')
      .groupBy('a.assayerId')
      .getRawMany();

    const counts: Record<string, number> = {};
    for (const r of rows) {
      counts[r.assayerId] = Number(r.count);
    }
    return counts;
  }
}
