import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { WorkflowHistoryEntity } from './workflow-history.entity';
import { AuditService } from '../../../core/audit/audit.service';
import { UnitOfWork } from '../../../infrastructure/persistence/unit-of-work';
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

/**
 * An action a workflow command runs as its state change.
 *
 * The optional `manager` lets a caller join the transaction `executeCommand` now opens around
 * action + history + audit, so its save/side-effect writes commit or roll back together with
 * the rest. A caller that ignores the parameter (the pre-existing `() => Promise<any>` shape)
 * still type-checks and still runs — it just keeps writing on its own connection, exactly as
 * before this change, so this is not a breaking change to the engine's public API.
 */
export type WorkflowAction = (manager?: EntityManager) => Promise<any>;

@Injectable()
export class WorkflowEngine {
  private registries = new Map<string, TransitionDefinition[]>();

  constructor(
    private readonly auditService: AuditService,
    private readonly uow: UnitOfWork,
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
    action: WorkflowAction,
    payload?: any
  ): Promise<any> {
    if (allowedRoles.length > 0 && !allowedRoles.includes(userRole)) {
      throw new BadRequestException(`Role ${userRole} is not authorized to execute command ${command} in this workflow stage.`);
    }

    const context = { userId, payload };
    const ok = await this.canTransition(workflowKey, fromState, toState, context);
    if (!ok) {
      throw new BadRequestException(`Invalid transition from '${fromState}' to '${toState}' for command '${command}'`);
    }

    const transitions = this.registries.get(workflowKey);
    const matched = transitions?.find((t) => t.from.includes(fromState) && t.to === toState);
    if (matched?.beforeTransition) {
      await matched.beforeTransition(context);
    }

    /**
     * action() (a save, plus whatever else the caller's closure does), the history row and the
     * audit row used to be three-to-many separate autocommits. A failure between them — a
     * departed person saved with an open empanelment, or a saved transition with no history row
     * — left state the state machine's retry then refused to move again, because it read the
     * half-applied lifecycleStatus back as the current one. One transaction makes the whole
     * command atomic: either the state change, its history entry and its audit row all land, or
     * none of them do and the caller can simply retry from the untouched prior state.
     */
    const result = await this.uow.run(async (manager) => {
      const actionResult = await action(manager);

      const historyEntry = manager.getRepository(WorkflowHistoryEntity).create({
        workflowKey,
        entityId,
        previousState: fromState,
        newState: toState,
        command,
        userId,
        correlationId: `corr-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      });
      await manager.getRepository(WorkflowHistoryEntity).save(historyEntry);

      await this.auditService.recordEvent(
        {
          category: EventCategory.WORKFLOW,
          eventType: 'WORKFLOW_COMMAND_EXECUTED',
          entityType: workflowKey.toUpperCase(),
          entityId,
          previousState: fromState,
          newState: toState,
          userId,
          remarks: `Command ${command} executed by user ${userId} (${userRole})`,
        },
        { manager },
      );

      return actionResult;
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
