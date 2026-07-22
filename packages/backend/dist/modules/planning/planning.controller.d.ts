import { PlanningService, CreateBusinessRuleDto, UpdateBusinessRuleDto } from './planning.service';
import { PlanningOrchestratorService } from './planning-orchestrator.service';
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
    constructor(planningService: PlanningService, planningOrchestratorService: PlanningOrchestratorService);
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
    getRecommendations(branchId: string): Promise<{
        success: boolean;
        data: import("./planning.service").AssayerRecommendation[];
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
