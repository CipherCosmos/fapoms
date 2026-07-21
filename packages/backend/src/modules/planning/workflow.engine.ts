import { Injectable, BadRequestException } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
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

  constructor(private readonly auditService: AuditService) {}

  /**
   * Registers a list of valid state transitions for a given workflow key.
   */
  registerWorkflow(workflowKey: string, transitions: TransitionDefinition[]) {
    this.registries.set(workflowKey, transitions);
  }

  /**
   * Checks if an entity can transition from the current state to the target state.
   */
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

  /**
   * Executes a state transition, validating guards and side effects.
   */
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

    // 1. Run guards
    if (matched.guards) {
      for (const guard of matched.guards) {
        const ok = await guard(context);
        if (!ok) {
          throw new BadRequestException(`Transition guards failed from '${fromState}' to '${toState}'`);
        }
      }
    }

    // 2. Pre-transition hook
    if (matched.beforeTransition) {
      await matched.beforeTransition(context);
    }

    // 3. Log event
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'WORKFLOW_TRANSITION',
      entityType: workflowKey.toUpperCase(),
      entityId,
      userId: context.userId,
      remarks: `Transitioned '${workflowKey}' ${entityId} from ${fromState} -> ${toState}`,
    });

    // 4. Post-transition hook
    if (matched.afterTransition) {
      await matched.afterTransition(context);
    }
  }
}
