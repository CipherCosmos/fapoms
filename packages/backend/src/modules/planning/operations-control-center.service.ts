import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { OperationsTaskEntity, OperationsTaskStatus, OperationsTaskPriority } from './operations-task.entity';
import { OperationsExceptionEntity, OperationsExceptionCategory, OperationsExceptionStatus } from './operations-exception.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AssignmentStatus } from '@fapoms/shared';
import { ProjectMetricsProvider } from './operations-providers.interface';

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
  ) {}

  async getDashboardSummary(): Promise<ControlCenterDashboardData> {
    const totalProjects = await this.metricsProvider.getTotalProjectsCount();
    const activeProjectsCount = await this.metricsProvider.getActiveProjectsCount();

    const assignments = await this.assignmentRepository.find({ where: { isActive: true } });
    const branchCounts = await this.metricsProvider.getProjectBranchCounts();

    // Deployment tracking calculation
    const totalPBs = branchCounts.total;
    const deployedPBs = branchCounts.deployed;
    const deploymentPercentage = totalPBs > 0 ? parseFloat(((deployedPBs / totalPBs) * 100).toFixed(1)) : 0;

    const acceptedCount = assignments.filter((a) => a.status === AssignmentStatus.ACCEPTED || a.status === AssignmentStatus.SCHEDULED).length;
    const totalAssignments = assignments.length;
    const acceptancePercentage = totalAssignments > 0 ? parseFloat(((acceptedCount / totalAssignments) * 100).toFixed(1)) : 0;

    const pendingAssignmentsCount = assignments.filter((a) => a.status === AssignmentStatus.CREATED || a.status === AssignmentStatus.CONTACT_INITIATED).length;
    const delayedCount = assignments.filter((a) => a.slaStatus === 'BREACHED').length;

    const openTasks = await this.taskRepository.find({ where: { status: OperationsTaskStatus.OPEN } });
    const criticalTasksCount = openTasks.filter((t) => t.priority === OperationsTaskPriority.CRITICAL || t.priority === OperationsTaskPriority.HIGH).length;

    // Risks evaluation
    const breachedCounts: Record<string, number> = {};
    for (const a of assignments) {
      if (a.slaStatus === 'BREACHED') {
        breachedCounts[a.projectId] = (breachedCounts[a.projectId] || 0) + 1;
      }
    }
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
  async createOperationsTask(projectId: string, title: string, reason: string, priority: OperationsTaskPriority): Promise<OperationsTaskEntity> {
    const task = this.taskRepository.create({
      projectId,
      title,
      reason,
      priority,
      status: OperationsTaskStatus.OPEN,
    });
    return this.taskRepository.save(task);
  }

  /**
   * Resolves a task with audit justification logs.
   */
  async resolveOperationsTask(taskId: string, justification: string): Promise<OperationsTaskEntity> {
    const task = await this.taskRepository.findOne({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException(`Operations task ${taskId} not found.`);
    }

    task.status = OperationsTaskStatus.RESOLVED;
    task.resolutionJustification = justification;
    return this.taskRepository.save(task);
  }

  /**
   * Registers a managed business exception.
   */
  async flagException(projectId: string, category: OperationsExceptionCategory, message: string, targetEntityId?: string): Promise<OperationsExceptionEntity> {
    const exc = this.exceptionRepository.create({
      projectId,
      category,
      message,
      targetEntityId: targetEntityId || null,
      status: OperationsExceptionStatus.UNRESOLVED,
    });
    return this.exceptionRepository.save(exc);
  }

  /**
   * Bypasses / Resolves an exception with justification metadata.
   */
  async resolveException(exceptionId: string, justification: string): Promise<OperationsExceptionEntity> {
    const exc = await this.exceptionRepository.findOne({ where: { id: exceptionId } });
    if (!exc) {
      throw new NotFoundException(`Exception ${exceptionId} not found.`);
    }

    exc.status = OperationsExceptionStatus.RESOLVED;
    exc.overrideJustification = justification;
    return this.exceptionRepository.save(exc);
  }
}
