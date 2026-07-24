import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkflowHistoryEntity } from './workflow-history.entity';
import { AuditService } from '../../../core/audit/audit.service';
import { EventCategory } from '@fapoms/shared';

export interface WorkflowContext {
  userId: string;
  payload?: any;
  ruleContext?: any;
}

export interface TransitionDefinition {
  from: string[];
  to: string;
  guards?: ((context: WorkflowContext) => Promise<boolean>)[];
  beforeTransition?: (context: WorkflowContext) => Promise<void>;
  afterTransition?: (context: WorkflowContext) => Promise<void>;
}

@Injectable()
export class WorkflowEngine {
  private registries = new Map<string, TransitionDefinition[]>();

  constructor(
    private readonly auditService: AuditService,
    @InjectRepository(WorkflowHistoryEntity)
    private readonly historyRepository: Repository<WorkflowHistoryEntity>,
  ) {}

  async executeCommand(
    workflowKey: string,
    entityId: string,
    command: string,
    fromState: string,
    toState: string,
    userId: string,
    userRole: string,
    allowedRoles: string[],
    action: () => Promise<any>
  ): Promise<any> {
    if (allowedRoles.length > 0 && !allowedRoles.includes(userRole)) {
      throw new BadRequestException(`Role ${userRole} is not authorized to execute command ${command} in this workflow stage.`);
    }

    const context = { userId };
    const ok = await this.canTransition(workflowKey, fromState, toState, context);
    if (!ok) {
      throw new BadRequestException(`Invalid transition from '${fromState}' to '${toState}' for command '${command}'`);
    }

    const transitions = this.registries.get(workflowKey);
    const matched = transitions?.find((t) => t.from.includes(fromState) && t.to === toState);
    if (matched?.beforeTransition) {
      await matched.beforeTransition(context);
    }

    const result = await action();

    const historyEntry = this.historyRepository.create({
      workflowKey,
      entityId,
      previousState: fromState,
      newState: toState,
      command,
      userId,
      correlationId: `corr-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    });
    await this.historyRepository.save(historyEntry);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'WORKFLOW_COMMAND_EXECUTED',
      entityType: workflowKey.toUpperCase(),
      entityId,
      previousState: fromState,
      newState: toState,
      userId,
      remarks: `Command ${command} executed by user ${userId} (${userRole})`,
    });

    if (matched?.afterTransition) {
      await matched.afterTransition(context);
    }

    return result;
  }

  registerWorkflow(workflowKey: string, transitions: TransitionDefinition[]) {
    this.registries.set(workflowKey, transitions);
  }

  async canTransition(
    workflowKey: string,
    fromState: string,
    toState: string,
    context: WorkflowContext,
  ): Promise<boolean> {
    const transitions = this.registries.get(workflowKey);
    if (!transitions) return false;

    const matched = transitions.find(
      (t) => t.from.includes(fromState) && t.to === toState,
    );
    if (!matched) return false;

    if (matched.guards) {
      for (const guard of matched.guards) {
        const ok = await guard(context);
        if (!ok) return false;
      }
    }

    return true;
  }

  async executeTransition(
    workflowKey: string,
    entityId: string,
    fromState: string,
    toState: string,
    context: WorkflowContext,
  ): Promise<void> {
    const transitions = this.registries.get(workflowKey);
    if (!transitions) {
      throw new BadRequestException(`No transitions registered for workflow: ${workflowKey}`);
    }

    const matched = transitions.find(
      (t) => t.from.includes(fromState) && t.to === toState,
    );

    if (!matched) {
      throw new BadRequestException(
        `Invalid transition path from '${fromState}' to '${toState}' for workflow ${workflowKey}`,
      );
    }

    if (matched.guards) {
      for (const guard of matched.guards) {
        const ok = await guard(context);
        if (!ok) {
          throw new BadRequestException(`Transition guards failed from '${fromState}' to '${toState}'`);
        }
      }
    }

    if (matched.beforeTransition) {
      await matched.beforeTransition(context);
    }

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'WORKFLOW_TRANSITION',
      entityType: workflowKey.toUpperCase(),
      entityId,
      userId: context.userId,
      remarks: `Transitioned '${workflowKey}' ${entityId} from ${fromState} -> ${toState}`,
    });

    if (matched.afterTransition) {
      await matched.afterTransition(context);
    }
  }
}
