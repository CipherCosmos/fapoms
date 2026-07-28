export interface ProjectMetricsProvider {
  getTotalProjectsCount(): Promise<number>;
  getActiveProjectsCount(): Promise<number>;
  getProjectsAtRiskCount(breachedCounts: Record<string, number>): Promise<number>;
  getProjectBranchCounts(): Promise<{ total: number; deployed: number }>;
}
