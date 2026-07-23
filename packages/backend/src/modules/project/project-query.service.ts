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
    return { projects, total };
  }

  async findProjectBranches(projectId: string): Promise<ProjectBranchEntity[]> {
    return this.projectBranchRepository.find({
      where: { projectId, isActive: true },
      relations: ['branch'],
    });
  }

  async findProjectBranchById(id: string): Promise<ProjectBranchEntity | null> {
    return this.projectBranchRepository.findOne({
      where: { id, isActive: true },
      relations: ['branch', 'project', 'project.client'],
    });
  }
}
