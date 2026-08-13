import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
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

  async searchAll(q: string) {
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

    const [branches, assayers, projects, clients, assignments] = await Promise.all([
      this.branchRepo.find({
        where: [
          { isActive: true, name: ILike(term) },
          { isActive: true, branchCode: ILike(term) },
          { isActive: true, city: ILike(term) },
          { isActive: true, state: ILike(term) },
          { isActive: true, address: ILike(term) },
        ],
        take: 10,
        order: { name: 'ASC' },
      }),
      this.assayerRepo.find({
        where: [
          { isActive: true, displayName: ILike(term) },
          { isActive: true, firstName: ILike(term) },
          { isActive: true, lastName: ILike(term) },
          { isActive: true, assayerCode: ILike(term) },
          { isActive: true, phone: ILike(term) },
          { isActive: true, email: ILike(term) },
        ],
        take: 10,
        order: { displayName: 'ASC' },
      }),
      this.projectRepo.find({
        where: [
          { isActive: true, name: ILike(term) },
          { isActive: true, projectNumber: ILike(term) },
        ],
        take: 10,
        order: { name: 'ASC' },
      }),
      this.clientRepo.find({
        where: [
          { isActive: true, name: ILike(term) },
          { isActive: true, clientCode: ILike(term) },
          { isActive: true, displayName: ILike(term) },
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
      assayers: assayers.map(a => ({ id: a.id, name: a.displayName, code: a.assayerCode, phone: a.phone })),
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
