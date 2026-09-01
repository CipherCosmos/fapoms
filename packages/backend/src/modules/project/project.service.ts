/**
 * FAPOMS — Project Service
 *
 * Handles CRUD and lifecycle state transitions for projects and project branches (Part 3 Module 2, Part 5 §3).
 */

import { Injectable, NotFoundException, BadRequestException, ConflictException, OnModuleInit } from '@nestjs/common';
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
import { AssignmentStatus, EventCategory, ProjectStatus, ProjectBranchStatus, SystemRole, resolveRegion, PROJECT_TRANSITIONS, toWorkflowTransitions } from '@fapoms/shared';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import * as xlsx from 'xlsx';
// One implementation of "read a spreadsheet column", shared with the assayer roster upload —
// the exact-header bug that dropped every row has now been hit by both importers.
import { parseSheet, rowReader, identifyTemplate, ParsedSheet, RowReader } from '../../core/excel/sheet-reader';
import { BranchEntity } from '../branch/branch.entity';
import { geocodeIndiaRobust, GeocodeResult } from '../geo/india-geocoder';
import { needsBetterFix } from '../geo/coordinate-resolution';
import { GeoPrecisionService } from '../geo/geo-precision.service';
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
export interface BranchImportOutcome {
  /** Data rows found in the first sheet. */
  totalRows: number;
  /** Branches created in the branch master. */
  created: number;
  /** Existing branches corrected from the sheet. */
  updated: number;
  /** Branches newly attached to this project (an already-attached branch is not counted). */
  linked: number;
  skipped: { row: number; solId?: string; reason: string }[];
  /**
   * Rows that imported but could not be located precisely — they need their coordinates corrected
   * before planning or check-in will behave. Distinct from `skipped`: these branches exist.
   */
  imprecise: { row: number; solId?: string; reason: string }[];
}

/**
 * The outcome plus the project's resulting branch list.
 *
 * Split from `BranchImportOutcome` because the queued path must NOT carry the entity list: a job
 * return value is serialised into Redis, and 2,000 hydrated `ProjectBranchEntity` rows (each with
 * its branch and assignments) is megabytes of duplicated state that the caller is about to refetch
 * from `GET /projects/:id/branches` anyway. The synchronous path keeps returning it, because the
 * existing endpoint's `data` field is that list and callers depend on it.
 */
export interface BranchUploadReport extends BranchImportOutcome {
  branches: ProjectBranchEntity[];
}

/**
 * Live counters for an import in flight, published onto the Bull job so the poll endpoint can
 * answer "how far has it got?".
 *
 * Counts only, never the `skipped`/`imprecise` detail arrays: progress is written repeatedly
 * during the run, and re-serialising a growing list of failure reasons on every update would make
 * the reporting cost grow with the number of problems in the file — exactly the shape of the
 * whole-file cache rewrite this work is removing elsewhere. The detail arrives once, in the
 * result, when the job finishes.
 */
export interface BranchImportProgress {
  processed: number;
  total: number;
  created: number;
  updated: number;
  linked: number;
  skipped: number;
  imprecise: number;
}

/**
 * What the request can determine about an upload before committing to do it.
 *
 * This exists so the HTTP request can still reject a wrong or empty file *synchronously* — with
 * the same messages it always gave — while handing the slow part to a queue. Without it, an
 * operator who uploaded the assayer roster to the branch importer would get a cheerful 202 and a
 * job id, and only discover the mistake by polling.
 */
export interface BranchImportPreflight {
  totalRows: number;
  /**
   * Rows with no usable Latitude/Longitude, i.e. the rows that will each cost a geocode.
   *
   * The honest predictor of how long an import takes. The free OSM tiers are rate-limited to
   * about one lookup per second, so 400 unlocated rows is ~7 minutes regardless of how quick the
   * database work is, whereas 2,000 rows that carry their own coordinates never touch the
   * network. Row count alone would push the second case onto the queue for no reason and, worse,
   * would let a 60-row file with no coordinates run synchronously for a minute.
   */
  rowsNeedingGeocode: number;
  sheetName: string;
}

/** Partial edit of a project. Lifecycle moves go through transition(). */
export type UpdateProjectDto = Partial<CreateProjectDto>;

