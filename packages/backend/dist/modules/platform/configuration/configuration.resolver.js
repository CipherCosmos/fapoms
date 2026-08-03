"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var ConfigurationResolver_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigurationResolver = void 0;
const common_1 = require("@nestjs/common");
const DEFAULT_RECOMMENDATION_CONFIG = {
    weights: {
        slaCompliance: 0.15,
        acceptanceRate: 0.10,
        workload: 0.07,
        distance: 0.14,
        travelTime: 0.08,
        performance: 0.09,
        queryVolume: 0.06,
        deliverySpeed: 0.06,
        branchFamiliarity: 0.06,
        experience: 0.04,
        cost: 0.05,
        clientPreference: 0.05,
        customerDensity: 0.02,
        profitability: 0.02,
        riskScore: 0.01,
    },
    defaultRadius: 50.0,
};
let ConfigurationResolver = ConfigurationResolver_1 = class ConfigurationResolver {
    static knownWeightKeys() {
        return Object.keys(DEFAULT_RECOMMENDATION_CONFIG.weights);
    }
    static assertWeightsCoverAllCalculators(calculatorNames) {
        const known = new Set(ConfigurationResolver_1.knownWeightKeys());
        return calculatorNames.filter((n) => !known.has(n));
    }
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
exports.ConfigurationResolver = ConfigurationResolver = ConfigurationResolver_1 = __decorate([
    (0, common_1.Injectable)()
], ConfigurationResolver);
//# sourceMappingURL=configuration.resolver.js.map