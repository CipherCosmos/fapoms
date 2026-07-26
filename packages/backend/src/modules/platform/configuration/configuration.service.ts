import { Injectable } from '@nestjs/common';
import { ConfigurationManagerInterface, ConfigurationPolicy } from './configuration-manager.interface';

@Injectable()
export class DefaultConfigurationService implements ConfigurationManagerInterface {
  private readonly defaultPolicy: ConfigurationPolicy = {
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

  private tenantOverrides: Record<string, Partial<ConfigurationPolicy>> = {};

  async resolveConfig(tenantId: string): Promise<ConfigurationPolicy> {
    const overrides = this.tenantOverrides[tenantId] || {};
    return {
      ...this.defaultPolicy,
      ...overrides,
    };
  }

  async overrideConfig(tenantId: string, overrides: Partial<ConfigurationPolicy>, userId: string): Promise<void> {
    this.tenantOverrides[tenantId] = {
      ...(this.tenantOverrides[tenantId] || {}),
      ...overrides,
    };
  }
}
