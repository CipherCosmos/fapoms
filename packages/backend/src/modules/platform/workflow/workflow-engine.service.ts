import { Injectable } from '@nestjs/common';

export interface WorkflowTransitionGuard {
  validate(context: any): Promise<boolean> | boolean;
}

export interface WorkflowTransitionAction {
  execute(context: any): Promise<void> | void;
}

export interface WorkflowTransition {
  fromState: string;
  toState: string;
  guards?: WorkflowTransitionGuard[];
  actions?: WorkflowTransitionAction[];
}

export interface WorkflowDefinition {
  name: string;
  transitions: WorkflowTransition[];
}

@Injectable()
export class ReusableWorkflowEngine {
  private workflows: Record<string, WorkflowDefinition> = {};

  registerWorkflow(definition: WorkflowDefinition): void {
    this.workflows[definition.name] = definition;
  }

  async executeTransition(
    workflowName: string,
    fromState: string,
    toState: string,
    context: any
  ): Promise<boolean> {
    const wf = this.workflows[workflowName];
    if (!wf) return false;

    const transition = wf.transitions.find(
      (t) => t.fromState === fromState && t.toState === toState
    );
    if (!transition) return false;

    // Enforce Guard Conditions
    if (transition.guards) {
      for (const guard of transition.guards) {
        const ok = await guard.validate(context);
        if (!ok) return false;
      }
    }

    // Execute Transition Actions
    if (transition.actions) {
      for (const act of transition.actions) {
        await act.execute(context);
      }
    }

    return true;
  }
}
