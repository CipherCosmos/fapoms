import { PlanningService } from './planning.service';
export declare class PlanningController {
    private readonly planningService;
    constructor(planningService: PlanningService);
    getRecommendations(branchId: string): Promise<{
        success: boolean;
        data: import("./planning.service").AssayerRecommendation[];
    }>;
}
