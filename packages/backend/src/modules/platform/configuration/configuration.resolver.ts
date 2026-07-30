import { Injectable } from '@nestjs/common';

export interface ClientConfigurationProvider {
  planningPreferences?: { weights?: Record<string, any> } | null;
  configuration?: { defaultRadius?: number } | null;
}

export interface RecommendationConfig {
  weights: Record<string, number>;
  defaultRadius: number;
}

const DEFAULT_RECOMMENDATION_CONFIG: RecommendationConfig = {
  weights: {
    slaCompliance: 0.25,
    distance: 0.20,
    travelTime: 0.15,
    workload: 0.10,
    performance: 0.10,
    experience: 0.05,
    cost: 0.05,
    clientPreference: 0.05,
    branchFamiliarity: 0.08,
  },
  defaultRadius: 50.0,
};

@Injectable()
export class ConfigurationResolver {
  /**
   * Resolves the effective recommendation configuration based on global defaults
   * and client-level overrides.
   */
  resolveRecommendationConfig(
    client?: ClientConfigurationProvider | null,
    requestOverrides?: Partial<RecommendationConfig>,
  ): RecommendationConfig {
    const clientWeights = client?.planningPreferences?.weights || {};
    const clientRadius = client?.configuration?.defaultRadius;

    const mergedWeights = {
      ...DEFAULT_RECOMMENDATION_CONFIG.weights,
      ...clientWeights,
      ...(requestOverrides?.weights || {}),
    };

    const mergedRadius =
      requestOverrides?.defaultRadius ??
      (clientRadius !== undefined ? Number(clientRadius) : DEFAULT_RECOMMENDATION_CONFIG.defaultRadius);

    return {
      weights: mergedWeights,
      defaultRadius: mergedRadius,
    };
  }
}
