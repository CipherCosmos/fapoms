import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { OperationsTaskEntity, OperationsTaskStatus, OperationsTaskPriority } from './operations-task.entity';
import { OperationsExceptionEntity, OperationsExceptionCategory, OperationsExceptionStatus } from './operations-exception.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AssignmentStatus } from '@fapoms/shared';
import { ProjectMetricsProvider } from './operations-providers.interface';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory } from '@fapoms/shared';

export interface ControlCenterDashboardData {
  totalProjects: number;
  activeProjects: number;
  overallCoveragePercentage: number;
  overallDeploymentPercentage: number;
  assignmentAcceptancePercentage: number;
  pendingAssignmentsCount: number;
  delayedBranchesCount: number;
  criticalTasksCount: number;
  projectsAtRiskCount: number;
}

@Injectable()
export class OperationsControlCenterService {
  constructor(
    @InjectRepository(OperationsTaskEntity)
    private readonly taskRepository: Repository<OperationsTaskEntity>,
    @InjectRepository(OperationsExceptionEntity)
    private readonly exceptionRepository: Repository<OperationsExceptionEntity>,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    @Inject('ProjectMetricsProvider')
    private readonly metricsProvider: ProjectMetricsProvider,
    private readonly auditService: AuditService,
  ) {}

  async getDashboardSummary(): Promise<ControlCenterDashboardData> {
    const totalProjects = await this.metricsProvider.getTotalProjectsCount();
    const activeProjectsCount = await this.metricsProvider.getActiveProjectsCount();

    const branchCounts = await this.metricsProvider.getProjectBranchCounts();

    // Deployment tracking calculation
    const totalPBs = branchCounts.total;
    const deployedPBs = branchCounts.deployed;
    const deploymentPercentage = totalPBs > 0 ? parseFloat(((deployedPBs / totalPBs) * 100).toFixed(1)) : 0;

    // Aggregate in the database. This used to load every active assignment into memory just to count
    // it by status (`.filter().length`) — the whole active-assignment table pulled into Node on each
    // dashboard load. These are cheap counts that return a handful of numbers instead.
    const [totalAssignments, acceptedCount, pendingAssignmentsCount, delayedCount] = await Promise.all([
      this.assignmentRepository.count({ where: { isActive: true } }),
      this.assignmentRepository.count({ where: { isActive: true, status: AssignmentStatus.ACCEPTED } }),
      this.assignmentRepository.count({ where: { isActive: true, status: AssignmentStatus.PENDING } }),
      this.assignmentRepository.count({ where: { isActive: true, slaStatus: 'BREACHED' } }),
    ]);
    const acceptancePercentage = totalAssignments > 0 ? parseFloat(((acceptedCount / totalAssignments) * 100).toFixed(1)) : 0;

    const openTasks = await this.taskRepository.find({ where: { status: OperationsTaskStatus.OPEN } });
    const criticalTasksCount = openTasks.filter((t) => t.priority === OperationsTaskPriority.CRITICAL || t.priority === OperationsTaskPriority.HIGH).length;

    // SLA-breached assignments grouped by project, in one query rather than a JS reduce over the table.
    const breachedRows = await this.assignmentRepository
      .createQueryBuilder('a')
      .select('a.projectId', 'projectId')
      .addSelect('COUNT(*)', 'c')
      .where('a.isActive = :active AND a.slaStatus = :breached', { active: true, breached: 'BREACHED' })
      .groupBy('a.projectId')
      .getRawMany();
    const breachedCounts: Record<string, number> = Object.fromEntries(
      breachedRows.map((r) => [r.projectId, Number(r.c)]),
    );
    const projectsAtRiskCount = await this.metricsProvider.getProjectsAtRiskCount(breachedCounts);

    return {
      totalProjects,
      activeProjects: activeProjectsCount,
      overallCoveragePercentage: deploymentPercentage, // Mapped to deployment coverage
      overallDeploymentPercentage: deploymentPercentage,
      assignmentAcceptancePercentage: acceptancePercentage,
      pendingAssignmentsCount,
      delayedBranchesCount: delayedCount,
      criticalTasksCount,
      projectsAtRiskCount,
    };
  }

