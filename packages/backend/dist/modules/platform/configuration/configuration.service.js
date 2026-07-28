"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultConfigurationService = void 0;
const common_1 = require("@nestjs/common");
let DefaultConfigurationService = class DefaultConfigurationService {
    defaultPolicy = {
        maxTravelDistanceKm: 150.0,
        dailyWorkloadLimit: 3,
        weeklyWorkloadLimit: 15,
        hotelEligibilityDistanceKm: 100.0,
        travelAllowancePerKm: 12.5,
        perDiemAmount: 1200.0,
        assignmentTimeoutMinutes: 60,
        coverageConfidenceThreshold: 80.0,
        slaThresholdHours: 48,
        clusterRadiusKm: 30.0,
        approvalLimitAmount: 100000.0,
    };
    tenantOverrides = {};
    async resolveConfig(tenantId) {
        const overrides = this.tenantOverrides[tenantId] || {};
        return {
            ...this.defaultPolicy,
            ...overrides,
        };
    }
    async overrideConfig(tenantId, overrides, userId) {
        this.tenantOverrides[tenantId] = {
            ...(this.tenantOverrides[tenantId] || {}),
            ...overrides,
        };
    }
};
exports.DefaultConfigurationService = DefaultConfigurationService;
exports.DefaultConfigurationService = DefaultConfigurationService = __decorate([
    (0, common_1.Injectable)()
], DefaultConfigurationService);
//# sourceMappingURL=configuration.service.js.map