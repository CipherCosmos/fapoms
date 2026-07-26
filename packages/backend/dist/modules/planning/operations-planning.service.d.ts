import { Repository } from 'typeorm';
import { CoveragePlanEntity, CoveragePlanStatus } from './coverage-plan.entity';
import { CoveragePlanVersionEntity } from './coverage-plan-version.entity';
import { CoveragePlanningEngine } from './coverage-planning.engine';
import { AssignmentService } from '../assignment/assignment.service';
import { ProjectQueryService } from '../project/project-query.service';
export interface PlanOverrideDto {
    branchId: string;
    assayerId: string;
    lockAssayer?: boolean;
    pinAssignment?: boolean;
    justification: string;
}
export declare class OperationsPlanningService {
    private readonly planRepository;
    private readonly versionRepository;
    private readonly planningEngine;
    private readonly assignmentService;
    private readonly projectQueryService;
    constructor(planRepository: Repository<CoveragePlanEntity>, versionRepository: Repository<CoveragePlanVersionEntity>, planningEngine: CoveragePlanningEngine, assignmentService: AssignmentService, projectQueryService: ProjectQueryService);
    createOrRegeneratePlan(projectId: string, overrides?: PlanOverrideDto[], userId?: string, justification?: string): Promise<CoveragePlanEntity>;
    transitionPlanStatus(planId: string, targetStatus: CoveragePlanStatus, userId?: string): Promise<CoveragePlanEntity>;
    executeApprovedPlan(planId: string, userId: string): Promise<void>;
}
