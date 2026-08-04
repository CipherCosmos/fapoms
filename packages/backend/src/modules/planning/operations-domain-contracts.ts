export class TaskId {
  constructor(public readonly value: string) {
    if (!value) throw new Error('TaskId cannot be empty');
  }
}

import { Priority } from '@fapoms/shared';

export type TaskPriority = Priority;
export const TaskPriority = Priority;

export enum TaskStatus {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  RESOLVED = 'RESOLVED',
  DISMISSED = 'DISMISSED',
  BLOCKED = 'BLOCKED',
}

export interface OperationsTaskCreatedEvent {
  eventId: string;
  occurredAt: string;
  aggregateId: string;
  aggregateVersion: number;
  taskId: string;
  projectId: string;
  priority: TaskPriority;
  createdBy: string;
  correlationId: string;
  causationId: string;
}

export interface WorkAllocation {
  allocationId: string;
  assayerId: string;
  agreedFee: number;
  status: string;
}

export interface WorkAssignmentCoordinator {
  spawnAssignmentsForApprovedPlan(planId: string, allocations: WorkAllocation[]): Promise<void>;
}

export interface ResourceAllocationProvider {
  getAvailableAssayerCapacity(assayerId: string): Promise<number>;
}

export interface OperationsControlServiceInterface {
  createTask(projectId: string, title: string, reason: string, priority: TaskPriority): Promise<any>;
  resolveTask(taskId: string, justification: string): Promise<any>;
}