  /**
   * Generates a new operational task in the manager queue.
   */
  async createOperationsTask(projectId: string, title: string, reason: string, priority: OperationsTaskPriority, userId?: string): Promise<OperationsTaskEntity> {
    const task = this.taskRepository.create({
      projectId,
      title,
      reason,
      priority,
      status: OperationsTaskStatus.OPEN,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.taskRepository.save(task);

    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'OPERATIONS_TASK_CREATED',
      entityType: 'OPERATIONS_TASK',
      entityId: saved.id,
      newState: OperationsTaskStatus.OPEN,
      userId,
      remarks: `Raised ${priority} task "${title}".`,
      metadata: { projectId, title, reason, priority },
    });

    return saved;
  }

  /**
   * Resolves a task, recording who closed it and on what grounds. The justification was
   * already persisted on the row; what was missing was the trail entry naming the actor.
   */
  async resolveOperationsTask(taskId: string, justification: string, userId?: string): Promise<OperationsTaskEntity> {
    const task = await this.taskRepository.findOne({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException(`Operations task ${taskId} not found.`);
    }

    const previousStatus = task.status;
    task.status = OperationsTaskStatus.RESOLVED;
    task.resolutionJustification = justification;
    task.updatedBy = userId ?? task.updatedBy;
    const saved = await this.taskRepository.save(task);

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'OPERATIONS_TASK_RESOLVED',
      entityType: 'OPERATIONS_TASK',
      entityId: saved.id,
      previousState: previousStatus,
      newState: OperationsTaskStatus.RESOLVED,
      userId,
      remarks: `Resolved task "${saved.title}": ${justification}`,
      metadata: { projectId: saved.projectId, justification, priority: saved.priority },
    });

    return saved;
  }

  /**
   * Registers a managed business exception.
   */
  async flagException(projectId: string, category: OperationsExceptionCategory, message: string, targetEntityId?: string, userId?: string): Promise<OperationsExceptionEntity> {
    const exc = this.exceptionRepository.create({
      projectId,
      category,
      message,
      targetEntityId: targetEntityId || null,
      status: OperationsExceptionStatus.UNRESOLVED,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.exceptionRepository.save(exc);

    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'OPERATIONS_EXCEPTION_FLAGGED',
      entityType: 'OPERATIONS_EXCEPTION',
      entityId: saved.id,
      newState: OperationsExceptionStatus.UNRESOLVED,
      userId,
      remarks: `Flagged ${category} exception: ${message}`,
      metadata: { projectId, category, message, targetEntityId: targetEntityId || null },
    });

    return saved;
  }

  /**
   * Bypasses / resolves an exception with justification metadata.
   *
   * This is an override of a control the system raised deliberately, so the trail entry
   * matters more here than almost anywhere else in this file.
   */
  async resolveException(exceptionId: string, justification: string, userId?: string): Promise<OperationsExceptionEntity> {
    const exc = await this.exceptionRepository.findOne({ where: { id: exceptionId } });
    if (!exc) {
      throw new NotFoundException(`Exception ${exceptionId} not found.`);
    }

    const previousStatus = exc.status;
    exc.status = OperationsExceptionStatus.RESOLVED;
    exc.overrideJustification = justification;
    exc.updatedBy = userId ?? exc.updatedBy;
    const saved = await this.exceptionRepository.save(exc);

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'OPERATIONS_EXCEPTION_RESOLVED',
      entityType: 'OPERATIONS_EXCEPTION',
      entityId: saved.id,
      previousState: previousStatus,
      newState: OperationsExceptionStatus.RESOLVED,
      userId,
      remarks: `Overrode ${saved.category} exception: ${justification}`,
      metadata: { projectId: saved.projectId, category: saved.category, justification, targetEntityId: saved.targetEntityId },
    });

    return saved;
  }
}
