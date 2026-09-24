/**
 * FAPOMS — Project Service
 *
 * Handles CRUD and lifecycle state transitions for projects and project branches (Part 3 Module 2, Part 5 §3).
 */

import { AssignmentRefreshPushService } from '../notifications/assignment-refresh-push.service';
import { Injectable, NotFoundException, BadRequestException, ConflictException, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, In, DataSource, EntityManager } from 'typeorm';

import { ProjectEntity } from './project.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { AssessmentEntity } from './assessment.entity';
import { ProjectStateMachine, ProjectBranchStateMachine } from './project.state-machine';
import { ProjectQueryService } from './project-query.service';
import { BranchQueryService } from '../branch/branch-query.service';
import { AuditService } from '../../core/audit/audit.service';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { AssignmentStatus, EventCategory, ProjectStatus, ProjectBranchStatus, SystemRole, PROJECT_TRANSITIONS, toWorkflowTransitions } from '@fapoms/shared';
import { GlobalScope } from '../../infrastructure/scope/global-scope';
import { buildWorkbook } from '../reports/excel-export';
import { AssayerService } from '../assayer/assayer.service';
import { cancelOpenAssignmentsForClosure, ClosureCancelledAssignment } from '../assignment/closure-cancellation';
import { DayTravelService } from '../assignment/assignment-day-travel';
import { ASSIGNED_ASSIGNMENT_STATUSES, sqlStatusList } from '../assignment/assignment-workload';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { AssignmentEntity } from '../assignment/assignment.entity';

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


@Injectable()
export class ProjectService implements OnModuleInit {
  constructor(
     @InjectRepository(ProjectEntity)
     private readonly projectRepository: Repository<ProjectEntity>,
      @InjectRepository(ProjectBranchEntity)
      private readonly projectBranchRepository: Repository<ProjectBranchEntity>,
      @InjectRepository(AssessmentEntity)
      private readonly assessmentRepository: Repository<AssessmentEntity>,
      private readonly branchQueryService: BranchQueryService,
      private readonly auditService: AuditService,
      private readonly workflowEngine: WorkflowEngine,
      private readonly eventPublisher: DomainEventPublisher,
      private readonly projectQueryService: ProjectQueryService,
      private readonly notificationDispatch: NotificationDispatchService,
      @InjectDataSource()
      private readonly dataSource: DataSource,
      /** The silent "your jobs changed" push, for work a project cancellation cancels. */
      @Optional() private readonly refreshPush?: AssignmentRefreshPushService,
      /** Turning location sharing off for an assayer whose last job a cancellation ended. */
      @Optional() private readonly assayerService?: AssayerService,
      /** Re-deciding the day's travel when a cancelled job was the one carrying it (E2). */
      @Optional() private readonly dayTravel?: DayTravelService,
   ) {}

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

    // The (assayer, day) pairs whose live work this removal takes away — read before it goes, so
    // each day's travel can be re-decided afterwards (travel once per assayer per day, E2).
    const liveDays: Array<{ assayer_id: string | null; scheduled_date: string | Date | null }> = await this.dataSource.query(
      `SELECT DISTINCT assayer_id, scheduled_date FROM assignments
        WHERE project_id = $1 AND is_active = true
          AND status IN (${sqlStatusList(ASSIGNED_ASSIGNMENT_STATUSES)})`,
      [id],
    ).catch(() => []);

