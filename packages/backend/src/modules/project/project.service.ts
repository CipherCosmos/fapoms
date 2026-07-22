/**
 * FAPOMS — Project Service
 *
 * Handles CRUD and lifecycle state transitions for projects and project branches (Part 3 Module 2, Part 5 §3).
 */

import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ProjectEntity } from './project.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { BranchEntity } from '../branch/branch.entity';
import { ZoneEntity } from '../zone/zone.entity';
import { AuditService } from '../../core/audit/audit.service';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { EventCategory, ProjectStatus, ProjectBranchStatus } from '@fapoms/shared';
import * as xlsx from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';

const CACHE_FILE = path.join(__dirname, '../../infrastructure/database/geocoding-cache.json');

let cache: Record<string, { lat: number; lng: number }> = {};
if (fs.existsSync(CACHE_FILE)) {
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to read cache file, starting fresh', e);
  }
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save geocoding cache', e);
  }
}

async function getRealCoordinates(address: string, name: string, district: string, state: string): Promise<{ lat: number; lng: number }> {
  const pinMatch = address.match(/\b\d{6}\b/);
  const pincode = pinMatch ? pinMatch[0] : null;

  const queries: string[] = [];
  if (pincode) {
    queries.push(`${pincode}, India`);
  }
  queries.push(`${name}, ${district}, ${state}, India`);
  queries.push(`${district}, ${state}, India`);
  queries.push(`${state}, India`);

  for (const q of queries) {
    const cleanQ = q.trim();
    if (cache[cleanQ]) {
      return cache[cleanQ];
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cleanQ)}&format=json&limit=1&countrycodes=in`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'fapoms-production-geocoder/1.0 (info@fapoms.com)'
        }
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json() as any[];
        if (data && data[0]) {
          const coords = {
            lat: parseFloat(data[0].lat),
            lng: parseFloat(data[0].lon)
          };
          cache[cleanQ] = coords;
          saveCache();
          return coords;
        }
      }
    } catch (err) {
      console.error(`Error geocoding: ${cleanQ}`, err);
    }
  }

  throw new NotFoundException(`Geocoding failed: could not locate coordinates for address: "${address}" (District: ${district}, State: ${state}).`);
}

function getStateZone(stateName: string): string {
  const s = stateName.toUpperCase();
  if (['KERALA', 'TAMIL NADU', 'KARNATAKA', 'ANDHRA PRADESH', 'TELANGANA', 'PUDUCHERRY', 'PONDICHERRY'].some(x => s.includes(x))) {
    return 'South Zone';
  }
  if (['MAHARASHTRA', 'GOA', 'GUJARAT'].some(x => s.includes(x))) {
    return 'West Zone';
  }
  if (['DELHI', 'NORTH DELHI', 'NOIDA', 'PUNJAB', 'HARYANA', 'RAJASTHAN', 'UTTAR PRADESH', 'JHUNJHUNU', 'SIKAR'].some(x => s.includes(x))) {
    return 'North Zone';
  }
  return 'East Zone';
}

const INDIAN_NAMES = ['Aravind Swamy', 'Karthik Raja', 'Siddharth Rao', 'Vijay Shankar', 'Rohan Mehta', 'Vikram Sen', 'Pranav Nair', 'Anand Krishnan', 'Rahul Sharma', 'Manish Patil'];

export interface CreateProjectDto {
  name: string;
  projectNumber: string;
  description?: string;
  clientId: string;
  priority: string;
  startDate?: string;
  endDate?: string;
  budget?: number;
  scope?: string;
  requiredSkills?: string[];
  requiredCertifications?: string[];
  sla?: Record<string, any>;
  risks?: Record<string, any>;
  milestones?: Record<string, any>;
  dependencies?: Record<string, any>;
  status?: string;
}

@Injectable()
export class ProjectService implements OnModuleInit {
  constructor(
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    @InjectRepository(ProjectBranchEntity)
    private readonly projectBranchRepository: Repository<ProjectBranchEntity>,
    @InjectRepository(BranchEntity)
    private readonly branchRepository: Repository<BranchEntity>,
    private readonly auditService: AuditService,
    private readonly workflowEngine: WorkflowEngine,
  ) {}

  onModuleInit() {
    this.workflowEngine.registerWorkflow('project', [
      {
        from: [ProjectStatus.DRAFT],
        to: ProjectStatus.PLANNING,
      },
      {
        from: [ProjectStatus.PLANNING],
        to: ProjectStatus.SCHEDULING,
      },
      {
        from: [ProjectStatus.SCHEDULING],
        to: ProjectStatus.EXECUTION,
      },
      {
        from: [ProjectStatus.EXECUTION],
        to: ProjectStatus.VALIDATION,
      },
      {
        from: [ProjectStatus.VALIDATION],
        to: ProjectStatus.COMPLETED,
      },
      {
        from: [ProjectStatus.DRAFT, ProjectStatus.PLANNING, ProjectStatus.SCHEDULING, ProjectStatus.EXECUTION, ProjectStatus.VALIDATION],
        to: ProjectStatus.CANCELLED,
      },
    ]);
  }

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
      budget: dto.budget ?? null,
      scope: dto.scope ?? null,
      requiredSkills: dto.requiredSkills ?? null,
      requiredCertifications: dto.requiredCertifications ?? null,
      sla: dto.sla ?? null,
      risks: dto.risks ?? null,
      milestones: dto.milestones ?? null,
      dependencies: dto.dependencies ?? null,
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
      relations: ['client'],
      order: { createdAt: 'DESC' },
      take: limit,
      skip: (page - 1) * limit,
    });

    return { projects, total };
  }

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

  async update(id: string, dto: CreateProjectDto, userId: string): Promise<ProjectEntity> {
    const project = await this.findOne(id);

    project.name = dto.name;
    project.projectNumber = dto.projectNumber;
    project.description = dto.description ?? null;
    project.clientId = dto.clientId;
    project.priority = dto.priority as any;
    if (dto.startDate) project.startDate = new Date(dto.startDate);
    if (dto.endDate) project.endDate = new Date(dto.endDate);
    if (dto.budget !== undefined) project.budget = dto.budget;
    if (dto.scope !== undefined) project.scope = dto.scope;
    if (dto.requiredSkills !== undefined) project.requiredSkills = dto.requiredSkills;
    if (dto.requiredCertifications !== undefined) project.requiredCertifications = dto.requiredCertifications;
    if (dto.sla !== undefined) project.sla = dto.sla;
    if (dto.risks !== undefined) project.risks = dto.risks;
    if (dto.milestones !== undefined) project.milestones = dto.milestones;
    if (dto.dependencies !== undefined) project.dependencies = dto.dependencies;
    if (dto.status !== undefined && dto.status !== project.status) {
      await this.workflowEngine.executeTransition(
        'project',
        project.id,
        project.status,
        dto.status,
        { userId }
      );
      project.status = dto.status as any;
    }
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
      relations: ['branch', 'assignments', 'assignments.assayer'],
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Associate branches with a project.
   */
  async associateBranches(projectId: string, branchIds: string[], userId: string): Promise<ProjectBranchEntity[]> {
    const project = await this.findOne(projectId);
    const addedBranches: ProjectBranchEntity[] = [];

    for (const branchId of branchIds) {
      let pb = await this.projectBranchRepository.findOne({
        where: { projectId: project.id, branchId, isActive: true },
      });

      if (!pb) {
        const branch = await this.branchRepository.findOne({ where: { id: branchId } });
        if (branch) {
          pb = this.projectBranchRepository.create({
            projectId: project.id,
            branchId: branch.id,
            zoneId: branch.zoneId,
            status: ProjectBranchStatus.IMPORTED,
            createdBy: userId,
            updatedBy: userId,
          });
          const savedPb = await this.projectBranchRepository.save(pb);
          addedBranches.push(savedPb);
        }
      }
    }

    if (addedBranches.length > 0) {
      await this.auditService.recordEvent({
        category: EventCategory.OPERATIONAL,
        eventType: 'PROJECT_BRANCHES_ADDED',
        entityType: 'PROJECT',
        entityId: project.id,
        userId,
        remarks: `Added ${addedBranches.length} branches to project ${project.name}`,
      });
    }

    return this.findProjectBranches(project.id);
  }

  /**
   * Upload branches from an Excel file buffer and associate them with the project.
   * If a branch doesn't exist in the database, geocode and create it dynamically.
   */
  async uploadBranchesFromExcel(projectId: string, fileBuffer: Buffer, userId: string): Promise<ProjectBranchEntity[]> {
    const project = await this.findOne(projectId);
    const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
    
    const sheetName = workbook.SheetNames.includes('Branch') ? 'Branch' : workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet) as any[];

    const addedBranches: ProjectBranchEntity[] = [];

    for (const row of rows) {
      const branchName = (row.BRANCH_NAME || '').toString().trim();
      if (!branchName) continue;

      const branchCode = (row.BRANCH || '').toString().trim();
      if (!branchCode) continue;

      const district = (row.DISTRICT || '').toString().trim().toUpperCase();
      const state = (row.STATE || '').toString().trim();
      const address = (row['Branch Address'] || '').toString().trim();

      let branch = await this.branchRepository.findOne({ where: { branchCode } });
      if (!branch) {
        const coords = await getRealCoordinates(address, branchName, district, state);
        const zoneName = getStateZone(state);
        
        const zoneRepo = this.projectBranchRepository.manager.getRepository(ZoneEntity);
        let zone = await zoneRepo.findOne({ where: { name: zoneName, clientId: project.clientId } });
        if (!zone) {
          zone = zoneRepo.create({
            name: zoneName,
            clientId: project.clientId,
            states: [state.toUpperCase()],
            districts: []
          });
          zone = await zoneRepo.save(zone);
        }

        const pincode = address.match(/\b\d{6}\b/)?.[0] || null;
        const branchType = ['BANGALORE', 'CHENNAI', 'PUNE', 'NOIDA'].includes(district) ? 'METRO' : 'URBAN';
        const managerName = INDIAN_NAMES[Math.floor(Math.random() * INDIAN_NAMES.length)];
        const phone = `+9144${Math.floor(10000000 + Math.random() * 90000000)}`;

        branch = this.branchRepository.create({
          branchCode,
          solId: branchCode,
          name: branchName,
          address,
          state,
          district,
          city: district,
          pincode,
          branchType,
          latitude: coords.lat,
          longitude: coords.lng,
          location: { type: 'Point', coordinates: [coords.lng, coords.lat] },
          organizationId: project.organizationId,
          clientId: project.clientId,
          zoneId: zone ? zone.id : null,
          region: state,
          territory: `${district} Area`,
          managerName,
          phone,
          email: `${branchName.toLowerCase().replace(/\s+/g, '')}@rblbank.com`,
          riskScore: 2.0,
          riskCategory: 'LOW',
          complexity: 'STANDARD',
          estimatedDurationHours: 6.0,
          createdBy: userId,
          updatedBy: userId,
        });
        branch = await this.branchRepository.save(branch);
      }

      let pb = await this.projectBranchRepository.findOne({
        where: { projectId: project.id, branchId: branch.id, isActive: true },
      });

      if (!pb) {
        pb = this.projectBranchRepository.create({
          projectId: project.id,
          branchId: branch.id,
          zoneId: branch.zoneId,
          status: ProjectBranchStatus.IMPORTED,
          createdBy: userId,
          updatedBy: userId,
        });
        const savedPb = await this.projectBranchRepository.save(pb);
        addedBranches.push(savedPb);
      }
    }

    if (addedBranches.length > 0) {
      await this.auditService.recordEvent({
        category: EventCategory.OPERATIONAL,
        eventType: 'PROJECT_BRANCHES_UPLOADED',
        entityType: 'PROJECT',
        entityId: project.id,
        userId,
        remarks: `Uploaded and associated ${addedBranches.length} branches to project ${project.name}`,
      });
    }

    return this.findProjectBranches(project.id);
  }

  /**
   * Remove a branch association link from a project.
   */
  async removeProjectBranch(projectId: string, projectBranchId: string, userId: string): Promise<ProjectBranchEntity[]> {
    const pb = await this.projectBranchRepository.findOne({
      where: { id: projectBranchId, projectId, isActive: true },
    });
    if (pb) {
      pb.isActive = false;
      pb.updatedBy = userId;
      await this.projectBranchRepository.save(pb);

      await this.auditService.recordEvent({
        category: EventCategory.OPERATIONAL,
        eventType: 'PROJECT_BRANCH_REMOVED',
        entityType: 'PROJECT',
        entityId: projectId,
        userId,
        remarks: `Removed branch association link ${projectBranchId}`,
      });
    }
    return this.findProjectBranches(projectId);
  }
}
