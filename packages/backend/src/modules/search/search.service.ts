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
    const term = `%${q}%`;

    const [branches, assayers, projects, clients, assignments] = await Promise.all([
      this.branchRepo.find({
        where: [
          { name: ILike(term) },
          { branchCode: ILike(term) },
          { city: ILike(term) },
          { state: ILike(term) },
          { address: ILike(term) },
        ],
        take: 10,
        order: { name: 'ASC' },
      }),
      this.assayerRepo.find({
        where: [
          { displayName: ILike(term) },
          { firstName: ILike(term) },
          { lastName: ILike(term) },
          { assayerCode: ILike(term) },
          { phone: ILike(term) },
          { email: ILike(term) },
        ],
        take: 10,
        order: { displayName: 'ASC' },
      }),
      this.projectRepo.find({
        where: [
          { name: ILike(term) },
          { projectNumber: ILike(term) },
        ],
        take: 10,
        order: { name: 'ASC' },
      }),
      this.clientRepo.find({
        where: [
          { name: ILike(term) },
          { clientCode: ILike(term) },
          { displayName: ILike(term) },
        ],
        take: 10,
        order: { name: 'ASC' },
      }),
      this.assignmentRepo.find({
        where: [
          { assignmentNumber: ILike(term) },
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