    // Deactivate associated assignments
    await this.dataSource.query(
      `UPDATE assignments SET is_active = false, updated_by = $1,
          entity_version = COALESCE(entity_version, 1) + 1, updated_at = NOW()
        WHERE project_id = $2 AND is_active = true`,
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

    // The removed jobs may have carried their day's travel; each affected day is re-decided.
    await this.dayTravel?.rebalanceMany(
      (Array.isArray(liveDays) ? liveDays : []).map((r) => ({ assayerId: r.assayer_id, day: r.scheduled_date })),
      userId,
      `project ${project.name} was removed`,
    );
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
    // Called for its check, not its value: findOne throws NotFoundException, so this is what
    // stops the endpoint handing back a valid-looking template for a project that does not exist.
    await this.findOne(projectId);
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

    // One row per header, in header order — buildWorkbook takes positional arrays, not the
    // keyed-by-header objects json_to_sheet took; it also supplies the "still show the columns
    // when there is no data yet" blank row itself, the same fix this file used to apply by hand.
    const rows: Array<Array<unknown>> = projectBranches.map((pb) => {
      const byHeader: Record<string, unknown> = {
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
      };
      return headers.map((h) => byHeader[h]);
    });

    const instructions: Array<[string, string, string]> = [
      ['Worked out for you', '', 'You do not need to supply a location, a risk rating, a complexity, or audit hours. The branch is located from its address, risk follows the priority set on the project, and complexity and audit hours are calculated from Packets. Any of these can be adjusted afterwards on the Branches page if needed.'],
      ['BRANCH', 'Yes', 'The branch SOL ID from the client, e.g. 8 or 0751. Re-importing the same SOL ID updates that branch rather than creating a duplicate.'],
      ['BRANCH_NAME', 'Yes', 'Branch name, e.g. THENKURISSI.'],
      ['DISTRICT', 'Yes', 'District name — used to cluster nearby branches into one assayer-day and to compute travel.'],
      ['STATE', 'Yes', 'State name — used to apply state-specific public holidays when scheduling.'],
      ['Branch Address', 'Yes', 'Full address. The branch is located on the map from this; a 6-digit pincode inside the text is detected automatically. The more complete the address, the more precise the pin.'],
      ['Packets', 'Yes', 'Estimated packets to audit at this branch this cycle. This is the number that matters most: it sets how long the audit takes, how complex the branch is rated, how many branches one assayer can cover in a day, and the coverage figure quoted to the client. Left blank, the system assumes a flat 6 hours and the plan will be wrong.'],
      ['Pincode', 'No', '6-digit pincode. Leave blank if it already appears in the address.'],
      ['Branch Manager', 'No', 'Contact name at the branch, shown to the assayer before the visit.'],
      ['Branch Phone', 'No', 'Branch contact number, shown to the assayer before the visit.'],
      ['Branch Email', 'No', 'Branch email for correspondence.'],
    ];

    return buildWorkbook([
      {
        name: 'Branch',
        headers,
        rows,
        columnWidths: headers.map((h) => (h === 'Branch Address' ? 55 : Math.max(14, h.length + 4))),
      },
      {
        name: 'Instructions',
        headers: ['Field', 'Required', 'Description'],
        rows: instructions,
        columnWidths: [18, 10, 110],
      },
    ]);
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
    let cancelled: ClosureCancelledAssignment[] = [];
    let projectEvent: { constructor: { name: string } } | null = null;
    const result = await this.workflowEngine.executeCommand(
      'project',
      project.id,
      'CancelProjectCommand',
      prev,
      next,
      userId,
      role,
      [SystemRole.ADMIN, SystemRole.OPERATIONS],
      async (manager?: EntityManager) => {
        if (!manager) {
          // The engine always supplies its transaction; without one this would be the very
          // outside-the-transaction write this method was fixed to stop doing.
          throw new Error('CancelProjectCommand must run on the workflow transaction.');
        }
        /**
         * On the command's own transaction — the `manager` the workflow engine hands the action,
         * which also carries the history and audit rows. This block used to say "transactionally"
         * while every UPDATE went through `this.dataSource.query`, i.e. a separate connection that
         * committed row by row whatever happened to the command. The open work is locked, the
         * on-site refusal decided on the locked rows (it used to be read, unlocked, before the
         * command started), and only rows still PENDING/ACCEPTED are cancelled, with their
         * calendar entries retired. See `cancelOpenAssignmentsForClosure`.
         */
        cancelled = await cancelOpenAssignmentsForClosure(manager, {
          scope: { projectId: project.id },
          userId,
          cancelReason: 'Project cancelled by operations',
          auditRemarks: `Auto-cancelled due to cancellation of project ${project.name}`,
          onSiteRefusal: (a) => new ConflictException(
            `Cannot cancel project "${project.name}": Assignment ${a.assignmentNumber} is currently ${a.status}. Field audit is actively in progress on site. Operational intervention required before cancelling this project.`,
          ),
          auditService: this.auditService,
        });

        projectEvent = ProjectStateMachine.cancelProject(project, userId);
        return manager.getRepository(ProjectEntity).save(project);
      }
    );
    // Published once the engine's transaction has committed, not from inside it.
    const committedEvent = projectEvent as { constructor: { name: string } } | null;
    if (committedEvent) this.eventPublisher.publish(committedEvent.constructor.name, committedEvent as any);

    // Committed. Tell the people whose work this stopped — never about a rolled-back cancel.
    for (const a of cancelled) {
      // Owner decision 2026-09-24: the assayer holding this job is told, in words, and their
      // phone refreshes.
      if (a.assayerId) {
        this.notificationDispatch.emitSafe({
          type: 'ASSIGNMENT_CANCELLED_BY_CLOSURE',
          entityType: 'ASSIGNMENT',
          entityId: a.id,
          actorUserId: userId,
          assayerId: a.assayerId,
          dedupeKey: `ASSIGNMENT_CANCELLED_BY_CLOSURE:${a.id}:${a.entityVersion}`,
          payload: {
            assignmentId: a.id,
            assignmentNumber: a.assignmentNumber,
            branchName: a.branchName ?? 'the branch',
            because: 'the office has stopped this audit project',
          },
        });
        this.refreshPush?.assignmentChanged(a.assayerId, a.id);
      }
      this.eventPublisher.publish('assignment:status-changed', {
        eventType: 'assignment:status-changed',
        assignmentId: a.id,
        assignmentNumber: a.assignmentNumber,
        previousState: a.previousStatus,
        newState: AssignmentStatus.CANCELLED,
        userId,
      });
    }
    // Sharing ends with an assayer's last committed job, as it does for a single cancel.
    for (const assayerId of new Set(cancelled.map((a) => a.assayerId).filter((x): x is string => !!x))) {
      await this.assayerService?.disableLiveTrackingWhenWorkEnds(assayerId, userId);
    }
    // Travel once per assayer per day (E2): a cancelled job may have carried its day's journey;
    // the next job that assayer has that day (on another project) takes it over. Never throws.
    await this.dayTravel?.rebalanceMany(
      cancelled.map((a) => ({ assayerId: a.assayerId, day: a.scheduledDate })),
      userId,
      `project ${project.name} was cancelled`,
    );
    return result;
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
