import { Injectable } from '@nestjs/common';
import { ProjectMetricsProvider } from './operations-providers.interface';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectEntity } from '../project/project.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { ProjectStatus } from '@fapoms/shared';

@Injectable()
export class OperationsProjectMetricsAdapter implements ProjectMetricsProvider {
  constructor(
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    @InjectRepository(ProjectBranchEntity)
    private readonly projectBranchRepository: Repository<ProjectBranchEntity>,
  ) {}

  async getTotalProjectsCount(): Promise<number> {
    return this.projectRepository.count({ where: { isActive: true } });
  }

  async getActiveProjectsCount(): Promise<number> {
    return this.projectRepository.count({
      where: [
        { status: ProjectStatus.EXECUTION, isActive: true },
        { status: ProjectStatus.VALIDATION, isActive: true },
      ],
    });
  }

  async getProjectsAtRiskCount(breachedCounts: Record<string, number>): Promise<number> {
    const activeProjects = await this.projectRepository.find({
      where: [
        { status: ProjectStatus.EXECUTION, isActive: true },
        { status: ProjectStatus.VALIDATION, isActive: true },
      ],
    });

    let count = 0;
    for (const p of activeProjects) {
      if ((breachedCounts[p.id] || 0) > 2) {
        count++;
      }
    }
    return count;
  }

  async getProjectBranchCounts(): Promise<{ total: number; deployed: number }> {
    const branches = await this.projectBranchRepository.find({ where: { isActive: true } });
    const total = branches.length;
    const deployed = branches.filter((pb) => pb.status !== 'IMPORTED' && pb.status !== 'PLANNING').length;
    return { total, deployed };
  }
}
