/**
 * FAPOMS — Project Service
 *
 * Handles CRUD and lifecycle state transitions for projects and project branches (Part 3 Module 2, Part 5 §3).
 */

import { Injectable, NotFoundException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ProjectEntity } from './project.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { AssessmentEntity } from './assessment.entity';
import { ClientEntity } from '../client/client.entity';
import { ZoneEntity } from '../zone/zone.entity';
import { ProjectStateMachine, ProjectBranchStateMachine } from './project.state-machine';
import { BranchService } from '../branch/branch.service';
import { ProjectQueryService } from './project-query.service';
import { BranchQueryService } from '../branch/branch-query.service';
import { AuditService } from '../../core/audit/audit.service';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { EventCategory, ProjectStatus, ProjectBranchStatus, AssessmentStatus, SystemRole } from '@fapoms/shared';
import * as xlsx from 'xlsx';
import { geocodeIndia } from '../geo/india-geocoder';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';

async function getRealCoordinates(address: string, name: string, district: string, state: string): Promise<{ lat: number; lng: number }> {
  const pinMatch = address.match(/\b\d{6}\b/);
  const coords = await geocodeIndia(address, name, district, state, pinMatch ? pinMatch[0] : null);
  if (coords) return { lat: coords.lat, lng: coords.lng };
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

/** Partial edit of a project. Lifecycle moves go through transition(). */
export type UpdateProjectDto = Partial<CreateProjectDto>;

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
      @InjectRepository(AssessmentEntity)
      private readonly assessmentRepository: Repository<AssessmentEntity>,
      @InjectRepository(ClientEntity)
      private readonly clientRepository: Repository<ClientEntity>,
      @InjectRepository(ZoneEntity)
      private readonly zoneRepository: Repository<ZoneEntity>,
      private readonly branchQueryService: BranchQueryService,
      private readonly branchService: BranchService,
      private readonly auditService: AuditService,
      private readonly workflowEngine: WorkflowEngine,
      private readonly eventPublisher: DomainEventPublisher,
      private readonly projectQueryService: ProjectQueryService,
      private readonly notificationDispatch: NotificationDispatchService,
   ) {}

  private async resolveZoneName(stateName: string, clientId?: string): Promise<string> {
    if (stateName) {
      const stateUpper = stateName.toUpperCase();
      const query = this.zoneRepository.createQueryBuilder('zone')
        .where('zone.isActive = true');
      if (clientId) {
        query.andWhere('(zone.clientId = :clientId OR zone.clientId IS NULL)', { clientId });
      }
      const zones = await query.getMany();
      for (const z of zones) {
        if (z.states && Array.isArray(z.states)) {
          if (z.states.some((s) => s.toUpperCase() === stateUpper)) {
            return z.name;
          }
        }
      }
    }
    return getStateZone(stateName);
  }

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
        // ON_HOLD was missing, so a parked project had no abandon path — it had to
        // be resumed into SCHEDULING or EXECUTION first just to be cancelled.
        from: [
          ProjectStatus.DRAFT, ProjectStatus.PLANNING, ProjectStatus.SCHEDULING,
          ProjectStatus.EXECUTION, ProjectStatus.VALIDATION, ProjectStatus.ON_HOLD,
        ],
        to: ProjectStatus.CANCELLED,
      },
      {
        from: [ProjectStatus.SCHEDULING, ProjectStatus.EXECUTION],
        to: ProjectStatus.ON_HOLD,
      },
      {
        from: [ProjectStatus.ON_HOLD],
        to: ProjectStatus.SCHEDULING,
      },
      {
        from: [ProjectStatus.ON_HOLD],
        to: ProjectStatus.EXECUTION,
      },
      {
        from: [ProjectStatus.COMPLETED],
        to: ProjectStatus.ARCHIVED,
      },
    ]);
  }

  async create(dto: CreateProjectDto, userId: string, organizationId?: string | null): Promise<ProjectEntity> {
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
      organizationId: organizationId ?? null,
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

    this.eventPublisher.publish('project:created', {
      eventType: 'project:created',
      aggregateId: saved.id,
      userId,
      organizationId: saved.organizationId,
      payload: { id: saved.id, name: saved.name, projectNumber: saved.projectNumber, clientId: saved.clientId },
    });

    return saved;
  }

  async findAll(page = 1, limit = 50): Promise<{ projects: ProjectEntity[]; total: number }> {
    return this.projectQueryService.findAll(page, limit);
  }

  async findOne(id: string): Promise<ProjectEntity> {
    return this.projectQueryService.findOne(id);
  }

  /**
   * Moves a project to `targetStatus`, or explains why it cannot go there.
   *
   * Each branch delegates to the existing per-status method, so the state machine
   * remains the only place transition legality is decided.
   */
  async transition(id: string, targetStatus: string, userId: string, reason?: string): Promise<ProjectEntity> {
    const project = await this.findOne(id);
    if (project.status === targetStatus) {
      throw new BadRequestException(`Project is already ${targetStatus}.`);
    }

    const moves: Record<string, () => Promise<any>> = {
      [ProjectStatus.PLANNING]: () => this.startProjectPlanning(id, userId),
      [ProjectStatus.SCHEDULING]: () => this.readyProjectForScheduling(id, userId),
      [ProjectStatus.EXECUTION]: () => this.startProjectExecution(id, userId),
      [ProjectStatus.VALIDATION]: () => this.startProjectValidation(id, userId),
      [ProjectStatus.COMPLETED]: () => this.completeProject(id, userId),
      [ProjectStatus.CANCELLED]: () => this.cancelProject(id, userId),
      [ProjectStatus.ON_HOLD]: () => this.holdProject(id, userId),
      [ProjectStatus.ARCHIVED]: () => this.archiveProject(id, userId),
    };

    const move = moves[targetStatus];
    if (!move) throw new BadRequestException(`Unknown project status: ${targetStatus}`);
    await move();

    const updated = await this.findOne(id);
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'PROJECT_STATUS_CHANGED',
      entityType: 'PROJECT',
      entityId: id,
      userId,
      remarks: reason
        ? `${project.status} → ${targetStatus}: ${reason}`
        : `${project.status} → ${targetStatus}`,
    });
    return updated;
  }

  async update(id: string, dto: UpdateProjectDto, userId: string): Promise<ProjectEntity> {
    const project = await this.findOne(id);

    // Only touch what the caller actually sent. These were unconditional, so any
    // omitted field was silently wiped — `description` in particular went null on
    // every edit that did not resend it.
    if (dto.name !== undefined) project.name = dto.name;
    if (dto.projectNumber !== undefined) project.projectNumber = dto.projectNumber;
    if (dto.description !== undefined) project.description = dto.description ?? null;
    if (dto.clientId !== undefined) project.clientId = dto.clientId;
    if (dto.priority !== undefined) project.priority = dto.priority as any;
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
      if (dto.status === ProjectStatus.PLANNING) {
        await this.startProjectPlanning(project.id, userId);
      } else if (dto.status === ProjectStatus.SCHEDULING) {
        await this.readyProjectForScheduling(project.id, userId);
      } else if (dto.status === ProjectStatus.EXECUTION) {
        await this.startProjectExecution(project.id, userId);
      } else if (dto.status === ProjectStatus.VALIDATION) {
        await this.startProjectValidation(project.id, userId);
      } else if (dto.status === ProjectStatus.COMPLETED) {
        await this.completeProject(project.id, userId);
      } else if (dto.status === ProjectStatus.CANCELLED) {
        await this.cancelProject(project.id, userId);
      } else if (dto.status === ProjectStatus.ON_HOLD) {
        await this.holdProject(project.id, userId);
      } else if (dto.status === ProjectStatus.ARCHIVED) {
        await this.archiveProject(project.id, userId);
      } else {
        throw new BadRequestException(`Invalid project status transition to ${dto.status}`);
      }
      const updatedProject = await this.findOne(id);
      project.status = updatedProject.status;
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

    this.eventPublisher.publish('project:updated', {
      eventType: 'project:updated',
      aggregateId: saved.id,
      userId,
      organizationId: saved.organizationId,
      payload: { id: saved.id, name: saved.name, status: saved.status },
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

    this.eventPublisher.publish('project:deleted', {
      eventType: 'project:deleted',
      aggregateId: id,
      userId,
      organizationId: project.organizationId,
      payload: { id, name: project.name, projectNumber: project.projectNumber },
    });
  }

  async findProjectBranches(projectId: string): Promise<ProjectBranchEntity[]> {
    return this.projectQueryService.findProjectBranches(projectId);
  }

  async associateBranches(projectId: string, branchIds: string[], userId: string): Promise<ProjectBranchEntity[]> {
    const project = await this.findOne(projectId);
    const addedBranches: ProjectBranchEntity[] = [];

    for (const branchId of branchIds) {
      let pb = await this.projectBranchRepository.findOne({
        where: { projectId: project.id, branchId, isActive: true },
      });

      if (!pb) {
        const branch = await this.branchQueryService.findOne(branchId);
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

          const existingAsmt = await this.assessmentRepository.findOne({
            where: { projectId: project.id, branchId: branch.id, isActive: true },
          });
          if (!existingAsmt) {
            const asmt = this.assessmentRepository.create({
              projectId: project.id,
              branchId: branch.id,
              zoneId: branch.zoneId,
              status: AssessmentStatus.PENDING_PLANNING,
              createdBy: userId,
              updatedBy: userId,
            });
            await this.assessmentRepository.save(asmt);
          }
        }
      }
    }

    if (addedBranches.length > 0) {
      await this.auditService.recordEvent({
        category: EventCategory.OPERATIONAL,
        eventType: 'PROJECT_BRANCHES_ASSOCIATED',
        entityType: 'PROJECT',
        entityId: project.id,
        userId,
        remarks: `Associated ${addedBranches.length} branches with project ${project.name}`,
      });
    }

    return this.findProjectBranches(project.id);
  }

  async generateBranchTemplate(projectId: string): Promise<Buffer> {
    const project = await this.findOne(projectId);
    const client = project.clientId
      ? await this.clientRepository.findOne({ where: { id: project.clientId } })
      : null;

    // Headers match the column names on the branch lists actually received from
    // clients (BRANCH / BRANCH_NAME / DISTRICT / STATE / Branch Address) so a
    // client's own export can be filled in and returned without restructuring.
    // The importer accepts both these and the friendlier equivalents.
    const headers = [
      // Identity + location (required)
      'BRANCH', 'BRANCH_NAME', 'DISTRICT', 'STATE', 'Branch Address', 'Packets',
      // Optional, but each one removes guesswork the system otherwise has to do
      'Pincode', 'Latitude', 'Longitude',
      'Branch Manager', 'Branch Phone', 'Branch Email',
      'Risk Category', 'Complexity', 'Estimated Hours',
    ];

    // Prefill existing branches if any
    const projectBranches = await this.projectBranchRepository.find({
      where: { projectId, isActive: true },
      relations: ['branch'],
    });

    const rows: Record<string, any>[] = projectBranches.map((pb) => ({
      BRANCH: pb.branch.branchCode,
      BRANCH_NAME: pb.branch.name,
      DISTRICT: pb.branch.district,
      STATE: pb.branch.state,
      'Branch Address': pb.branch.address || '',
      Packets: pb.packetCount ?? '',
      Pincode: pb.branch.pincode || '',
      Latitude: pb.branch.latitude ?? '',
      Longitude: pb.branch.longitude ?? '',
      'Branch Manager': pb.branch.managerName || '',
      'Branch Phone': pb.branch.phone || '',
      'Branch Email': pb.branch.email || '',
      'Risk Category': pb.branch.riskCategory || '',
      Complexity: pb.branch.complexity || '',
      'Estimated Hours': pb.branch.estimatedDurationHours ?? '',
    }));

    if (rows.length === 0) {
      rows.push(Object.fromEntries(headers.map((h) => [h, ''])));
    }

    const ws = xlsx.utils.json_to_sheet(rows, { header: headers });
    ws['!cols'] = headers.map((h) => ({ wch: h === 'Branch Address' ? 55 : Math.max(14, h.length + 4) }));
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Branch');

    const instructions = [
      { Field: 'BRANCH', Required: 'Yes', Description: 'Branch code from the client, e.g. 8 or BR-0010. Re-importing the same code updates that branch rather than creating a duplicate.' },
      { Field: 'BRANCH_NAME', Required: 'Yes', Description: 'Branch name, e.g. THENKURISSI.' },
      { Field: 'DISTRICT', Required: 'Yes', Description: 'District name — used to cluster nearby branches into one assayer-day and to compute travel.' },
      { Field: 'STATE', Required: 'Yes', Description: 'State name — used to apply state-specific public holidays when scheduling.' },
      { Field: 'Branch Address', Required: 'Yes', Description: 'Full address. Used to geocode the branch; a 6-digit pincode inside this text is detected automatically.' },
      { Field: 'Packets', Required: 'Yes', Description: 'Estimated packets to audit at this branch this cycle. Drives how long the audit takes, how many branches one assayer can cover in a day, and the coverage figure quoted to the client. Left blank, the system assumes a flat 6 hours and the plan will be wrong.' },
      { Field: 'Pincode', Required: 'No', Description: '6-digit pincode. Leave blank if it already appears in the address.' },
      { Field: 'Latitude', Required: 'No', Description: 'Decimal degrees, e.g. 10.7867. Supply with Longitude to skip geocoding entirely — faster on import and exact, instead of relying on an address lookup that can place the branch imprecisely or fail.' },
      { Field: 'Longitude', Required: 'No', Description: 'Decimal degrees, e.g. 76.6548. Must be supplied together with Latitude.' },
      { Field: 'Branch Manager', Required: 'No', Description: 'Contact name at the branch, shown to the assayer before the visit.' },
      { Field: 'Branch Phone', Required: 'No', Description: 'Branch contact number, shown to the assayer before the visit.' },
      { Field: 'Branch Email', Required: 'No', Description: 'Branch email for correspondence.' },
      { Field: 'Risk Category', Required: 'No', Description: 'LOW / MEDIUM / HIGH / CRITICAL. Higher-risk branches are preferentially matched to more experienced assayers.' },
      { Field: 'Complexity', Required: 'No', Description: 'SIMPLE / STANDARD / COMPLEX. Feeds the same matching, and the time allowance per branch.' },
      { Field: 'Estimated Hours', Required: 'No', Description: 'Override the audit duration for this branch. Normally leave blank — it is calculated from Packets, which stays accurate as packet counts change each cycle.' },
    ];
    const instrWs = xlsx.utils.json_to_sheet(instructions, { header: ['Field', 'Required', 'Description'] });
    instrWs['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 110 }];
    xlsx.utils.book_append_sheet(wb, instrWs, 'Instructions');

    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  }

  async uploadBranchesFromExcel(projectId: string, fileBuffer: Buffer, userId: string): Promise<ProjectBranchEntity[]> {
    const project = await this.findOne(projectId);

    // Read client planning preferences for hours-per-packet rate
    const client = project.clientId
      ? await this.clientRepository.findOne({ where: { id: project.clientId } })
      : null;
    const planningPrefs = client?.planningPreferences || {};
    const minutesPerPacket = Number(planningPrefs.minutesPerPacket) || 15; // default 15min per packet

    const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json<any>(worksheet);

    const addedBranches: ProjectBranchEntity[] = [];

    for (const row of rows) {
      const branchName = (row['Branch Name'] || row.BRANCH_NAME || '').toString().trim();
      if (!branchName) continue;

      const branchCode = (row.BRANCH || row['Branch Code'] || '').toString().trim();
      if (!branchCode) continue;

      const district = (row.DISTRICT || '').toString().trim().toUpperCase();
      const state = (row.STATE || '').toString().trim();
      const address = (row['Branch Address'] || row.Address || '').toString().trim();
      const pincodeStr = (row.Pincode || '').toString().trim();

      // Read packet count and calculate estimated duration
      const packetCount = parseInt(String(row.Packets ?? row.packet_count ?? ''), 10);
      const calculatedHours = !isNaN(packetCount) && packetCount > 0
        ? parseFloat(((packetCount * minutesPerPacket) / 60).toFixed(2))
        : null;

      // Client-supplied coordinates win over geocoding: they are exact, and they
      // avoid a network lookup per branch that is rate-limited to ~1/second and
      // throws when it cannot resolve an address.
      const latRaw = parseFloat(String(row.Latitude ?? row.latitude ?? ''));
      const lngRaw = parseFloat(String(row.Longitude ?? row.longitude ?? ''));
      const suppliedCoords = Number.isFinite(latRaw) && Number.isFinite(lngRaw)
        ? { lat: latRaw, lng: lngRaw }
        : null;

      let branch = await this.branchQueryService.findOneByCode(branchCode);
      if (!branch) {
        const coords = suppliedCoords ?? await getRealCoordinates(address, branchName, district, state);
        const zoneName = await this.resolveZoneName(state, project.clientId);
        
        const zone = await this.branchService.findOrCreateZone(zoneName, project.clientId, [state.toUpperCase()]);

        const pincode = pincodeStr || address.match(/\b\d{6}\b/)?.[0] || null;
        const branchType = ['BANGALORE', 'CHENNAI', 'PUNE', 'NOIDA'].includes(district) ? 'METRO' : 'URBAN';
        // Was a random name from a hardcoded list and a random phone number, which
        // put fabricated contact details in front of an assayer about to visit the
        // branch. Use what the client supplied; leave blank when they supplied nothing.
        const managerName = (row['Branch Manager'] || '').toString().trim() || null;
        const phone = (row['Branch Phone'] || '').toString().trim() || null;

        branch = await this.branchService.registerImportedBranch({
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
          email: (row['Branch Email'] || '').toString().trim() || null,
          riskScore: 2.0,
          // Optional operational attributes: taken from the sheet when the client
          // supplies them, otherwise sensible defaults. These feed assayer matching,
          // so a real value here produces a better-matched assayer than the default.
          riskCategory: (row['Risk Category'] || '').toString().trim().toUpperCase() || 'LOW',
          complexity: (row.Complexity || '').toString().trim().toUpperCase() || 'STANDARD',
          estimatedDurationHours:
            parseFloat(String(row['Estimated Hours'] ?? '')) || calculatedHours || 6.0,
          createdBy: userId,
          updatedBy: userId,
        }, userId);
      } else if (calculatedHours !== null) {
        // Update existing branch with calculated hours
        await this.branchService.update(branch.id, { estimatedDurationHours: calculatedHours }, userId);
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
          packetCount: !isNaN(packetCount) && packetCount > 0 ? packetCount : null,
          createdBy: userId,
          updatedBy: userId,
        });
        const savedPb = await this.projectBranchRepository.save(pb);
        addedBranches.push(savedPb);

        const existingAsmt = await this.assessmentRepository.findOne({
          where: { projectId: project.id, branchId: branch.id, isActive: true },
        });
        if (!existingAsmt) {
          const asmt = this.assessmentRepository.create({
            projectId: project.id,
            branchId: branch.id,
            zoneId: branch.zoneId,
            status: AssessmentStatus.PENDING_PLANNING,
            packetSize: !isNaN(packetCount) && packetCount > 0 ? packetCount : null,
            createdBy: userId,
            updatedBy: userId,
          });
          await this.assessmentRepository.save(asmt);
        }
      } else if (!isNaN(packetCount) && packetCount > 0) {
        // Update packet count on existing project-branch
        pb.packetCount = packetCount;
        pb.updatedBy = userId;
        await this.projectBranchRepository.save(pb);
      }
    }

    return this.findProjectBranches(project.id);
  }

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

  async startProjectPlanning(id: string, userId: string, role = SystemRole.SUPER_ADMINISTRATOR): Promise<ProjectEntity> {
    const project = await this.findOne(id);
    const prev = project.status;
    const next = ProjectStatus.PLANNING;
    return this.workflowEngine.executeCommand(
      'project',
      project.id,
      'StartPlanningCommand',
      prev,
      next,
      userId,
      role,
      [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER],
      async () => {
        const event = ProjectStateMachine.startPlanning(project, userId);
        const saved = await this.projectRepository.save(project);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
      }
    );
  }

  async readyProjectForScheduling(id: string, userId: string, role = SystemRole.SUPER_ADMINISTRATOR): Promise<ProjectEntity> {
    const project = await this.findOne(id);
    const prev = project.status;
    const next = ProjectStatus.SCHEDULING;
    return this.workflowEngine.executeCommand(
      'project',
      project.id,
      'ReadyProjectForSchedulingCommand',
      prev,
      next,
      userId,
      role,
      [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER],
      async () => {
        const event = ProjectStateMachine.readyForScheduling(project, userId);
        const saved = await this.projectRepository.save(project);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
      }
    );
  }

  async startProjectExecution(id: string, userId: string, role = SystemRole.SUPER_ADMINISTRATOR): Promise<ProjectEntity> {
    const project = await this.findOne(id);
    const prev = project.status;
    const next = ProjectStatus.EXECUTION;
    return this.workflowEngine.executeCommand(
      'project',
      project.id,
      'StartProjectExecutionCommand',
      prev,
      next,
      userId,
      role,
      [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER],
      async () => {
        const event = ProjectStateMachine.startExecution(project, userId);
        const saved = await this.projectRepository.save(project);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
      }
    );
  }

  async startProjectValidation(id: string, userId: string, role = SystemRole.SUPER_ADMINISTRATOR): Promise<ProjectEntity> {
    const project = await this.findOne(id);
    const prev = project.status;
    const next = ProjectStatus.VALIDATION;
    return this.workflowEngine.executeCommand(
      'project',
      project.id,
      'StartProjectValidationCommand',
      prev,
      next,
      userId,
      role,
      [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER],
      async () => {
        const event = ProjectStateMachine.startValidation(project, userId);
        const saved = await this.projectRepository.save(project);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
      }
    );
  }

  async completeProject(id: string, userId: string, role = SystemRole.SUPER_ADMINISTRATOR): Promise<ProjectEntity> {
    const project = await this.findOne(id);
    const prev = project.status;
    const next = ProjectStatus.COMPLETED;
    return this.workflowEngine.executeCommand(
      'project',
      project.id,
      'CompleteProjectCommand',
      prev,
      next,
      userId,
      role,
      [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER],
      async () => {
        const event = ProjectStateMachine.completeProject(project, userId);
        const saved = await this.projectRepository.save(project);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
      }
    );
  }

  async cancelProject(id: string, userId: string, role = SystemRole.SUPER_ADMINISTRATOR): Promise<ProjectEntity> {
    const project = await this.findOne(id);
    const prev = project.status;
    const next = ProjectStatus.CANCELLED;
    return this.workflowEngine.executeCommand(
      'project',
      project.id,
      'CancelProjectCommand',
      prev,
      next,
      userId,
      role,
      [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER],
      async () => {
        const event = ProjectStateMachine.cancelProject(project, userId);
        const saved = await this.projectRepository.save(project);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
      }
    );
  }

  async holdProject(id: string, userId: string, role = SystemRole.SUPER_ADMINISTRATOR): Promise<ProjectEntity> {
    const project = await this.findOne(id);
    const prev = project.status;
    const next = ProjectStatus.ON_HOLD;
    return this.workflowEngine.executeCommand(
      'project',
      project.id,
      'HoldProjectCommand',
      prev,
      next,
      userId,
      role,
      [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER],
      async () => {
        const event = ProjectStateMachine.holdProject(project, userId);
        const saved = await this.projectRepository.save(project);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
      }
    );
  }

  async archiveProject(id: string, userId: string, role = SystemRole.SUPER_ADMINISTRATOR): Promise<ProjectEntity> {
    const project = await this.findOne(id);
    const prev = project.status;
    const next = ProjectStatus.ARCHIVED;
    return this.workflowEngine.executeCommand(
      'project',
      project.id,
      'ArchiveProjectCommand',
      prev,
      next,
      userId,
      role,
      [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER],
      async () => {
        const event = ProjectStateMachine.archiveProject(project, userId);
        const saved = await this.projectRepository.save(project);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
      }
    );
  }

  /**
   * Writes a per-branch status change to the audit trail.
   *
   * A branch moves IMPORTED → PLANNING → … → CLOSED through six methods and a
   * dozen call sites, and none of them recorded anything: `audit_events` held
   * zero rows for PROJECT_BRANCH, so a branch could show as CLOSED in planning
   * with no way to find out when, by whom, or through which steps it got there.
   * Recorded here rather than in each method so a future transition cannot
   * silently skip it.
   */
  /**
   * Everything that has happened to one branch, newest first.
   *
   * Stitches together the four places a branch's story is actually written —
   * its own status transitions, the assignments offered on it, the documents
   * that moved, and its validation case — because none of them individually
   * answers "what happened to this branch", which is the question planning
   * actually asks when a branch shows up CLOSED.
   */
  async getBranchHistory(projectBranchId: string): Promise<any> {
    const pb = await this.projectBranchRepository.findOne({
      where: { id: projectBranchId },
      relations: ['branch', 'project'],
    });
    if (!pb) throw new NotFoundException(`Project branch ${projectBranchId} not found.`);

    const rows = await this.projectBranchRepository.manager.query(
      `
      -- Branch status transitions
      SELECT 'STATUS' AS kind, ae.occurred_at AS at, ae.event_type AS title,
             ae.previous_state AS "from", ae.new_state AS "to", ae.remarks AS detail,
             COALESCE(ae.user_display_name,
                      NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
                      u.username) AS actor
      FROM audit_events ae
      LEFT JOIN users u ON u.id = ae.user_id
      WHERE ae.entity_type = 'PROJECT_BRANCH' AND ae.entity_id = $1

      UNION ALL
      -- Assignments offered / accepted / completed on this branch
      SELECT 'ASSIGNMENT', a.updated_at, 'Assignment ' || a.status::text,
             NULL, a.status::text, a.assignment_number,
             COALESCE(asr.display_name, 'unassigned')
      FROM assignments a
      LEFT JOIN assayers asr ON asr.id = a.assayer_id
      WHERE a.project_branch_id = $1 AND a.is_active = true

      UNION ALL
      -- Paperwork in and out
      SELECT 'DOCUMENT', d.updated_at, d.type::text || ' ' || d.status::text,
             NULL, d.status::text, d.file_name,
             COALESCE(NULLIF(TRIM(CONCAT_WS(' ', du.first_name, du.last_name)), ''), du.username)
      FROM documents d
      LEFT JOIN users du ON du.id = d.assigned_to_user_id
      WHERE d.project_branch_id = $1 AND d.is_active = true

      UNION ALL
      -- Validation / review outcome
      SELECT 'VALIDATION', ae2.occurred_at, ae2.event_type,
             ae2.previous_state, ae2.new_state, ae2.remarks,
             COALESCE(ae2.user_display_name,
                      NULLIF(TRIM(CONCAT_WS(' ', vu.first_name, vu.last_name)), ''),
                      vu.username)
      FROM audit_events ae2
      LEFT JOIN users vu ON vu.id = ae2.user_id
      WHERE ae2.entity_type = 'VALIDATION'
        AND ae2.entity_id IN (SELECT id FROM validation_cases WHERE project_branch_id = $1)

      ORDER BY at DESC
      `,
      [projectBranchId],
    );

    return {
      projectBranchId,
      branchName: pb.branch?.name ?? null,
      branchCode: pb.branch?.branchCode ?? null,
      projectName: pb.project?.name ?? null,
      currentStatus: pb.status,
      scheduledDate: pb.scheduledDate ?? null,
      packetCount: pb.packetCount ?? null,
      timeline: rows,
    };
  }

  private async recordBranchTransition(
    pb: ProjectBranchEntity,
    previousStatus: string,
    userId: string,
  ): Promise<void> {
    if (previousStatus === pb.status) return;
    try {
      await this.auditService.recordEvent({
        category: EventCategory.WORKFLOW,
        eventType: `PROJECT_BRANCH_${pb.status}`,
        entityType: 'PROJECT_BRANCH',
        entityId: pb.id,
        previousState: previousStatus,
        newState: pb.status,
        userId,
        remarks: `Branch moved ${previousStatus} → ${pb.status}`,
      });
    } catch (err: any) {
      // History is valuable but must never block the transition itself.
      console.warn(`Could not record branch transition for ${pb.id}: ${err?.message}`);
    }
  }

  async initiateBranchPlanning(projectBranchId: string, userId: string, manager?: any): Promise<ProjectBranchEntity> {
    const repo = manager ? manager.getRepository(ProjectBranchEntity) : this.projectBranchRepository;
    const pb = await repo.findOne({
      where: { id: projectBranchId, isActive: true },
    });
    if (!pb) {
      throw new NotFoundException(`Project branch link ${projectBranchId} not found.`);
    }
    const previousStatus = pb.status;
    const event = ProjectBranchStateMachine.initiatePlanning(pb, userId);
    pb.updatedBy = userId;
    const saved = await repo.save(pb);
    await this.recordBranchTransition(saved, previousStatus, userId);
    this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  /**
   * Record that a branch cannot be staffed, with the reason on the branch record.
   *
   * This is the write side of a status that has been declared everywhere and set nowhere —
   * the reason no branch has ever left `IMPORTED` for a coverage failure, and why an
   * unstaffable branch is currently indistinguishable from an untouched one.
   */
  async markBranchUnableToCover(
    projectBranchId: string,
    userId: string,
    reason: string,
    manager?: any,
  ): Promise<ProjectBranchEntity> {
    const repo = manager ? manager.getRepository(ProjectBranchEntity) : this.projectBranchRepository;
    const pb = await repo.findOne({ where: { id: projectBranchId, isActive: true } });
    if (!pb) {
      throw new NotFoundException(`Project branch link ${projectBranchId} not found.`);
    }
    const previousStatus = pb.status;
    const event = ProjectBranchStateMachine.markUnableToCover(pb, userId, reason);
    // Kept on the branch so the cause travels with the record into client SLA reporting,
    // rather than living only in the audit log.
    pb.remarks = reason.trim();
    pb.updatedBy = userId;
    const saved = await repo.save(pb);
    await this.recordBranchTransition(saved, previousStatus, userId);
    this.eventPublisher.publish(event.constructor.name, event);

    // `BRANCH_UNABLE_TO_COVER` has sat in the notification catalogue — CRITICAL priority,
    // addressed to ops and admins — with no code path that could ever emit it. This is that
    // path. A branch nobody can staff is exactly the event ops needs pushed at them.
    const withBranch = await repo.findOne({ where: { id: saved.id }, relations: ['branch'] }).catch(() => null);
    this.notificationDispatch.emitSafe({
      type: 'BRANCH_UNABLE_TO_COVER',
      entityType: 'PROJECT_BRANCH',
      entityId: saved.id,
      actorUserId: userId,
      dedupeKey: `BRANCH_UNABLE_TO_COVER:${saved.id}`,
      payload: {
        projectBranchId: saved.id,
        branchName: withBranch?.branch?.name ?? 'A branch',
        reason: reason.trim(),
      },
    });

    return saved;
  }

  /** Return an uncoverable branch to the planning pool. */
  async reopenBranchCoverage(projectBranchId: string, userId: string, manager?: any): Promise<ProjectBranchEntity> {
    const repo = manager ? manager.getRepository(ProjectBranchEntity) : this.projectBranchRepository;
    const pb = await repo.findOne({ where: { id: projectBranchId, isActive: true } });
    if (!pb) {
      throw new NotFoundException(`Project branch link ${projectBranchId} not found.`);
    }
    const previousStatus = pb.status;
    const event = ProjectBranchStateMachine.reopenCoverage(pb, userId);
    pb.updatedBy = userId;
    const saved = await repo.save(pb);
    await this.recordBranchTransition(saved, previousStatus, userId);
    this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async confirmBranchAssignment(projectBranchId: string, userId: string, manager?: any): Promise<ProjectBranchEntity> {
    const repo = manager ? manager.getRepository(ProjectBranchEntity) : this.projectBranchRepository;
    const pb = await repo.findOne({
      where: { id: projectBranchId, isActive: true },
    });
    if (!pb) {
      throw new NotFoundException(`Project branch link ${projectBranchId} not found.`);
    }
    const previousStatus = pb.status;
    const event = ProjectBranchStateMachine.confirmAssignment(pb, userId);
    pb.updatedBy = userId;
    const saved = await repo.save(pb);
    await this.recordBranchTransition(saved, previousStatus, userId);
    this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async scheduleBranchAudit(projectBranchId: string, userId: string, manager?: any): Promise<ProjectBranchEntity> {
    const repo = manager ? manager.getRepository(ProjectBranchEntity) : this.projectBranchRepository;
    const pb = await repo.findOne({
      where: { id: projectBranchId, isActive: true },
    });
    if (!pb) {
      throw new NotFoundException(`Project branch link ${projectBranchId} not found.`);
    }
    const previousStatus = pb.status;
    const event = ProjectBranchStateMachine.scheduleAudit(pb, userId);
    pb.updatedBy = userId;
    const saved = await repo.save(pb);
    await this.recordBranchTransition(saved, previousStatus, userId);
    this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async completeBranchAudit(projectBranchId: string, userId: string, manager?: any): Promise<ProjectBranchEntity> {
    const repo = manager ? manager.getRepository(ProjectBranchEntity) : this.projectBranchRepository;
    const pb = await repo.findOne({
      where: { id: projectBranchId, isActive: true },
    });
    if (!pb) {
      throw new NotFoundException(`Project branch link ${projectBranchId} not found.`);
    }
    const previousStatus = pb.status;
    const event = ProjectBranchStateMachine.completeAudit(pb, userId);
    pb.updatedBy = userId;
    const saved = await repo.save(pb);
    await this.recordBranchTransition(saved, previousStatus, userId);
    this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async completeBranchValidation(projectBranchId: string, userId: string, manager?: any): Promise<ProjectBranchEntity> {
    const repo = manager ? manager.getRepository(ProjectBranchEntity) : this.projectBranchRepository;
    const pb = await repo.findOne({
      where: { id: projectBranchId, isActive: true },
    });
    if (!pb) {
      throw new NotFoundException(`Project branch link ${projectBranchId} not found.`);
    }
    const previousStatus = pb.status;
    const event = ProjectBranchStateMachine.completeValidation(pb, userId);
    pb.updatedBy = userId;
    const saved = await repo.save(pb);
    await this.recordBranchTransition(saved, previousStatus, userId);
    this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async closeBranchProject(projectBranchId: string, userId: string, manager?: any): Promise<ProjectBranchEntity> {
    const repo = manager ? manager.getRepository(ProjectBranchEntity) : this.projectBranchRepository;
    const pb = await repo.findOne({
      where: { id: projectBranchId, isActive: true },
    });
    if (!pb) {
      throw new NotFoundException(`Project branch link ${projectBranchId} not found.`);
    }
    const previousStatus = pb.status;
    const event = ProjectBranchStateMachine.close(pb, userId);
    pb.updatedBy = userId;
    const saved = await repo.save(pb);
    await this.recordBranchTransition(saved, previousStatus, userId);
    this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }
}
