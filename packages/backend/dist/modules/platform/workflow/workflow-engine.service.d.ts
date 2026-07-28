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
export declare class ReusableWorkflowEngine {
    private workflows;
    registerWorkflow(definition: WorkflowDefinition): void;
    executeTransition(workflowName: string, fromState: string, toState: string, context: any): Promise<boolean>;
}
