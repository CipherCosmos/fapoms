"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScenarioPlanningService = void 0;
const common_1 = require("@nestjs/common");
const project_query_service_1 = require("../project/project-query.service");
const client_entity_1 = require("../client/client.entity");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const recommendation_engine_1 = require("./recommendation.engine");
const optimization_engine_1 = require("./optimization.engine");
const configuration_resolver_1 = require("../platform/configuration/configuration.resolver");
let ScenarioPlanningService = class ScenarioPlanningService {
    projectQueryService;
    configResolver;
    recommendationEngine;
    optimizationEngine;
    clientRepository;
    constructor(projectQueryService, configResolver, recommendationEngine, optimizationEngine, clientRepository) {
        this.projectQueryService = projectQueryService;
        this.configResolver = configResolver;
        this.recommendationEngine = recommendationEngine;
        this.optimizationEngine = optimizationEngine;
        this.clientRepository = clientRepository;
    }
    async simulatePlanningScenario(dto) {
        const project = await this.projectQueryService.findOne(dto.projectId);
        if (!project) {
            throw new common_1.NotFoundException(`Project ${dto.projectId} not found.`);
        }
        const client = await this.clientRepository.findOne({
            where: { id: project.clientId, isActive: true },
        });
        const resolvedConfig = this.configResolver.resolveRecommendationConfig(client, {
            weights: dto.weightOverrides || {},
            defaultRadius: dto.defaultRadiusOverride ?? 50.0,
        });
        const originalPreferences = client?.planningPreferences ?? null;
        if (client) {
            client.planningPreferences = {
                weights: resolvedConfig.weights,
            };
        }
        try {
            const plan = await this.optimizationEngine.generateProjectDeploymentPlan(dto.projectId);
            return plan;
        }
        finally {
            if (client) {
                client.planningPreferences = originalPreferences;
            }
        }
    }
};
exports.ScenarioPlanningService = ScenarioPlanningService;
exports.ScenarioPlanningService = ScenarioPlanningService = __decorate([
    (0, common_1.Injectable)(),
    __param(4, (0, typeorm_1.InjectRepository)(client_entity_1.ClientEntity)),
    __metadata("design:paramtypes", [project_query_service_1.ProjectQueryService,
        configuration_resolver_1.ConfigurationResolver,
        recommendation_engine_1.RecommendationEngine,
        optimization_engine_1.OptimizationEngine,
        typeorm_2.Repository])
], ScenarioPlanningService);
//# sourceMappingURL=scenario-planning.service.js.map