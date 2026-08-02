import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectEntity } from './project.entity';
import { ProjectBranchEntity } from './project-branch.entity';

@Injectable()
export class ProjectQueryService {
  constructor(
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    @InjectRepository(ProjectBranchEntity)
    private readonly projectBranchRepository: Repository<ProjectBranchEntity>,
  ) {}

  async findOne(id: string): Promise<ProjectEntity> {
    const project = await this.projectRepository.findOne({
      where: { id, isActive: true },
      relations: ['client'],
    });
    if (!project) {
      throw new NotFoundException(`Project ${id} not found.`);
    }
    return project;
  }

  async findAll(page = 1, limit = 50): Promise<{ projects: ProjectEntity[]; total: number }> {
    const [projects, total] = await this.projectRepository.findAndCount({
      where: { isActive: true },
      relations: ['client'],
      order: { createdAt: 'DESC' },
      take: limit,
      skip: (page - 1) * limit,
    });

    // Branch progress, in one grouped query rather than a fetch per project. The
    // list had no measure of how far a project had actually got, so a project with
    // no branches looked identical to one that was fully scheduled.
    if (projects.length > 0) {
      const counts = await this.projectBranchRepository
        .createQueryBuilder('pb')
        .select('pb.project_id', 'projectId')
        .addSelect('COUNT(*)::int', 'total')
        // Real ProjectBranchStatus values — a branch counts as covered once an
        // assayer is confirmed on it, and as done once its audit is validated.
        .addSelect(
          `COUNT(*) FILTER (WHERE pb.status IN ('ASSIGNMENT_CONFIRMED','SCHEDULED','AUDIT_COMPLETED','VALIDATION_COMPLETED','CLOSED'))::int`,
          'assigned',
        )
        .addSelect(
          `COUNT(*) FILTER (WHERE pb.status IN ('VALIDATION_COMPLETED','CLOSED'))::int`,
          'completed',
        )
        .addSelect(
          `COUNT(*) FILTER (WHERE pb.status = 'UNABLE_TO_COVER')::int`,
          'uncovered',
        )
        .where('pb.project_id IN (:...ids)', { ids: projects.map((p) => p.id) })
        .andWhere('pb.is_active = true')
        .groupBy('pb.project_id')
        .getRawMany();

      const byId = new Map(counts.map((c: any) => [c.projectId, c]));
      for (const project of projects) {
        const c = byId.get(project.id);
        (project as any).branchProgress = {
          total: Number(c?.total ?? 0),
          assigned: Number(c?.assigned ?? 0),
          completed: Number(c?.completed ?? 0),
          uncovered: Number(c?.uncovered ?? 0),
        };
      }
    }

    return { projects, total };
  }

  async findProjectBranches(projectId: string): Promise<ProjectBranchEntity[]> {
    return this.projectBranchRepository.find({
      where: { projectId, isActive: true },
      relations: ['branch', 'assignments', 'assignments.assayer'],
    });
  }

  async findProjectBranchById(id: string): Promise<ProjectBranchEntity | null> {
    return this.projectBranchRepository.findOne({
      where: { id, isActive: true },
      relations: ['branch', 'project', 'project.client'],
    });
  }
}
