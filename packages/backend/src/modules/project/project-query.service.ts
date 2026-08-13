import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { applyBranchScope, branchScopeWhere, needsGeographicScope } from '../../infrastructure/scope/apply-scope';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
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

  async findAll(
    page = 1,
    limit = 50,
    scope?: Partial<GlobalScope>,
  ): Promise<{ projects: ProjectEntity[]; total: number }> {
    const where: Record<string, unknown> = { isActive: true };
    if (scope?.clientId) where.clientId = scope.clientId;
    if (scope?.projectId) where.id = scope.projectId;

    // A project has no region of its own — it *has branches* that do. "Projects in the West"
    // therefore means "projects with at least one branch in the West", resolved here as a
    // separate id lookup rather than a join: joining project_branches would multiply each
    // project row by its branch count and corrupt both the page size and the total.
    //
    // Only the *geographic* dimensions trigger this. `clientId` deliberately does not: it is
    // already applied directly to `projects.client_id` above, and routing it through branch
    // membership as well would drop a newly created project that has no branches imported yet —
    // exactly the project a planner is most likely to be looking for.
    if (needsGeographicScope(scope)) {
      const idQuery = this.projectBranchRepository
        .createQueryBuilder('pb2')
        .select('DISTINCT pb2.project_id', 'projectId')
        .innerJoin('pb2.branch', 'b2')
        .where('pb2.is_active = true');
      applyBranchScope(idQuery, scope, { branch: 'b2' });

      const matching = (await idQuery.getRawMany<{ projectId: string }>()).map((r) => r.projectId);
      // No branches in scope means no projects in scope. Returning early avoids `In([])`,
      // which TypeORM renders as invalid SQL rather than as "match nothing".
      if (matching.length === 0) return { projects: [], total: 0 };

      // An explicit project selection has to survive the region narrowing, not be replaced by
      // it: if the chosen project has no branches in the chosen region, the honest answer is
      // an empty list, not that project's full branch set.
      if (scope?.projectId) {
        if (!matching.includes(scope.projectId)) return { projects: [], total: 0 };
      } else {
        where.id = In(matching);
      }
    }

    const [projects, total] = await this.projectRepository.findAndCount({
      where,
      relations: ['client'],
      order: { createdAt: 'DESC' },
      take: limit,
      skip: (page - 1) * limit,
    });

    // Branch progress, in one grouped query rather than a fetch per project. The
    // list had no measure of how far a project had actually got, so a project with
    // no branches looked identical to one that was fully scheduled.
    if (projects.length > 0) {
      const countQuery = this.projectBranchRepository
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
        // Branches still waiting for anyone to be put on them. This is the number ops actually
        // starts the day with — "what is still unstaffed?" — and nothing computed it before, so
        // a project could be 89% unstaffed (64 of 72 branches, as this one currently is) and
        // look no different from one that was fully planned. Distinct from `uncovered`: those
        // have had a decision recorded, these have not.
        .addSelect(
          `COUNT(*) FILTER (WHERE pb.status IN ('IMPORTED','PLANNING','CANDIDATE_SEARCH','CONTACT_INITIATED','NEGOTIATION'))::int`,
          'unstaffed',
        )
        .where('pb.project_id IN (:...ids)', { ids: projects.map((p) => p.id) })
        .andWhere('pb.is_active = true')
        .groupBy('pb.project_id');

      // The progress bar has to count the same branches the rest of the scoped view shows.
      // Left national, a West operator saw "72 branches, 8 audited" on a project where only 10
      // branches are theirs — a completion figure they cannot act on and cannot reconcile with
      // any other screen. The join is added only when geography is actually constraining.
      if (needsGeographicScope(scope)) {
        countQuery.innerJoin('pb.branch', 'pbb');
        applyBranchScope(countQuery, { regions: scope?.regions, state: scope?.state, zoneId: scope?.zoneId }, { branch: 'pbb' });
      }

      const counts = await countQuery.getRawMany();

      const byId = new Map(counts.map((c: any) => [c.projectId, c]));
      for (const project of projects) {
        const c = byId.get(project.id);
        (project as any).branchProgress = {
          total: Number(c?.total ?? 0),
          assigned: Number(c?.assigned ?? 0),
          completed: Number(c?.completed ?? 0),
          uncovered: Number(c?.uncovered ?? 0),
          unstaffed: Number(c?.unstaffed ?? 0),
        };
      }
    }

    return { projects, total };
  }

  /**
   * The coverage list a planner works from.
   *
   * `scope` is optional and deliberately not applied by the write paths that call this to
   * return their result — a planner who has just acted on a branch must see the outcome, even
   * if the row sits outside the region they are currently browsing.
   */
  async findProjectBranches(
    projectId: string,
    scope?: Partial<GlobalScope>,
  ): Promise<ProjectBranchEntity[]> {
    const branchWhere = branchScopeWhere(scope);
    const branches = await this.projectBranchRepository.find({
      where: { projectId, isActive: true, ...(branchWhere ? { branch: branchWhere } : {}) },
      relations: ['branch', 'assignments', 'assignments.assayer'],
    });

    // Filter out soft-deleted / inactive assignments from returned branches
    for (const b of branches) {
      if (b.assignments) {
        b.assignments = b.assignments.filter((a) => a.isActive !== false);
      }
    }

    return branches;
  }

  async findProjectBranchById(id: string): Promise<ProjectBranchEntity | null> {
    return this.projectBranchRepository.findOne({
      where: { id, isActive: true },
      relations: ['branch', 'project', 'project.client'],
    });
  }
}
