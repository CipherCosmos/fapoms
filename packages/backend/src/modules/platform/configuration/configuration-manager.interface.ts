export interface ConfigurationPolicy {
  maxTravelDistanceKm: number;
  dailyWorkloadLimit: number;
  weeklyWorkloadLimit: number;
  hotelEligibilityDistanceKm: number;
  travelAllowancePerKm: number;
  perDiemAmount: number;
  assignmentTimeoutMinutes: number;
  coverageConfidenceThreshold: number;
  slaThresholdHours: number;
  clusterRadiusKm: number;
  approvalLimitAmount: number;
}

export interface ConfigurationManagerInterface {
  resolveConfig(tenantId: string): Promise<ConfigurationPolicy>;
  overrideConfig(tenantId: string, overrides: Partial<ConfigurationPolicy>, userId: string): Promise<void>;
}
