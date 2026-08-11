import { Injectable } from '@nestjs/common';

export interface ClientConfigurationProvider {
  planningPreferences?: { weights?: Record<string, any> } | null;
  configuration?: { defaultRadius?: number } | null;
}

export interface RecommendationConfig {
  weights: Record<string, number>;
  defaultRadius: number;
}

/**
 * Default scoring weights, one per registered ScoreCalculator.
 *
 * A calculator with no entry here scores `?? 0`, so it still runs but contributes nothing —
 * six calculators were in exactly that state (acceptanceRate, deliverySpeed, queryVolume,
 * customerDensity, profitability, riskScore). They computed real signals from real data on
 * every recommendation and the results were discarded, which is why rankings were driven
 * almost entirely by geography and SLA. `assertWeightsCoverAllCalculators()` below now fails
 * fast if that gap reappears.
 *
 * Weights are relative — the engine divides by the total — but they are kept summing to 1.00
 * so each number reads directly as "share of the decision".
 */
const DEFAULT_RECOMMENDATION_CONFIG: RecommendationConfig = {
  weights: {
    // ── Can they do it, on time? ────────────────────────────────────────────────
    slaCompliance: 0.15,
    // Acceptance history matters as much as proximity: the nearest assayer is worthless if
    // they routinely decline, which is the failure mode that leaves branches uncovered while
    // ops re-offers down the list.
    acceptanceRate: 0.10,
    workload: 0.07,

    // ── Can they get there? ────────────────────────────────────────────────────
    distance: 0.14,
    travelTime: 0.08,

    // ── How well do they do it? ────────────────────────────────────────────────
    performance: 0.09,
    // Fewer clarification queries against an assayer's paperwork means cleaner data entry and
    // a faster report — a direct quality proxy that was previously ignored.
    queryVolume: 0.06,
    deliverySpeed: 0.06,
    branchFamiliarity: 0.06,
    experience: 0.04,

    // ── Commercials and fit ────────────────────────────────────────────────────
    cost: 0.05,
    clientPreference: 0.05,
    // Capacity vs branch size, budget adherence, and seniority-for-risk are genuine but
    // secondary tie-breakers.
    customerDensity: 0.02,
    profitability: 0.02,
    riskScore: 0.01,
  },
  defaultRadius: 50.0,
};

@Injectable()
export class ConfigurationResolver {
  /** The scoring dimensions this config knows about. */
  static knownWeightKeys(): string[] {
    return Object.keys(DEFAULT_RECOMMENDATION_CONFIG.weights);
  }

  /**
   * Fails fast when a registered ScoreCalculator has no default weight.
   *
   * Without this, adding a calculator and forgetting its weight is invisible: it runs on every
   * recommendation, costs the queries, and contributes exactly nothing to the ranking. Six
   * calculators shipped in that state. Called at startup by RecommendationEngine.
   */
  static assertWeightsCoverAllCalculators(calculatorNames: string[]): string[] {
    const known = new Set(ConfigurationResolver.knownWeightKeys());
    return calculatorNames.filter((n) => !known.has(n));
  }

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