export interface CreateProjectDto {
  name: string;
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
 * A 0-10 risk rating derived from the branch's risk category. Ten is the top of the scale the
 * planning map reads (>= 7 = high), and the recommendation engine's "send a senior assayer"
 * rule fires at 7 — so HIGH and CRITICAL trip it, MEDIUM and LOW do not.
 *
 * The category itself is no longer something the import sheet asks for: it is the project's
 * priority (see `uploadBranchesFromExcel`), which the person creating the project already set.
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

/**
 * Complexity from packet volume — the one per-branch workload signal the sheet actually carries.
 *
 * This used to be a column the operator was asked to fill ("SIMPLE / STANDARD / COMPLEX") and in
 * practice was left blank on every row, so every branch defaulted to STANDARD. Packets is what
 * sizes the audit — the day planner turns it into hours at `minutesPerPacket` — so it is the
 * honest basis for "how involved is this branch", and it moves with each cycle's real numbers
 * instead of sticking at whatever someone typed once.
 *
 * Tiers are read off the real client distribution (16–161 packets; median 58, p75 100) against
 * the 15-minute default: up to 40 packets is about one assayer-day, 41–100 is one to two and a
 * half, past 100 the branch is a multi-day job. No packets recorded means no signal, and the
 * middle tier is the only answer that does not overstate either way.
 */
function complexityFromPackets(packets: number | null): 'SIMPLE' | 'STANDARD' | 'COMPLEX' {
  if (packets === null || !Number.isFinite(packets) || packets <= 0) return 'STANDARD';
  if (packets <= 40) return 'SIMPLE';
  if (packets <= 100) return 'STANDARD';
  return 'COMPLEX';
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
      /**
       * Used only by the Excel import, to resolve every branch code in the file with one
       * `In(codes)` query instead of one `BranchQueryService.findOneByCode` per row.
       * `BranchQueryService` has no batched equivalent and lives in another module's ownership,
       * so the batched read is issued here rather than by widening its API.
       */
      @InjectRepository(BranchEntity)
      private readonly branchRepository: Repository<BranchEntity>,
      private readonly branchQueryService: BranchQueryService,
      private readonly branchService: BranchService,
      private readonly auditService: AuditService,
      private readonly workflowEngine: WorkflowEngine,
      private readonly eventPublisher: DomainEventPublisher,
      private readonly projectQueryService: ProjectQueryService,
      private readonly notificationDispatch: NotificationDispatchService,
      private readonly geoPrecision: GeoPrecisionService,
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

  /**
   * The next free project number for the current year, in the `PRJ-2026-001` house format.
   *
   * The web form used to pre-fill this with `PRJ-<year>-<random 4 digits>` — a guess. The number
   * is unique in the database, so a collision was not caught until save, at which point the user
   * had already filled in the whole form and got it rejected for a field they never chose a value
   * for. The server is the only side that can see every number, including those held by
   * soft-deleted projects.
   */
  private async allocateProjectNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const rows = await this.projectRepository.find({ select: ['projectNumber'], withDeleted: true } as any);
    const prefix = `PRJ-${year}-`;
    const highest = rows.reduce((max, r) => {
      const n = r.projectNumber ?? '';
      if (!n.startsWith(prefix)) return max;
      const m = /(\d+)$/.exec(n.slice(prefix.length));
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    return `${prefix}${String(highest + 1).padStart(3, '0')}`;
  }

  /**
   * The number is the system's to give, and nobody else's.
   *
   * It used to be an optional field on the form: blank meant "allocate one", and anything typed
   * was honoured. Two things came of that. A hand-typed number sits outside the `PRJ-<year>-###`
   * sequence, so the next allocation cannot see it and the series stops being a series. And the
   * number is how a project is named in audit entries, document filenames, billing lines and
   * every export — a value somebody invents once, under pressure, at the bottom of a form they
   * are trying to submit, is a poor thing to hang all of that on.
   *
   * Retried on the unique-constraint violation two simultaneous creates produce: `project_number`
   * is UNIQUE in the database, so the loser of the race is told by Postgres rather than by a
   * guess, and takes the next number.
   */
  async create(dto: CreateProjectDto, userId: string, organizationId?: string | null): Promise<ProjectEntity> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = await this.allocateProjectNumber();
      try {
        return await this.persistNewProject(dto, candidate, userId, organizationId);
      } catch (err: any) {
        // 23505 = unique_violation. Anything else is a real failure and must surface.
        if (err?.code !== '23505' && err?.driverError?.code !== '23505') throw err;
      }
    }
    throw new BadRequestException('Could not allocate a project number just now. Please try again.');
  }

