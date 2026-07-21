"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigurationResolver = void 0;
const common_1 = require("@nestjs/common");
const DEFAULT_RECOMMENDATION_CONFIG = {
    weights: {
        distance: 0.2,
        travelTime: 0.1,
        workload: 0.1,
        performance: 0.1,
        experience: 0.1,
        cost: 0.1,
        clientPreference: 0.1,
        branchFamiliarity: 0.1,
        slaCompliance: 0.05,
        profitability: 0.05,
        riskScore: 0.1,
    },
    defaultRadius: 50.0,
};
let ConfigurationResolver = class ConfigurationResolver {
    resolveRecommendationConfig(client, requestOverrides) {
        const clientWeights = client?.planningPreferences?.weights || {};
        const clientRadius = client?.configuration?.defaultRadius;
        const mergedWeights = {
            ...DEFAULT_RECOMMENDATION_CONFIG.weights,
            ...clientWeights,
            ...(requestOverrides?.weights || {}),
        };
        const mergedRadius = requestOverrides?.defaultRadius ??
            (clientRadius !== undefined ? Number(clientRadius) : DEFAULT_RECOMMENDATION_CONFIG.defaultRadius);
        return {
            weights: mergedWeights,
            defaultRadius: mergedRadius,
        };
    }
};
exports.ConfigurationResolver = ConfigurationResolver;
exports.ConfigurationResolver = ConfigurationResolver = __decorate([
    (0, common_1.Injectable)()
], ConfigurationResolver);
//# sourceMappingURL=configuration.resolver.js.map