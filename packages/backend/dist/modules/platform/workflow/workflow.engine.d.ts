import { AuditService } from '../../../core/audit/audit.service';
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
export declare class WorkflowEngine {
    private readonly auditService;
    private registries;
    constructor(auditService: AuditService);
    registerWorkflow(workflowKey: string, transitions: TransitionDefinition[]): void;
    canTransition(workflowKey: string, fromState: string, toState: string, context: WorkflowContext): Promise<boolean>;
    executeTransition(workflowKey: string, entityId: string, fromState: string, toState: string, context: WorkflowContext): Promise<void>;
}