  private async persistNewProject(dto: CreateProjectDto, projectNumber: string, userId: string, organizationId?: string | null): Promise<ProjectEntity> {
    const project = this.projectRepository.create({
      projectNumber,
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
    /*
      `projectNumber` is deliberately not updatable. It is the project's identity in audit
      entries, document filenames, billing lines and every export already handed out; changing it
      renames the project everywhere it has been referenced and nowhere it has been printed.
      The field is gone from the request DTO too, so a client sending one is refused rather than
      silently ignored — an edit that reports success and changes nothing is the worse failure.
    */
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

    /**
     * Only what the person filling this in can actually know.
     *
     * Headers match the column names on the branch lists actually received from clients
     * (BRANCH / BRANCH_NAME / DISTRICT / STATE / Branch Address) so a client's own export can be
     * filled in and returned without restructuring. The importer accepts both these and the
     * friendlier equivalents.
     *
     * This used to carry six more: Latitude, Longitude, Risk Category, Risk Score, Complexity,
     * Estimated Hours. Every one of them was derived by the importer when left blank — and they
     * were left blank on every row of every real sheet received, because an operator does not
     * know a branch's coordinates or a risk rating and should not be asked to invent them. Asking
     * made the template look like a form they had failed to complete. They are derived now, every
     * time: location from the address, risk from the project's priority, complexity and hours
     * from Packets. (A supplied Latitude/Longitude pair is still honoured if a client's export
     * happens to carry one — see the importer — but the template no longer asks.)
     */
    const headers = [
      // Identity + location (required)
      'BRANCH', 'BRANCH_NAME', 'DISTRICT', 'STATE', 'Branch Address', 'Packets',
      // Optional contact details
      'Pincode', 'Branch Manager', 'Branch Phone', 'Branch Email',
    ];

    // Prefill existing branches if any
    const projectBranches = await this.projectBranchRepository.find({
      where: { projectId, isActive: true },
      relations: ['branch'],
    });

    const rows: Record<string, any>[] = projectBranches.map((pb) => ({
      BRANCH: pb.branch.solId,
      BRANCH_NAME: pb.branch.name,
      DISTRICT: pb.branch.district,
      STATE: pb.branch.state,
      'Branch Address': pb.branch.address || '',
      Packets: pb.packetCount ?? '',
      Pincode: pb.branch.pincode || '',
      'Branch Manager': pb.branch.managerName || '',
      'Branch Phone': pb.branch.phone || '',
      'Branch Email': pb.branch.email || '',
    }));

    if (rows.length === 0) {
      rows.push(Object.fromEntries(headers.map((h) => [h, ''])));
    }

    const ws = xlsx.utils.json_to_sheet(rows, { header: headers });
    ws['!cols'] = headers.map((h) => ({ wch: h === 'Branch Address' ? 55 : Math.max(14, h.length + 4) }));
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Branch');

    const instructions = [
      { Field: 'Worked out for you', Required: '', Description: 'You do not need to supply a location, a risk rating, a complexity, or audit hours. The branch is located from its address, risk follows the priority set on the project, and complexity and audit hours are calculated from Packets. Any of these can be adjusted afterwards on the Branches page if needed.' },
      { Field: 'BRANCH', Required: 'Yes', Description: 'The branch SOL ID from the client, e.g. 8 or 0751. Re-importing the same SOL ID updates that branch rather than creating a duplicate.' },
      { Field: 'BRANCH_NAME', Required: 'Yes', Description: 'Branch name, e.g. THENKURISSI.' },
      { Field: 'DISTRICT', Required: 'Yes', Description: 'District name — used to cluster nearby branches into one assayer-day and to compute travel.' },
      { Field: 'STATE', Required: 'Yes', Description: 'State name — used to apply state-specific public holidays when scheduling.' },
      { Field: 'Branch Address', Required: 'Yes', Description: 'Full address. The branch is located on the map from this; a 6-digit pincode inside the text is detected automatically. The more complete the address, the more precise the pin.' },
      { Field: 'Packets', Required: 'Yes', Description: 'Estimated packets to audit at this branch this cycle. This is the number that matters most: it sets how long the audit takes, how complex the branch is rated, how many branches one assayer can cover in a day, and the coverage figure quoted to the client. Left blank, the system assumes a flat 6 hours and the plan will be wrong.' },
      { Field: 'Pincode', Required: 'No', Description: '6-digit pincode. Leave blank if it already appears in the address.' },
      { Field: 'Branch Manager', Required: 'No', Description: 'Contact name at the branch, shown to the assayer before the visit.' },
      { Field: 'Branch Phone', Required: 'No', Description: 'Branch contact number, shown to the assayer before the visit.' },
      { Field: 'Branch Email', Required: 'No', Description: 'Branch email for correspondence.' },
    ];
    const instrWs = xlsx.utils.json_to_sheet(instructions, { header: ['Field', 'Required', 'Description'] });
    instrWs['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 110 }];
    xlsx.utils.book_append_sheet(wb, instrWs, 'Instructions');

    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  }

  /**
   * Parse a branch workbook and refuse the files that are not one.
   *
   * Lifted out of `uploadBranchesFromExcel` unchanged so that the synchronous endpoint and the
   * request that *enqueues* a background import reject a bad file identically, and in the
   * request. A wrong template or an empty sheet has to fail while the operator is still looking
   * at the upload dialog — learning it from a job record several minutes later, after the file
   * has been accepted with a 202, is precisely the regression queueing could introduce.
   */
  private parseBranchSheet(fileBuffer: Buffer): ParsedSheet {
    // Finds the header row rather than assuming row 1 — client branch lists routinely open with
    // a merged title and a blank line, which otherwise makes every column `__EMPTY` and drops
    // the whole file. See core/excel/sheet-reader.
    const sheet = parseSheet(fileBuffer, ['BRANCH', 'BRANCH_NAME', 'STATE']);

    if (sheet.rows.length === 0) {
      throw new BadRequestException(
        `The first sheet of this file ("${sheet.sheetName ?? 'none'}") has no data rows. ` +
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

    return sheet;
  }

  /**
   * Validate an upload and measure how much work it is, without doing any of it.
   *
   * The routing decision between "run it now" and "queue it" is made from this, so it must be
   * cheap and must not touch the network: it parses the workbook (milliseconds, even for
   * thousands of rows) and counts the rows that will each cost a rate-limited geocode.
   */
  async preflightBranchExcel(projectId: string, fileBuffer: Buffer): Promise<BranchImportPreflight> {
    // Settled in the request, so an upload against a project that does not exist still 404s
    // immediately rather than being accepted and failing inside a job nobody is watching.
    const project = await this.findOne(projectId);
    const sheet = this.parseBranchSheet(fileBuffer);

    /**
     * A row already in the database does not cost a geocode, and the estimate has to know that.
     *
     * This counted "rows with no Latitude/Longitude column" — which was a fair proxy while the
     * template still asked for coordinates. It no longer does (they are derived), so every row
     * looked like a lookup and every file over 25 rows was deferred to a background job. Measured
     * on a real re-import of 72 unchanged branches: preflight said "72 need a location looked up",
     * the job ran zero geocodes and finished in **one second** — after telling the operator to go
     * and watch a status URL.
     *
     * What actually costs a lookup is a branch this client has never seen, or one whose address
     * moved: `BranchService.update` re-resolves only when the address, district or state changes
     * (a hand-placed pin survives even then). So the estimate asks the same question the importer
     * will, with the same one `In(codes)` query the importer already issues per file.
     */
    const candidates: Array<{ code: string; address: string; district: string; state: string; hasCoords: boolean }> = [];
    for (const row of sheet.rows) {
      const get = rowReader(row);
      // The same blank-trailing-row test the importer uses, so the estimate counts the rows that
      // will actually be worked rather than the empty ones Excel leaves at the bottom of a sheet.
      const name = get('BRANCH_NAME', 'Branch Name', 'BranchName', 'Name');
      const solId = get('SOL ID', 'SolId', 'SOL_ID', 'Sol', 'SOL', 'BRANCH', 'Branch Code', 'BranchCode', 'BrCode', 'Code');
      if (!name && !solId) continue;
      const lat = parseFloat(get('Latitude', 'Lat'));
      const lng = parseFloat(get('Longitude', 'Lng', 'Long'));
      candidates.push({
        code: solId,
        address: get('Branch Address', 'Address', 'BranchAddress'),
        district: get('DISTRICT', 'District', 'DistrictName').toUpperCase(),
        state: get('STATE', 'State', 'StateName'),
        // A sheet that still carries coordinates skips the lookup entirely — see the importer.
        hasCoords: Number.isFinite(lat) && Number.isFinite(lng),
      });
    }

    const sols = candidates.map((c) => c.code).filter(Boolean);
    const known = sols.length
      ? await this.branchRepository.find({
          where: {
            solId: In(sols),
            isActive: true,
            ...(project.clientId ? { clientId: project.clientId } : {}),
          },
          select: ['solId', 'address', 'district', 'state'],
        })
      : [];
    const knownBySol = new Map(known.map((b) => [b.solId, b]));

    let rowsNeedingGeocode = 0;
    for (const c of candidates) {
      if (c.hasCoords) continue;
      const existing = knownBySol.get(c.code);
      if (!existing) {
        rowsNeedingGeocode++; // A new branch: always located from its address.
        continue;
      }
      // Mirrors the patch the importer builds, and `BranchService.update`'s re-resolve test.
      const moved =
        (!!c.address && c.address !== existing.address) ||
        (!!c.district && c.district !== existing.district) ||
        (!!c.state && c.state !== existing.state);
      if (moved) rowsNeedingGeocode++;
    }

    return { totalRows: sheet.rows.length, rowsNeedingGeocode, sheetName: sheet.sheetName };
  }

  /**
   * @param onProgress Called as rows are worked, so a queued import can publish how far it has
   *   got. Absent on the synchronous path, where nothing can observe it mid-flight.
   */
  async uploadBranchesFromExcel(
    projectId: string,
    fileBuffer: Buffer,
    userId: string,
    onProgress?: (progress: BranchImportProgress) => void,
  ): Promise<BranchUploadReport> {
    const project = await this.findOne(projectId);

    // Read client planning preferences for hours-per-packet rate
    const client = project.clientId
      ? await this.clientRepository.findOne({ where: { id: project.clientId } })
      : null;
    const planningPrefs = client?.planningPreferences || {};
    const minutesPerPacket = Number(planningPrefs.minutesPerPacket) || 15; // default 15min per packet

    const sheet = this.parseBranchSheet(fileBuffer);
    const rows = sheet.rows;

    const addedBranches: ProjectBranchEntity[] = [];
    /**
     * Rows the importer could not use, and why.
     *
     * These were `continue` with no record kept. A file whose header row says `Branch` instead
     * of `BRANCH_NAME` dropped every single row, and the endpoint still returned 200 with the
     * project's existing branch list — so the operator was told the upload succeeded while
     * nothing had been imported. Anything skipped is now named, with its spreadsheet row number.
     */
    const skipped: { row: number; solId?: string; reason: string }[] = [];
    let createdCount = 0;
    let updatedCount = 0;
    /**
     * Which row first used each SOL ID, so a repeat inside one file can be named.
     *
     * The loop upserts by `solId`, so a sheet listing the same SOL ID twice silently applied the
     * later row over the earlier one — and because the two rows rarely agree on every column, what
     * survived was a mixture of both: one row's name and address on top of the other's contact and
     * risk data. The counts said "created 6, updated 1", which reads as an ordinary refresh of a
     * pre-existing branch rather than "two of your rows collided".
     */
    const firstRowForSol = new Map<string, number>();
    /**
     * Rows that imported but landed on a fallback coordinate — a warning list, not a skip list.
     * Kept separate from `skipped` because these branches DID import; they simply cannot be
     * planned or checked into until someone corrects where they are.
     */
    const imprecise: { row: number; solId?: string; reason: string }[] = [];
    // The branch ids behind `imprecise`, handed to the precision worker when the import is done.
    const impreciseBranchIds: string[] = [];

    /**
     * ## Why this is two passes rather than one
     *
     * Everything below the sheet — reading a cell, checking a pincode, canonicalising a region —
     * is pure. Everything that touches the database or the network is not. The original loop
     * interleaved them, which meant every read it needed was issued one row at a time: a
     * `findOneByCode`, a `project_branches` lookup, an `assessments` lookup and two zone queries
     * per row, so a 2,000-branch file spent 10,000 round trips answering questions that four
     * queries answer for the whole file. The reads that do not depend on the row's own result are
     * now hoisted between the passes and served from memory.
     *
     * Pass 1 also gives the queued path something the old shape could not: the full set of rows
     * worth working is known before the first write, so progress can be reported against a real
     * denominator instead of "rows in the sheet, some of which are blank".
     */
    interface PreparedRow {
      rowNumber: number;
      /** The remaining columns, read lazily in pass 2 — see rowReader for the alias handling. */
      get: RowReader;
      branchName: string;
      solId: string;
      district: string;
      state: string;
      address: string;
      pincodeStr: string;
      packetCount: number;
      calculatedHours: number | null;
      suppliedCoords: { lat: number; lng: number; geoSource: string; geoAccuracyMeters: number; geoMatchedName: string | null } | null;
      region: string | null;
    }
    const prepared: PreparedRow[] = [];

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      // The header row itself, plus however many rows preceded it.
      const rowNumber = index + sheet.headerRow + 1;
      const get = rowReader(row);

      // Every column is read through the alias list rather than one exact header, so the
      // client's own export, our template, and a hand-edited copy of either all import.
      const branchName = get('BRANCH_NAME', 'Branch Name', 'BranchName', 'Name');
      // The SOL id is a branch's single identity, read from whichever column the bank used to name
      // it — "SOL ID", or the plain "BRANCH"/"Branch Code" that holds the same number. Keyed here
      // exactly as the Branches-page importer keys it, so a file uploaded through both doors matches
      // the same record instead of inserting a second copy.
      const solId = get('SOL ID', 'SolId', 'SOL_ID', 'Sol', 'SOL', 'SOL NO', 'SolNo',
                        'BRANCH', 'Branch Code', 'BranchCode', 'BrCode', 'Code');
      if (!branchName && !solId) {
        // A wholly blank row — the trailing rows Excel leaves behind. Not worth reporting.
        continue;
      }
      if (!branchName) {
        skipped.push({ row: rowNumber, solId, reason: 'No branch name in this row.' });
        continue;
      }
      if (!solId) {
        skipped.push({ row: rowNumber, reason: `No SOL ID for "${branchName}".` });
        continue;
      }

      // Same SOL ID twice in one sheet: keep the first occurrence and name the collision, rather
      // than overwriting it with the later row and reporting the result as a routine "updated".
      const solKey = solId.trim().toUpperCase();
      const firstRow = firstRowForSol.get(solKey);
      if (firstRow !== undefined) {
        skipped.push({
          row: rowNumber,
          solId,
          reason: `Duplicate of row ${firstRow} (SOL ID ${solId}) — the first row was kept.`,
        });
        continue;
      }
      firstRowForSol.set(solKey, rowNumber);

      /**
       * One bad row must not cost the operator the other 399.
       *
       * Nothing here was guarded, so a single failure — a malformed cell, a number where a date
       * was expected — threw straight out of the endpoint as a 500 and the operator was shown a
       * crash with no way to tell how far it got. Each row now either lands or is reported by
       * number. Pass 2 carries the same guard for the failures only it can hit.
       */
      try {
        const district = get('DISTRICT', 'District', 'DistrictName').toUpperCase();
        const state = get('STATE', 'State', 'StateName');
        const address = get('Branch Address', 'Address', 'BranchAddress');
        const pincodeStr = get('Pincode', 'Pin', 'Pin Code', 'Postal Code', 'Zip');

        if (!state) {
          // State drives the region, the zone and the public-holiday calendar. A branch without
          // one is unplannable, so it is refused loudly rather than imported into limbo.
          skipped.push({ row: rowNumber, solId, reason: `No state for "${branchName}".` });
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
            solId,
            reason: `"${pincodeStr}" is not a valid pincode for "${branchName}" — expected 6 digits.`,
          });
          continue;
        }

        // Read packet count and calculate estimated duration
        const packetCount = parseInt(get('Packets', 'packet_count', 'Packet Count'), 10);
        const calculatedHours = !isNaN(packetCount) && packetCount > 0
          ? parseFloat(((packetCount * minutesPerPacket) / 60).toFixed(2))
          : null;

        // The template no longer asks for coordinates — a branch is located from its address —
        // but a pair that arrives anyway (a client's own export carrying their GPS survey, say)
        // is exact and is honoured over geocoding. This is the one derived field a sheet may
        // still override, because a real coordinate beats any lookup.
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

        prepared.push({
          rowNumber, get, branchName, solId, district, state, address, pincodeStr,
          packetCount, calculatedHours, suppliedCoords, region,
        });
      } catch (err: any) {
        skipped.push({
          row: rowNumber,
          solId,
          reason: err?.message || 'Unexpected error importing this row.',
        });
      }
    }

    /**
     * ## The reads hoisted out of the row loop
     *
     * Each of these used to run once per row. They are all answerable for the whole file up
     * front because none of them depends on what an earlier row did: a branch's existence is a
     * fact about the database before the import starts, and a branch created *by* this import
     * cannot also be matched by it — the duplicate-code guard above means each code appears once.
     */

    /**
     * Every branch this file might already know about, in one query instead of one per row.
     *
     * Scoped to this project's client, exactly as the per-row `findOneByCode` was. Branch codes
     * are the client's own numbering and collide across clients constantly — every bank has a
     * branch "1" — so an unscoped lookup attached another client's branch, with its address,
     * coordinates and region, to this project. Keyed on the code verbatim rather than a
     * normalised form, again matching what `findOneByCode` did: a sheet saying `br-1` against a
     * stored `BR-1` created a second branch before this change and must keep doing so, because
     * silently merging them here would be a behaviour change wearing a performance change's
     * clothes.
     */
    const sols = prepared.map((p) => p.solId).filter(Boolean);
    const clientScope = project.clientId ? { clientId: project.clientId } : {};
    // Existing branches this file might already know, found by SOL id — the branch's single
    // identity, per client. One query over the whole file, not one per row.
    const existingBySol = sols.length
      ? await this.branchRepository.find({
          where: { solId: In(sols), isActive: true, ...clientScope },
        })
      : [];
    const branchBySol = new Map(existingBySol.map((b) => [b.solId, b]));

    // Which branches this project already carries, and which already have an assessment. Both
    // were per-row `findOne`s whose answer is a single query over one project.
    const existingProjectBranches = await this.projectBranchRepository.find({
      where: { projectId: project.id, isActive: true },
    });
    const projectBranchByBranchId = new Map(existingProjectBranches.map((pb) => [pb.branchId, pb]));

    const existingAssessments = await this.assessmentRepository.find({
      where: { projectId: project.id, isActive: true },
      select: ['id', 'branchId'],
    });
    const branchIdsWithAssessment = new Set(existingAssessments.map((a) => a.branchId));

    /**
     * One zone resolution per distinct state, not per row.
     *
     * `resolveZoneName` loads every zone visible to the client and scans it, and
     * `findOrCreateZone` then issues its own lookup — so a 2,000-row file in four states ran
     * 4,000 zone queries to reach four answers. Memoised for the life of this import only, which
     * is short enough that a zone created concurrently elsewhere is not a concern the cache
     * introduces.
     */
    const zoneByState = new Map<string, ZoneEntity | null>();
    const resolveZoneForState = async (state: string): Promise<ZoneEntity | null> => {
      const key = state.toUpperCase();
      if (zoneByState.has(key)) return zoneByState.get(key) ?? null;
      const zoneName = await this.resolveZoneName(state, project.clientId);
      const zone = await this.branchService.findOrCreateZone(zoneName, project.clientId, [key]);
      zoneByState.set(key, zone ?? null);
      return zone ?? null;
    };

    /**
     * Progress is published on a throttle, not per row.
     *
     * Each publication is a Redis write; doing one per row would add a round trip to rows that
     * are otherwise pure database work, and nobody is watching a progress bar closely enough to
     * need every increment. Every 10 rows, plus a final one, keeps a long import visibly moving.
     */
    const publishProgress = (processed: number, force = false) => {
      if (!onProgress) return;
      if (!force && processed % 10 !== 0) return;
      onProgress({
        processed,
        total: prepared.length,
        created: createdCount,
        updated: updatedCount,
        linked: addedBranches.length,
        skipped: skipped.length,
        imprecise: imprecise.length,
      });
    };

    /**
     * Every branch in this file inherits the project's priority as its risk category. Resolved
     * once, here, because it is a property of the project and not of any row — and normalised so
     * an enum value and a stray lowercase string from an older record land on the same answer.
     */
    const derivedRiskCategory = String(project.priority || 'MEDIUM').toUpperCase();

    // ---- Pass 2: the writes, and the geocoding that makes this slow ------------------------
    for (let position = 0; position < prepared.length; position++) {
      const {
        rowNumber, get, branchName, solId, district, state, address, pincodeStr,
        packetCount, calculatedHours, suppliedCoords, region,
      } = prepared[position];

      /**
       * One bad row must not cost the operator the other 399.
       *
       * A geography check that cannot verify a district, a geocoder timeout, a constraint
       * violation — any of these threw straight out of the endpoint as a 500. Rows already
       * imported stayed in the database, the rest never ran, and the operator was shown a crash
       * with no way to tell how far it got. Each row now either lands or is reported by number.
       */
      try {
        // Matched by SOL id — the branch's single identity, per client — exactly as the
        // Branches-page importer matches it.
        let branch = branchBySol.get(solId) ?? null;
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
          const landedCoarse = needsBetterFix(coords.geoSource, coords.geoAccuracyMeters);
          if (landedCoarse) {
            const km = Math.round(coords.geoAccuracyMeters / 1000);
            imprecise.push({
              row: rowNumber,
              solId,
              // Honest about the placement AND about what happens next. The import takes the
              // fast tiers on purpose (see geocodeIndiaRobust); the precise lookup is queued the
              // moment this import finishes and usually lands within minutes. The operator is
              // not being asked to do anything — only told where the pin stands right now.
              reason:
                coords.geoSource === 'none'
                  ? `"${branchName}" could not be located from its address yet — placed on a fallback point for now; a precise lookup is queued and runs in the background.`
                  : `"${branchName}" placed to about ${km} km for now (${coords.geoSource}); a precise lookup is queued and runs in the background.`,
            });
          }

          // Memoised per state for the life of this import — see resolveZoneForState.
          const zone = await resolveZoneForState(state);

          const pincode = pincodeStr || address.match(/\b\d{6}\b/)?.[0] || null;
          const branchType = ['BANGALORE', 'CHENNAI', 'PUNE', 'NOIDA'].includes(district) ? 'METRO' : 'URBAN';
          // Was a random name from a hardcoded list and a random phone number, which
          // put fabricated contact details in front of an assayer about to visit the
          // branch. Use what the client supplied; leave blank when they supplied nothing.
          const managerName = get('Branch Manager', 'Manager', 'Manager Name') || null;
          const phone = get('Branch Phone', 'Phone', 'Contact Number') || null;

          branch = await this.branchService.registerImportedBranch({
            solId,
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
            /**
             * Derived, never read from the sheet.
             *
             * Risk Category / Risk Score / Complexity / Estimated Hours used to be optional
             * columns. In practice the sheet never carried them, so every branch fell through to
             * the same flat defaults — LOW, 2.0, STANDARD — and the one rule that reads risk
             * (the planner sends a senior assayer to a branch scoring >= 7) could never fire for
             * anybody. And when a sheet *did* carry a value, it was whatever someone typed once,
             * with nothing checking it.
             *
             * Risk is the project's priority: the person who created the project already made
             * that call, on the same LOW/MEDIUM/HIGH/CRITICAL scale, and it is the one place the
             * stakes of this engagement are actually stated. Complexity is read off Packets, the
             * only workload figure the sheet has. Hours were already Packets-derived. The
             * operator can still adjust any of these per branch on the Branches page — that is
             * the override path, not a column in a bulk upload.
             */
            riskCategory: derivedRiskCategory,
            riskScore: riskScoreFromCategory(derivedRiskCategory),
            complexity: complexityFromPackets(Number.isFinite(packetCount) ? packetCount : null),
            estimatedDurationHours: calculatedHours || 6.0,
            createdBy: userId,
            updatedBy: userId,
          }, userId);
          createdCount++;
          if (landedCoarse && branch?.id) impreciseBranchIds.push(branch.id);
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
          /**
           * The packet-derived fields follow the packets. Hours already did; complexity now does
           * too, because both are read off the same number and that number changes every cycle.
           *
           * Risk is deliberately NOT re-derived here. It lives on the branch, which is shared
           * across every project that audits it, and an operator may have escalated it by hand
           * on the Branches page — a later re-import must not quietly reset that to whatever
           * this project's priority happens to be. It is set once, at creation.
           */
          if (calculatedHours !== null) {
            // Compared, not assigned blindly. This wrote the hours on every re-import whether or
            // not they had changed, so `patch` was never empty: an identical sheet re-imported
            // 72 branches, wrote 72 rows, raised 72 audit events, and reported "updated: 72"
            // when nothing had actually changed. Complexity was already compared; hours now are
            // too, so an unchanged re-import touches nothing and says so.
            if (Number(branch.estimatedDurationHours) !== calculatedHours) {
              patch.estimatedDurationHours = calculatedHours;
            }
            const derivedComplexity = complexityFromPackets(packetCount);
            if (branch.complexity !== derivedComplexity) patch.complexity = derivedComplexity;
          }

          if (Object.keys(patch).length > 0) {
            branch = await this.branchService.update(branch.id, patch, userId);
            updatedCount++;
          }
        }

        // Served from the maps loaded before the loop rather than a query per row. A branch this
        // import just created cannot be in either map, which is the correct answer for it.
        const pb = projectBranchByBranchId.get(branch.id) ?? null;

        if (!pb) {
          const created = this.projectBranchRepository.create({
            projectId: project.id,
            branchId: branch.id,
            zoneId: branch.zoneId,
            status: ProjectBranchStatus.IMPORTED,
            packetCount: !isNaN(packetCount) && packetCount > 0 ? packetCount : null,
            // Inherits the project's priority rather than the column default (MEDIUM for
            // everything). Assignments take theirs from this row (assignment.service), so
            // project → branch → assignment is now one line of truth instead of a HIGH project
            // dispatching MEDIUM work.
            priority: project.priority,
            createdBy: userId,
            updatedBy: userId,
          });
          const savedPb = await this.projectBranchRepository.save(created);
          addedBranches.push(savedPb);
          // Recorded so that a file listing the same branch under two different codes cannot
          // create two links to it — the per-row `findOne` this replaces would have seen the
          // first one, so dropping the write-back here would be a regression, not a speed-up.
          projectBranchByBranchId.set(branch.id, savedPb);

          if (!branchIdsWithAssessment.has(branch.id)) {
            const asmt = this.assessmentRepository.create({
              projectId: project.id,
              branchId: branch.id,
              createdBy: userId,
              updatedBy: userId,
            });
            await this.assessmentRepository.save(asmt);
            branchIdsWithAssessment.add(branch.id);
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
          solId,
          reason: err?.message || 'Unexpected error importing this row.',
        });
      }

      publishProgress(position + 1);
    }

    // Forced, so the last partial batch of rows is always reflected before the job completes —
    // otherwise an import of 2,004 rows would sit at 2,000 in the UI until the result appeared.
    publishProgress(prepared.length, true);

    /**
     * Hand the coarsely placed rows to the precision worker now, not "whenever the nightly sweep
     * gets to them". The import deliberately took the fast geocoding tiers to stay out of the
     * request path (district centroid ~15 km, state centroid ~100 km — measured on a real client
     * file: 62 of 72 at 15 km, 10 on the state centroid). Those are placeholders, and the
     * geocoder's own contract is that the backfill upgrades them afterwards. This is the
     * "afterwards". Fire-and-forget: a Redis hiccup must not fail an import that has already
     * landed, and the nightly sweep selects by precision, so nothing is lost if the enqueue is.
     */
    void this.geoPrecision.enqueueBackfill('branch', impreciseBranchIds, `import into project ${project.id}`);

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

  /**
   * The same import, minus the branch list.
   *
   * What the queue worker calls. See `BranchUploadReport` for why the entity list must not travel
   * into a job's return value.
   */
  async runBranchImport(
    projectId: string,
    fileBuffer: Buffer,
    userId: string,
    onProgress?: (progress: BranchImportProgress) => void,
  ): Promise<BranchImportOutcome> {
    const { branches: _branches, ...outcome } = await this.uploadBranchesFromExcel(
      projectId, fileBuffer, userId, onProgress,
    );
    return outcome;
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

  async startProjectPlanning(id: string, userId: string, role = SystemRole.ADMIN): Promise<ProjectEntity> {
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
      [SystemRole.ADMIN, SystemRole.OPERATIONS],
      async () => {
        const event = ProjectStateMachine.startPlanning(project, userId);
        const saved = await this.projectRepository.save(project);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
      }
    );
  }

  async readyProjectForScheduling(id: string, userId: string, role = SystemRole.ADMIN): Promise<ProjectEntity> {
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
      [SystemRole.ADMIN, SystemRole.OPERATIONS],
      async () => {
        const event = ProjectStateMachine.readyForScheduling(project, userId);
        const saved = await this.projectRepository.save(project);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
      }
    );
  }

  async startProjectExecution(id: string, userId: string, role = SystemRole.ADMIN): Promise<ProjectEntity> {
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
      [SystemRole.ADMIN, SystemRole.OPERATIONS],
      async () => {
        const event = ProjectStateMachine.startExecution(project, userId);
        const saved = await this.projectRepository.save(project);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
      }
    );
  }

