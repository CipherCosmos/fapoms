/**
 * FAPOMS — Project Service
 *
 * Handles CRUD and lifecycle state transitions for projects and project branches (Part 3 Module 2, Part 5 §3).
 */

import { Injectable, NotFoundException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';

import { ProjectEntity } from './project.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { AssessmentEntity } from './assessment.entity';
import { ClientEntity } from '../client/client.entity';
import { ZoneEntity } from '../zone/zone.entity';
import { ProjectStateMachine, ProjectBranchStateMachine } from './project.state-machine';
import { BranchService, UpdateBranchDto } from '../branch/branch.service';
import { ProjectQueryService } from './project-query.service';
import { BranchQueryService } from '../branch/branch-query.service';
import { AuditService } from '../../core/audit/audit.service';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { AssignmentStatus, EventCategory, ProjectStatus, ProjectBranchStatus, AssessmentStatus, SystemRole, resolveRegion, PROJECT_TRANSITIONS, toWorkflowTransitions } from '@fapoms/shared';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import * as xlsx from 'xlsx';
// One implementation of "read a spreadsheet column", shared with the assayer roster upload —
// the exact-header bug that dropped every row has now been hit by both importers.
import { parseSheet, rowReader, identifyTemplate } from '../../core/excel/sheet-reader';
import { geocodeIndiaRobust, GeocodeResult } from '../geo/india-geocoder';
import { needsBetterFix } from '../geo/coordinate-resolution';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { AssignmentEntity } from '../assignment/assignment.entity';

/**
 * Geocode a branch address for a bulk import. Never throws — worst case returns a
 * state/country centroid with source='none'.
 *
 * `precise: false` on purpose, and it is the one interesting decision here. The free OSM tiers
 * are rate-limited by their providers to roughly one lookup per second, so resolving a 400-row
 * client file precisely would take seven minutes with the HTTP request held open the whole
 * time. The import therefore takes the fast tiers — pincode and centroid, mostly served from
 * cache — and the precision backfill upgrades those rows afterwards, out of the request path.
 * The tier is recorded either way, so nothing pretends a centroid is a location in the meantime.
 */
async function getRealCoordinates(
  address: string, name: string, district: string, state: string,
): Promise<{ lat: number; lng: number; geoSource: string; geoAccuracyMeters: number; geoMatchedName: string | null }> {
  const pinMatch = address.match(/\b\d{6}\b/);
  const result: GeocodeResult = await geocodeIndiaRobust(
    address, name, district, state, pinMatch ? pinMatch[0] : null,
    { precise: false, name },
  );

  return {
    lat: result.lat,
    lng: result.lng,
    geoSource: result.source,
    geoAccuracyMeters: Math.round(result.accuracyMeters),
    geoMatchedName: result.matchedName ?? null,
  };
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

/**
 * What a branch upload actually did.
 *
 * The endpoint used to return the project's branch list and nothing else, which cannot express
 * "your header row was wrong and all 400 rows were dropped" — the operator saw a success
 * message and a list that had not changed. The counts and the `skipped` rows are the answer to
 * "did that work?", so they travel with the result.
 */
export interface BranchUploadReport {
  branches: ProjectBranchEntity[];
  /** Data rows found in the first sheet. */
  totalRows: number;
  /** Branches created in the branch master. */
  created: number;
  /** Existing branches corrected from the sheet. */
  updated: number;
  /** Branches newly attached to this project (an already-attached branch is not counted). */
  linked: number;
  skipped: { row: number; branchCode?: string; reason: string }[];
  /**
   * Rows that imported but could not be located precisely — they need their coordinates corrected
   * before planning or check-in will behave. Distinct from `skipped`: these branches exist.
   */
  imprecise: { row: number; branchCode?: string; reason: string }[];
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


/**
 * A 0-10 risk rating derived from the client's stated risk category, used when the import sheet
 * carries no explicit score. Ten is the top of the scale the planning map reads (>= 7 = high).
 */
function riskScoreFromCategory(category: string): number {
  switch (category) {
    case 'CRITICAL': return 9;
    case 'HIGH': return 7;
    case 'MEDIUM': return 4;
    case 'LOW': return 2;
    default: return 2;
  }
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
      @InjectDataSource()
      private readonly dataSource: DataSource,
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
    // Derived from the one table, not typed out again. The engine gates
    // `executeCommand` before the state machine runs, so a hand-written copy here
    // silently outranks the real rules wherever the two drift apart.
    this.workflowEngine.registerWorkflow('project', toWorkflowTransitions(PROJECT_TRANSITIONS));
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

  async findAll(
    page = 1,
    limit = 50,
    scope?: Partial<GlobalScope>,
  ): Promise<{ projects: ProjectEntity[]; total: number }> {
    return this.projectQueryService.findAll(page, limit, scope);
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
    /**
     * Re-check the window against what the project will actually hold.
     *
     * The DTO's ordering rule can only compare the two dates when BOTH are in the payload, so a
     * partial edit that sends just `endDate` would slip past it and invert the window against the
     * stored `startDate`. Checking here — after the merge, before the save — is the only place
     * that sees the final pair, whichever half the caller supplied.
     */
    if (project.startDate && project.endDate && new Date(project.endDate) < new Date(project.startDate)) {
      throw new BadRequestException(
        'The project would end before it starts. Check the start and end dates.',
      );
    }
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

    // Deactivate associated project branches
    await this.dataSource.query(
      `UPDATE project_branches SET is_active = false, updated_by = $1 WHERE project_id = $2 AND is_active = true`,
      [userId, id]
    );

    // Deactivate associated assessments
    await this.dataSource.query(
      `UPDATE assessments SET is_active = false, updated_by = $1 WHERE project_id = $2 AND is_active = true`,
      [userId, id]
    );

    // Deactivate associated assignments
    await this.dataSource.query(
      `UPDATE assignments SET is_active = false, updated_by = $1 WHERE project_id = $2 AND is_active = true`,
      [userId, id]
    );

    /**
     * The scheduled visits those assignments carry.
     *
     * The cascade reached the assignment and stopped, so closing a project left its dated slots
     * live on the calendar and the day plan — the same gap the assayer deletion had, and with
     * the same symptom: work that operations still plans around for a project that is gone.
     */
    await this.dataSource.query(
      `UPDATE schedules SET is_active = false, updated_by = $1
       WHERE is_active = true AND assignment_id IN (SELECT id FROM assignments WHERE project_id = $2)`,
      [userId, id]
    );

    // Deactivate documents associated with the project's assessments
    await this.dataSource.query(
      `UPDATE documents SET is_active = false, updated_by = $1
       WHERE assessment_id IN (SELECT id FROM assessments WHERE project_id = $2) AND is_active = true`,
      [userId, id]
    );

    // Deactivate validation cases associated with the project branches
    await this.dataSource.query(
      `UPDATE validation_cases SET is_active = false, updated_by = $1 
       WHERE project_branch_id IN (SELECT id FROM project_branches WHERE project_id = $2) AND is_active = true`,
      [userId, id]
    );

    // Deactivate validation queries associated with the validation cases
    await this.dataSource.query(
      `UPDATE validation_queries SET is_active = false, updated_by = $1 
       WHERE validation_case_id IN (
         SELECT id FROM validation_cases 
         WHERE project_branch_id IN (SELECT id FROM project_branches WHERE project_id = $2)
       ) AND is_active = true`,
      [userId, id]
    );

    // Deactivate call logs associated with assessments
    await this.dataSource.query(
      `UPDATE call_logs SET is_active = false, updated_by = $1 
       WHERE assessment_id IN (SELECT id FROM assessments WHERE project_id = $2) AND is_active = true`,
      [userId, id]
    );

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'PROJECT_DELETED',
      entityType: 'PROJECT',
      entityId: id,
      userId,
      remarks: `Soft deleted project ${project.name} (${project.projectNumber}) and all related records`,
    });

    this.eventPublisher.publish('project:deleted', {
      eventType: 'project:deleted',
      aggregateId: id,
      userId,
      organizationId: project.organizationId,
      payload: { id, name: project.name, projectNumber: project.projectNumber },
    });
  }

  async findProjectBranches(
    projectId: string,
    scope?: Partial<GlobalScope>,
  ): Promise<ProjectBranchEntity[]> {
    return this.projectQueryService.findProjectBranches(projectId, scope);
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
      'Risk Category', 'Risk Score', 'Complexity', 'Estimated Hours',
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
      { Field: 'Risk Score', Required: 'No', Description: '0-10 rating. Leave blank to derive it from Risk Category. Branches scoring 7 or above are highlighted for attention on the planning map.' },
      { Field: 'Complexity', Required: 'No', Description: 'SIMPLE / STANDARD / COMPLEX. Feeds the same matching, and the time allowance per branch.' },
      { Field: 'Estimated Hours', Required: 'No', Description: 'Override the audit duration for this branch. Normally leave blank — it is calculated from Packets, which stays accurate as packet counts change each cycle.' },
    ];
    const instrWs = xlsx.utils.json_to_sheet(instructions, { header: ['Field', 'Required', 'Description'] });
    instrWs['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 110 }];
    xlsx.utils.book_append_sheet(wb, instrWs, 'Instructions');

    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  }

  async uploadBranchesFromExcel(
    projectId: string,
    fileBuffer: Buffer,
    userId: string,
  ): Promise<BranchUploadReport> {
    const project = await this.findOne(projectId);

    // Read client planning preferences for hours-per-packet rate
    const client = project.clientId
      ? await this.clientRepository.findOne({ where: { id: project.clientId } })
      : null;
    const planningPrefs = client?.planningPreferences || {};
    const minutesPerPacket = Number(planningPrefs.minutesPerPacket) || 15; // default 15min per packet

    // Finds the header row rather than assuming row 1 — client branch lists routinely open with
    // a merged title and a blank line, which otherwise makes every column `__EMPTY` and drops
    // the whole file. See core/excel/sheet-reader.
    const sheet = parseSheet(fileBuffer, ['BRANCH', 'BRANCH_NAME', 'STATE']);
    const sheetName = sheet.sheetName;
    const rows = sheet.rows;

    if (rows.length === 0) {
      throw new BadRequestException(
        `The first sheet of this file ("${sheetName ?? 'none'}") has no data rows. ` +
          `Download the template, fill in the Branch sheet, and upload that.`,
      );
    }

    /**
     * Refuse the other importer's file outright.
     *
     * The mirror of the check on the assayer upload, and the more dangerous direction: an
     * assayer roster has a name column and an address column, so this importer would not reject
     * it — it would cheerfully create a "branch" per person, geocode their home, and attach
     * them to the project. Rejecting on the file's identity catches that before the first write.
     */
    const identified = identifyTemplate(sheet);
    if (identified && identified.id !== 'branch-import') {
      throw new BadRequestException(
        `This file is a ${identified.label}, not a branch list. ` +
          `Upload it under ${identified.where} instead — importing it here would create branches out of the wrong data.`,
      );
    }

    const addedBranches: ProjectBranchEntity[] = [];
    /**
     * Rows the importer could not use, and why.
     *
     * These were `continue` with no record kept. A file whose header row says `Branch` instead
     * of `BRANCH_NAME` dropped every single row, and the endpoint still returned 200 with the
     * project's existing branch list — so the operator was told the upload succeeded while
     * nothing had been imported. Anything skipped is now named, with its spreadsheet row number.
     */
    const skipped: { row: number; branchCode?: string; reason: string }[] = [];
    let createdCount = 0;
    let updatedCount = 0;
    /**
     * Which row first used each branch code, so a repeat inside one file can be named.
     *
     * The loop upserts by `branchCode`, so a sheet listing the same code twice silently applied
     * the later row over the earlier one — and because the two rows rarely agree on every column,
     * what survived was a mixture of both: one row's name and address on top of the other's
     * contact and risk data. The counts said "created 6, updated 1", which reads as an ordinary
     * refresh of a pre-existing branch rather than "two of your rows collided".
     */
    const firstRowForCode = new Map<string, number>();
    /**
     * Rows that imported but landed on a fallback coordinate — a warning list, not a skip list.
     * Kept separate from `skipped` because these branches DID import; they simply cannot be
     * planned or checked into until someone corrects where they are.
     */
    const imprecise: { row: number; branchCode?: string; reason: string }[] = [];

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      // The header row itself, plus however many rows preceded it.
      const rowNumber = index + sheet.headerRow + 1;
      const get = rowReader(row);

      // Every column is read through the alias list rather than one exact header, so the
      // client's own export, our template, and a hand-edited copy of either all import.
      const branchName = get('BRANCH_NAME', 'Branch Name', 'BranchName', 'Name');
      const branchCode = get('BRANCH', 'Branch Code', 'BranchCode', 'BrCode', 'Code', 'SOL ID', 'SolId');
      if (!branchName && !branchCode) {
        // A wholly blank row — the trailing rows Excel leaves behind. Not worth reporting.
        continue;
      }
      if (!branchName) {
        skipped.push({ row: rowNumber, branchCode, reason: 'No branch name in this row.' });
        continue;
      }
      if (!branchCode) {
        skipped.push({ row: rowNumber, reason: `No branch code for "${branchName}".` });
        continue;
      }

      // Same code twice in one sheet: keep the first occurrence and name the collision, rather
      // than overwriting it with the later row and reporting the result as a routine "updated".
      const codeKey = branchCode.trim().toUpperCase();
      const firstRow = firstRowForCode.get(codeKey);
      if (firstRow !== undefined) {
        skipped.push({
          row: rowNumber,
          branchCode,
          reason: `Duplicate of row ${firstRow} (branch code ${branchCode}) — the first row was kept.`,
        });
        continue;
      }
      firstRowForCode.set(codeKey, rowNumber);

      /**
       * One bad row must not cost the operator the other 399.
       *
       * Nothing here was guarded, so a single failure — a geography check that cannot verify a
       * district, a geocoder timeout, a constraint violation — threw straight out of the
       * endpoint as a 500. Rows already imported stayed in the database, the rest never ran,
       * and the operator was shown a crash with no way to tell how far it got. Each row now
       * either lands or is reported by number.
       */
      try {
        const district = get('DISTRICT', 'District', 'DistrictName').toUpperCase();
        const state = get('STATE', 'State', 'StateName');
        const address = get('Branch Address', 'Address', 'BranchAddress');
        const pincodeStr = get('Pincode', 'Pin', 'Pin Code', 'Postal Code', 'Zip');

        if (!state) {
          // State drives the region, the zone and the public-holiday calendar. A branch without
          // one is unplannable, so it is refused loudly rather than imported into limbo.
          skipped.push({ row: rowNumber, branchCode, reason: `No state for "${branchName}".` });
          continue;
        }

        /**
         * A pincode has to look like a pincode.
         *
         * `ABCDE` was stored verbatim and thereafter looked like a real postcode to anyone
         * reading the record — and to the geocoder, which quietly ignored it and fell back to the
         * city centroid. Six digits, first one non-zero, is the Indian format. Blank stays
         * allowed: plenty of client exports omit it, and the address still geocodes.
         */
        if (pincodeStr && !/^[1-9][0-9]{5}$/.test(pincodeStr.trim())) {
          skipped.push({
            row: rowNumber,
            branchCode,
            reason: `"${pincodeStr}" is not a valid pincode for "${branchName}" — expected 6 digits.`,
          });
          continue;
        }

        // Read packet count and calculate estimated duration
        const packetCount = parseInt(get('Packets', 'packet_count', 'Packet Count'), 10);
        const calculatedHours = !isNaN(packetCount) && packetCount > 0
          ? parseFloat(((packetCount * minutesPerPacket) / 60).toFixed(2))
          : null;

        // Client-supplied coordinates win over geocoding: they are exact, and they
        // avoid a network lookup per branch that is rate-limited to ~1/second and
        // throws when it cannot resolve an address.
        const latRaw = parseFloat(get('Latitude', 'Lat'));
        const lngRaw = parseFloat(get('Longitude', 'Lng', 'Long'));
        // Normalised to the same shape a geocode returns, so the two paths cannot diverge in
        // what they record. A coordinate the client put in their own sheet is authoritative for
        // that branch, so it is kept as-is and marked accordingly rather than re-derived.
        const suppliedCoords: { lat: number; lng: number; geoSource: string; geoAccuracyMeters: number; geoMatchedName: string | null } | null =
          Number.isFinite(latRaw) && Number.isFinite(lngRaw)
            ? { lat: latRaw, lng: lngRaw, geoSource: 'geocoder', geoAccuracyMeters: 60, geoMatchedName: 'Supplied in the import sheet' }
            : null;

        /**
         * Canonicalised, never the raw state string.
         *
         * This wrote `region: state`, so an import filled the column with "Kerala", "MAHARASHTRA"
         * and so on. Region scoping matches `region IN ('SOUTH', …)`, so every branch that ever
         * arrived through this importer was invisible to the operator who owns its territory —
         * and each import silently re-broke the column the normalisation migration had just fixed.
         */
        const region = resolveRegion(state);

        // Scoped to this project's client. Branch codes are the client's own numbering and
        // collide across clients constantly, so an unscoped lookup attached another client's
        // branch — with its address, coordinates and region — to this project.
        let branch = await this.branchQueryService.findOneByCode(branchCode, project.clientId);
        if (!branch) {
          const coords = suppliedCoords ?? await getRealCoordinates(address, branchName, district, state);

          /**
           * Say so when we could not really find the place.
           *
           * The geocoder is honest with itself — an address it cannot resolve comes back as the
           * city centroid, the state centroid, or ultimately the geographic centre of India with
           * `source: 'none'` and `accuracyMeters: 500000`. None of that reached the operator: the
           * row imported like any other, drew a confident pin on the planning map, and then fed
           * real-looking distances and travel quotes into assayer matching. It also made check-in
           * impossible, since the assayer's true position is nowhere near the fallback point.
           *
           * Reported rather than skipped: the branch is still wanted, it just needs its location
           * corrected before anyone plans against it. The assayer import already warns this way.
           */
          if (needsBetterFix(coords.geoSource, coords.geoAccuracyMeters)) {
            const km = Math.round(coords.geoAccuracyMeters / 1000);
            imprecise.push({
              row: rowNumber,
              branchCode,
              reason:
                coords.geoSource === 'none'
                  ? `"${branchName}" could not be located from its address — it has been placed on a fallback point and needs its location set before planning.`
                  : `"${branchName}" could only be placed to about ${km} km (${coords.geoSource}) — set its location for accurate travel costs and check-in.`,
            });
          }

          const zoneName = await this.resolveZoneName(state, project.clientId);

          const zone = await this.branchService.findOrCreateZone(zoneName, project.clientId, [state.toUpperCase()]);

          const pincode = pincodeStr || address.match(/\b\d{6}\b/)?.[0] || null;
          const branchType = ['BANGALORE', 'CHENNAI', 'PUNE', 'NOIDA'].includes(district) ? 'METRO' : 'URBAN';
          // Was a random name from a hardcoded list and a random phone number, which
          // put fabricated contact details in front of an assayer about to visit the
          // branch. Use what the client supplied; leave blank when they supplied nothing.
          const managerName = get('Branch Manager', 'Manager', 'Manager Name') || null;
          const phone = get('Branch Phone', 'Phone', 'Contact Number') || null;

          branch = await this.branchService.registerImportedBranch({
            branchCode,
            solId: get('SOL ID', 'SolId') || branchCode,
            name: branchName,
            address,
            state,
            district,
            // The sheet's own city when it has one. This was hardcoded to the district, so every
            // imported branch claimed to be in a city named after its district — which is what
            // the assayer sees on their job card and what the city-tier fee multiplier reads.
            city: get('CITY', 'City', 'CityName') || district,
            pincode,
            branchType,
            latitude: coords.lat,
            longitude: coords.lng,
            location: { type: 'Point', coordinates: [coords.lng, coords.lat] },
            // Recorded, so a branch sitting on its district's centroid is visibly a placeholder
            // rather than silently indistinguishable from one pinned at its front door — and so
            // the precision backfill knows which rows are worth re-resolving.
            geoSource: coords.geoSource,
            geoAccuracyMeters: coords.geoAccuracyMeters,
            geoMatchedName: coords.geoMatchedName,
            geoResolvedAt: new Date(),
            organizationId: project.organizationId,
            clientId: project.clientId,
            zoneId: zone ? zone.id : null,
            region,
            territory: `${district} Area`,
            managerName,
            phone,
            email: get('Branch Email', 'Email') || null,
            // Taken from the sheet when the client supplies it, otherwise derived from the risk
            // category they did supply. This was the literal 2.0 for every branch ever imported,
            // which is why all 72 branches in the database score identically and the map's
            // "high risk" highlight (>= 7) could never fire for anybody.
            riskScore: parseFloat(get('Risk Score')) || riskScoreFromCategory(
              get('Risk Category').toUpperCase(),
            ),
            // Optional operational attributes: taken from the sheet when the client
            // supplies them, otherwise sensible defaults. These feed assayer matching,
            // so a real value here produces a better-matched assayer than the default.
            riskCategory: get('Risk Category').toUpperCase() || 'LOW',
            complexity: get('Complexity').toUpperCase() || 'STANDARD',
            estimatedDurationHours:
              parseFloat(get('Estimated Hours')) || calculatedHours || 6.0,
            createdBy: userId,
            updatedBy: userId,
          }, userId);
          createdCount++;
        } else {
          /**
           * Re-importing a branch corrects it, rather than only touching its hours.
           *
           * The template prefills existing branches precisely so a corrected sheet can be sent
           * back, but the only field this path wrote was `estimatedDurationHours` — a fixed
           * address, a supplied coordinate pair or a missing region were all read and thrown
           * away, and the operator had no way to tell that from a successful import.
           *
           * Only fields the sheet actually carries are written, so a sparse correction sheet
           * cannot blank out data it simply did not mention.
           */
          const patch: UpdateBranchDto = {};
          if (branchName && branchName !== branch.name) patch.name = branchName;
          if (address && address !== branch.address) patch.address = address;
          if (state && state !== branch.state) patch.state = state;
          if (district && district !== branch.district) patch.district = district;
          if (pincodeStr && pincodeStr !== branch.pincode) patch.pincode = pincodeStr;
          if (suppliedCoords) {
            if (Number(branch.latitude) !== suppliedCoords.lat) patch.latitude = suppliedCoords.lat;
            if (Number(branch.longitude) !== suppliedCoords.lng) patch.longitude = suppliedCoords.lng;
          }
          // Backfills the branches that predate region canonicalisation, and repairs any whose
          // state changed. `update` canonicalises again, so a raw state name cannot get back in.
          if (region && branch.region !== region) patch.region = region;
          if (calculatedHours !== null) patch.estimatedDurationHours = calculatedHours;

          if (Object.keys(patch).length > 0) {
            branch = await this.branchService.update(branch.id, patch, userId);
            updatedCount++;
          }
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
      } catch (err: any) {
        skipped.push({
          row: rowNumber,
          branchCode,
          reason: err?.message || 'Unexpected error importing this row.',
        });
      }
    }

    return {
      branches: await this.findProjectBranches(project.id),
      totalRows: rows.length,
      created: createdCount,
      updated: updatedCount,
      linked: addedBranches.length,
      skipped,
      imprecise,
    };
  }

  async removeProjectBranch(projectId: string, projectBranchId: string, userId: string): Promise<ProjectBranchEntity[]> {
    const pb = await this.projectBranchRepository.findOne({
      where: { id: projectBranchId, projectId, isActive: true },
    });

    // Previously wrapped in `if (pb) { ... }` with no else, so a branch that did not exist —
    // or that existed but belonged to a *different* project — returned HTTP 200 and a branch
    // list, reporting a removal that never happened. Silence on a delete is the worst possible
    // answer: the operator believes the branch is gone and stops looking at it.
    if (!pb) {
      throw new NotFoundException(
        `Branch link ${projectBranchId} was not found on project ${projectId}, so nothing was removed.`,
      );
    }

    /**
     * A branch cannot be pulled out from under work already committed to it.
     *
     * There was no check here at all. Removing a branch deactivates the link that assignments,
     * schedules, documents and validation cases all hang off — so doing it while an assayer
     * held a live offer, or had already travelled and checked in, silently stranded their job:
     * the assignment row survives pointing at an inactive branch, the assayer keeps seeing it
     * in the app, and it disappears from every operations view. Completed and cancelled work is
     * historical and safe to unlink.
     */
    const liveAssignment = await this.projectBranchRepository.manager
      .getRepository(AssignmentEntity)
      .findOne({
        where: {
          projectBranchId,
          isActive: true,
          status: In([
            AssignmentStatus.PENDING,
            AssignmentStatus.ACCEPTED,
            AssignmentStatus.CHECKED_IN,
            AssignmentStatus.IN_PROGRESS,
          ]),
        },
      })
      .catch(() => null);

    if (liveAssignment) {
      throw new BadRequestException(
        `This branch has an active assignment (${liveAssignment.assignmentNumber}, ${liveAssignment.status}). ` +
        `Cancel or complete it before removing the branch from the project.`,
      );
    }

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
