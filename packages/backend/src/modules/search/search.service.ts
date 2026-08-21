import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike, In } from 'typeorm';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import { branchScopeWhere } from '../../infrastructure/scope/apply-scope';
import { scopeAssayerForRoles } from '../assayer/assayer-visibility';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { ProjectEntity } from '../project/project.entity';
import { ClientEntity } from '../client/client.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';

@Injectable()
export class SearchService {
  constructor(
    @InjectRepository(BranchEntity)
    private readonly branchRepo: Repository<BranchEntity>,
    @InjectRepository(AssayerEntity)
    private readonly assayerRepo: Repository<AssayerEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectRepo: Repository<ProjectEntity>,
    @InjectRepository(ClientEntity)
    private readonly clientRepo: Repository<ClientEntity>,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepo: Repository<AssignmentEntity>,
  ) {}

  /**
   * Search, inside the caller's own boundary.
   *
   * This took a query string and nothing else, so it answered every caller with the whole
   * database — which made it a way around the region scope the branch, project and assignment
   * lists all apply. Each arm below is now narrowed the same way its own list endpoint is.
   */
  /**
   * Projects the caller may see, matched by name or number.
   *
   * A project is regional only through its branches, which is how the project list decides it
   * too — so this asks the same question: does this project have at least one branch inside the
   * boundary. Without regions set the subquery is skipped entirely and the plan is unchanged.
   */
  private async projectScopedSearch(term: string, scope?: Partial<GlobalScope>) {
    const qb = this.projectRepo
      .createQueryBuilder('p')
      .where('p.is_active = true')
      .andWhere('(p.name ILIKE :term OR p.project_number ILIKE :term)', { term })
      .orderBy('p.name', 'ASC')
      .take(10);

    if (scope?.regions && scope.regions.length > 0) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM project_branches pb
                   JOIN branches b ON b.id = pb.branch_id
                  WHERE pb.project_id = p.id AND b.region IN (:...searchRegions))`,
        { searchRegions: scope.regions },
      );
    }
    if (scope?.clientId) qb.andWhere('p.client_id = :searchClientId', { searchClientId: scope.clientId });

    return qb.getMany();
  }

  async searchAll(q: string, scope?: Partial<GlobalScope>, roles: string[] = []) {
    // A single character (or an empty/whitespace-only query) yields no trigram, so
    // pg_trgm's GIN index cannot help and Postgres would fall back to a full scan of
    // every searched table. Such a query also matches almost everything and is never
    // a useful global search, so short-circuit before touching the database.
    const trimmed = (q ?? '').trim();
    if (trimmed.length < 2) {
      return {
        branches: [],
        assayers: [],
        projects: [],
        clients: [],
        assignments: [],
      };
    }

    const term = `%${trimmed}%`;
    // The same object-where fragment the branch list is filtered by, merged into each arm of
    // the OR — a `find` with an array of wheres ORs them, so the scope has to be on every one
    // or the unscoped arms leak.
    const branchScope = branchScopeWhere(scope) ?? {};
    const regionScope = scope?.regions && scope.regions.length > 0
      ? { region: In(scope.regions) }
      : {};
    const clientScope = scope?.clientId ? { clientId: scope.clientId } : {};

    const [branches, assayers, projects, clients, assignments] = await Promise.all([
      this.branchRepo.find({
        where: [
          { isActive: true, ...branchScope, name: ILike(term) },
          { isActive: true, ...branchScope, branchCode: ILike(term) },
          { isActive: true, ...branchScope, city: ILike(term) },
          { isActive: true, ...branchScope, state: ILike(term) },
          { isActive: true, ...branchScope, address: ILike(term) },
        ],
        take: 10,
        order: { name: 'ASC' },
      }),
      this.assayerRepo.find({
        where: [
          { isActive: true, ...regionScope, displayName: ILike(term) },
          { isActive: true, ...regionScope, firstName: ILike(term) },
          { isActive: true, ...regionScope, lastName: ILike(term) },
          { isActive: true, ...regionScope, assayerCode: ILike(term) },
          { isActive: true, ...regionScope, phone: ILike(term) },
          { isActive: true, ...regionScope, email: ILike(term) },
        ],
        take: 10,
        order: { displayName: 'ASC' },
      }),
      this.projectScopedSearch(term, scope),
      this.clientRepo.find({
        where: [
          { isActive: true, ...(clientScope.clientId ? { id: clientScope.clientId } : {}), name: ILike(term) },
          { isActive: true, ...(clientScope.clientId ? { id: clientScope.clientId } : {}), clientCode: ILike(term) },
          { isActive: true, ...(clientScope.clientId ? { id: clientScope.clientId } : {}), displayName: ILike(term) },
        ],
        take: 10,
        order: { name: 'ASC' },
      }),
      this.assignmentRepo.find({
        where: [
          { isActive: true, assignmentNumber: ILike(term) },
        ],
        relations: ['projectBranch', 'projectBranch.branch', 'assayer'],
        take: 10,
        order: { assignmentNumber: 'ASC' },
      }),
    ]);

    return {
      branches: branches.map(b => ({ id: b.id, name: b.name, code: b.branchCode, city: b.city, state: b.state })),
      /**
       * The same field policy the roster applies, not a second one invented here.
       *
       * `scopeAssayerForRoles` decides what each role may see of an assayer; running the row
       * through it means search can never show more than the roster does — and if that policy
       * changes, search follows without anyone remembering to update it.
       */
      assayers: assayers.map((a) => {
        const visible = scopeAssayerForRoles(a as any, roles) as any;
        return { id: visible.id, name: visible.displayName, code: visible.assayerCode, phone: visible.phone ?? null };
      }),
      projects: projects.map(p => ({ id: p.id, name: p.name, projectNumber: p.projectNumber })),
      clients: clients.map(c => ({ id: c.id, name: c.name, code: c.clientCode })),
      assignments: assignments.map(a => ({
        id: a.id,
        assignmentNumber: a.assignmentNumber,
        branchName: a.projectBranch?.branch?.name || '',
        assayerName: a.assayer?.displayName || '',
      })),
    };
  }
}
