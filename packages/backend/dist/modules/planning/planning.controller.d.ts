import { PlanningService, CreateBusinessRuleDto, UpdateBusinessRuleDto } from './planning.service';
import { PlanningOrchestratorService } from './planning-orchestrator.service';
import { ProjectPlanningService } from './project-planning.service';
import { OptimizationEngine } from './optimization.engine';
import { ScenarioPlanningService } from './scenario-planning.service';
import { CoveragePlanningEngine } from './coverage-planning.engine';
import { DayPlannerService } from './day-planner.service';
import { OperationsPlanningService, PlanOverrideDto } from './operations-planning.service';
import { OperationsControlCenterService } from './operations-control-center.service';
import { OperationsExecutionService, GroupPackageDto } from './operations-execution.service';
import { FieldOperationsService } from './field-operations.service';
import { CoveragePlanStatus } from './coverage-plan.entity';
import { OperationsExceptionCategory } from './operations-exception.entity';
import { OperationsTaskPriority } from './operations-task.entity';
import { NegotiationParticipant } from './operations-execution-conversation.entity';
import { FieldVisitStatus } from './field-visit.entity';
import { IncidentSeverity } from './field-incident.entity';
export declare class CreateBusinessRuleRequestDto implements CreateBusinessRuleDto {
    name: string;
    scope: string;
    targetId?: string;
    ruleType: string;
    conditions: Record<string, any>;
    actions?: Record<string, any>;
}
export declare class UpdateBusinessRuleRequestDto implements UpdateBusinessRuleDto {
    name?: string;
    scope?: string;
    targetId?: string | null;
    ruleType?: string;
    conditions?: Record<string, any>;
    actions?: Record<string, any> | null;
}
export declare class PlanningController {
    private readonly planningService;
    private readonly planningOrchestratorService;
    private readonly projectPlanningService;
    private readonly optimizationEngine;
    private readonly scenarioPlanningService;
    private readonly coveragePlanningEngine;
    private readonly operationsPlanningService;
    private readonly controlCenterService;
    private readonly executionService;
    private readonly fieldService;
    private readonly dayPlannerService;
    constructor(planningService: PlanningService, planningOrchestratorService: PlanningOrchestratorService, projectPlanningService: ProjectPlanningService, optimizationEngine: OptimizationEngine, scenarioPlanningService: ScenarioPlanningService, coveragePlanningEngine: CoveragePlanningEngine, operationsPlanningService: OperationsPlanningService, controlCenterService: OperationsControlCenterService, executionService: OperationsExecutionService, fieldService: FieldOperationsService, dayPlannerService: DayPlannerService);
    createVisit(body: {
        coveragePlanId: string;
        executionGroupId: string;
        branchId: string;
        assayerId: string;
        plannedDate: string;
    }): Promise<{
        success: boolean;
        data: import("./field-visit.entity").FieldVisitEntity;
    }>;
    transitionVisit(visitId: string, body: {
        status: FieldVisitStatus;
    }): Promise<{
        success: boolean;
        data: import("./field-visit.entity").FieldVisitEntity;
    }>;
    reportIncident(visitId: string, body: {
        title: string;
        description: string;
        severity: IncidentSeverity;
    }): Promise<{
        success: boolean;
        data: import("./field-incident.entity").FieldIncidentEntity;
    }>;
    resolveIncident(incidentId: string, body: {
        justification: string;
    }): Promise<{
        success: boolean;
        data: import("./field-incident.entity").FieldIncidentEntity;
    }>;
    getHandover(visitId: string): Promise<{
        success: boolean;
        data: import("./field-operations.service").HandoverPackage;
    }>;
    getFieldDashboard(coveragePlanId: string): Promise<{
        success: boolean;
        data: import("./field-operations.service").FieldDashboardSummary;
    }>;
    packageAssignments(dto: GroupPackageDto): Promise<{
        success: boolean;
        data: import("./operations-execution-group.entity").OperationsExecutionGroupEntity;
    }>;
    postMessage(groupId: string, body: {
        sender: NegotiationParticipant;
        message: string;
        feeOverride?: number;
        dateOverride?: string;
    }): Promise<{
        success: boolean;
        data: import("./operations-execution-conversation.entity").OperationsExecutionConversationEntity;
    }>;
    getReadiness(groupId: string): Promise<{
        success: boolean;
        data: {
            isReady: boolean;
            checks: Record<string, boolean>;
        };
    }>;
    getControlCenterDashboard(): Promise<{
        success: boolean;
        data: import("./operations-control-center.service").ControlCenterDashboardData;
    }>;
    createTask(body: {
        projectId: string;
        title: string;
        reason: string;
        priority: OperationsTaskPriority;
    }): Promise<{
        success: boolean;
        data: import("./operations-task.entity").OperationsTaskEntity;
    }>;
    resolveTask(taskId: string, body: {
        justification: string;
    }): Promise<{
        success: boolean;
        data: import("./operations-task.entity").OperationsTaskEntity;
    }>;
    createException(body: {
        projectId: string;
        category: OperationsExceptionCategory;
        message: string;
        targetEntityId?: string;
    }): Promise<{
        success: boolean;
        data: import("./operations-exception.entity").OperationsExceptionEntity;
    }>;
    resolveException(exceptionId: string, body: {
        justification: string;
    }): Promise<{
        success: boolean;
        data: import("./operations-exception.entity").OperationsExceptionEntity;
    }>;
    getProjectCoverage(projectId: string): Promise<{
        success: boolean;
        data: {
            total: number;
            scheduled: number;
            confirmed: number;
            remaining: number;
            coveragePercentage: number;
        };
    }>;
    getProjectCoveragePlan(projectId: string): Promise<{
        success: boolean;
        data: import("./coverage-planning.engine").CoveragePlanOutput;
    }>;
    createOrRegeneratePlan(projectId: string, body: {
        overrides?: PlanOverrideDto[];
        justification?: string;
    }, req: any): Promise<{
        success: boolean;
        data: import("./coverage-plan.entity").CoveragePlanEntity;
    }>;
    transitionPlan(planId: string, body: {
        status: CoveragePlanStatus;
    }, req: any): Promise<{
        success: boolean;
        data: import("./coverage-plan.entity").CoveragePlanEntity;
    }>;
    executePlan(planId: string, req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
    getProjectCandidates(projectId: string): Promise<{
        success: boolean;
        data: import("./project-planning.service").ProjectPlanningReport;
    }>;
    optimizeProjectDeployment(projectId: string): Promise<{
        success: boolean;
        data: import("./optimization.engine").OptimizationPlan;
    }>;
    simulateScenario(dto: {
        projectId: string;
        weightOverrides?: Record<string, number>;
        defaultRadiusOverride?: number;
    }): Promise<{
        success: boolean;
        data: import("./optimization.engine").OptimizationPlan;
    }>;
    getRecommendations(branchId: string): Promise<{
        success: boolean;
        data: import("./planning.service").AssayerRecommendation[];
    }>;
    getDayPlans(projectId: string, targetDate?: string): Promise<{
        success: boolean;
        data: import("./day-planner.service").ProjectDayPlan;
    }>;
    createRule(dto: CreateBusinessRuleRequestDto, req: any): Promise<{
        success: boolean;
        data: import("../platform/rules/business-rule.entity").BusinessRuleEntity;
    }>;
    updateRule(id: string, dto: UpdateBusinessRuleRequestDto, req: any): Promise<{
        success: boolean;
        data: import("../platform/rules/business-rule.entity").BusinessRuleEntity;
    }>;
    deleteRule(id: string, req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
    getRules(scope?: string): Promise<{
        success: boolean;
        data: import("../platform/rules/business-rule.entity").BusinessRuleEntity[];
    }>;
    getRule(id: string): Promise<{
        success: boolean;
        data: import("../platform/rules/business-rule.entity").BusinessRuleEntity;
    }>;
}