  async startProjectValidation(id: string, userId: string, role = SystemRole.ADMIN): Promise<ProjectEntity> {
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
      [SystemRole.ADMIN, SystemRole.OPERATIONS],
      async () => {
        const event = ProjectStateMachine.startValidation(project, userId);
        const saved = await this.projectRepository.save(project);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
      }
    );
  }

  async completeProject(id: string, userId: string, role = SystemRole.ADMIN): Promise<ProjectEntity> {
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
      [SystemRole.ADMIN, SystemRole.OPERATIONS],
      async () => {
        const event = ProjectStateMachine.completeProject(project, userId);
        const saved = await this.projectRepository.save(project);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
      }
    );
  }

  async cancelProject(id: string, userId: string, role = SystemRole.ADMIN): Promise<ProjectEntity> {
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
      [SystemRole.ADMIN, SystemRole.OPERATIONS],
      async () => {
        const event = ProjectStateMachine.cancelProject(project, userId);
        const saved = await this.projectRepository.save(project);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
      }
    );
  }

  async holdProject(id: string, userId: string, role = SystemRole.ADMIN): Promise<ProjectEntity> {
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
      [SystemRole.ADMIN, SystemRole.OPERATIONS],
      async () => {
        const event = ProjectStateMachine.holdProject(project, userId);
        const saved = await this.projectRepository.save(project);
        this.eventPublisher.publish(event.constructor.name, event);
        return saved;
      }
    );
  }

  async archiveProject(id: string, userId: string, role = SystemRole.ADMIN): Promise<ProjectEntity> {
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
      [SystemRole.ADMIN, SystemRole.OPERATIONS],
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
      solId: pb.branch?.solId ?? null,
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
    /**
     * A branch cannot be declared unstaffable while somebody still holds work on it. The old
     * behaviour left a live PENDING offer (or an ACCEPTED job) running underneath the
     * declaration; the assayer could then accept an hour later and flip the branch straight to
     * ASSIGNMENT_CONFIRMED — silently undoing a coverage failure that was already reported
     * against the client SLA, with no event saying so. Cancel or resolve the open assignment
     * first, with the same stated reason, and the record stays coherent.
     */
    const assignmentRepo = manager
      ? manager.getRepository(AssignmentEntity)
      : this.projectBranchRepository.manager.getRepository(AssignmentEntity);
    const openAssignment = await assignmentRepo.findOne({
      where: {
        projectBranchId: pb.id,
        isActive: true,
        status: In([
          AssignmentStatus.PENDING,
          AssignmentStatus.ACCEPTED,
          AssignmentStatus.CHECKED_IN,
          AssignmentStatus.IN_PROGRESS,
        ]),
      },
    }).catch(() => null);
    if (openAssignment) {
      throw new ConflictException(
        `${openAssignment.assignmentNumber} is still ${openAssignment.status.toLowerCase()} on this branch. `
        + `Cancel or complete it first — a branch with someone holding its work is not uncoverable.`,
      );
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
