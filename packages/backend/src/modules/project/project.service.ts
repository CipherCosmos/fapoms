/**
 * FAPOMS — Project Service
 *
 * Handles CRUD and lifecycle state transitions for projects and project branches (Part 3 Module 2, Part 5 §3).
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ProjectEntity } from './project.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory, ProjectStatus } from '@fapoms/shared';

export interface CreateProjectDto {
  name: string;
  projectNumber: string;
  description?: string;
  clientId: string;
  priority: string;
  startDate?: string;
  endDate?: string;
}

@Injectable()
export class ProjectService {
  constructor(
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    @InjectRepository(ProjectBranchEntity)
    private readonly projectBranchRepository: Repository<ProjectBranchEntity>,
    private readonly auditService: AuditService,
  ) {}

  async create(dto: CreateProjectDto, userId: string): Promise<ProjectEntity> {
    const project = this.projectRepository.create({
      projectNumber: dto.projectNumber,
      name: dto.name,
      description: dto.description ?? null,
      clientId: dto.clientId,
      priority: dto.priority as any,
      status: ProjectStatus.DRAFT,
      startDate: dto.startDate ? new Date(dto.startDate) : null,
      endDate: dto.endDate ? new Date(dto.endDate) : null,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.projectRepository.save(project);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'PROJECT_CREATED',
      entityType: 'PROJECT',
      entityId: saved.id,
      userId,
      remarks: `Created project: ${saved.name} (${saved.projectNumber})`,
    });

    return saved;
  }

  async findAll(page = 1, limit = 50): Promise<{ projects: ProjectEntity[]; total: number }> {
    const [projects, total] = await this.projectRepository.findAndCount({
      where: { isActive: true },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: (page - 1) * limit,
    });

    return { projects, total };
  }

  async findOne(id: string): Promise<ProjectEntity> {
    const project = await this.projectRepository.findOne({
      where: { id, isActive: true },
    });
    if (!project) {
      throw new NotFoundException(`Project ${id} not found.`);
    }
    return project;
  }

  async update(id: string, dto: CreateProjectDto, userId: string): Promise<ProjectEntity> {
    const project = await this.findOne(id);

    project.name = dto.name;
    project.projectNumber = dto.projectNumber;
    project.description = dto.description ?? null;
    project.clientId = dto.clientId;
    project.priority = dto.priority as any;
    if (dto.startDate) project.startDate = new Date(dto.startDate);
    if (dto.endDate) project.endDate = new Date(dto.endDate);
    project.updatedBy = userId;

    const saved = await this.projectRepository.save(project);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'PROJECT_UPDATED',
      entityType: 'PROJECT',
      entityId: saved.id,
      userId,
      remarks: `Updated project: ${saved.name} (${saved.projectNumber})`,
    });

    return saved;
  }

  async remove(id: string, userId: string): Promise<void> {
    const project = await this.findOne(id);
    project.isActive = false;
    project.updatedBy = userId;
    await this.projectRepository.save(project);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'PROJECT_DELETED',
      entityType: 'PROJECT',
      entityId: id,
      userId,
      remarks: `Soft deleted project ${project.name}`,
    });
  }

  /**
   * Fetch branches belonging to this project (with full Branch details).
   */
  async findProjectBranches(projectId: string): Promise<ProjectBranchEntity[]> {
    const project = await this.findOne(projectId);
    
    return this.projectBranchRepository.find({
      where: { projectId: project.id, isActive: true },
      relations: ['branch', 'assignment', 'assignment.assayer'],
      order: { createdAt: 'ASC' },
    });
  }
}
