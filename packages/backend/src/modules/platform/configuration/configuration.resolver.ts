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
 *
 * ## Rebalance for staff remarks and rotation fairness (2026-08-17)
 *
 * Two dimensions were added and 0.10 had to come from somewhere without disturbing the shape
 * of the decision — geography and SLA still lead, quality still follows, commercials still trail:
 *
 *   remarksScore   +0.06   what the people who work with this assayer have said, last 365 days,
 *                          recency-weighted; 50 = nothing said (see RemarksScoreCalculator)
 *   fairness       +0.04   fewer offers in the last 30 days scores higher — a nudge on ties,
 *                          not a quota (see FairnessScoreCalculator)
 *   performance    0.09 → 0.07   `assayer.performanceRating` is a static number typed on the
 *                          profile (and defaults to a perfect 5.0). The remark stream is the
 *                          live, attributed, dated version of the same judgement.
 *   experience     0.04 → 0.02   years-in-role is the weakest of the quality proxies; a real
 *                          remark from the validation desk says more than a tenure number
 *   queryVolume    0.06 → 0.04   still counted; the PAPERWORK remark category now carries part
 *                          of the same signal with a human's judgement attached
 *   deliverySpeed  0.06 → 0.04   turnaround still matters, but the PUNCTUALITY remark category
 *                          overlaps it and is the more direct observation
 *   customerDensity 0.02 → 0.00  removed. It scored capacity-vs-packets, which `workload` and
 *                          the day planner already cover, and on this deployment it returned
 *                          the same "no signal" 50 for almost every candidate. The calculator
 *                          stays registered so the breakdown still shows it; it just no
 *                          longer moves anything. (An explicit 0 rather than removing the key,
 *                          so assertWeightsCoverAllCalculators stays quiet.)
 *
 * Sum check: 0.15+0.10+0.07 + 0.14+0.08 + 0.07+0.04+0.04+0.06+0.02+0.06 + 0.05+0.05+0.00+0.02+0.01+0.04 = 1.00
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
    // The static profile rating; part of its weight moved to remarksScore, the live version.
    performance: 0.07,
    // Fewer clarification queries against an assayer's paperwork means cleaner data entry and
    // a faster report — a direct quality proxy that was previously ignored.
    queryVolume: 0.04,
    deliverySpeed: 0.04,
    branchFamiliarity: 0.06,
    experience: 0.02,
    // What staff have actually said about them, recency-weighted, bounded to 0–100 by
    // construction. Worth 6 points at most in either direction: enough to settle a close call,
    // never enough to remove anyone. See RemarksScoreCalculator.
    remarksScore: 0.06,

    // ── Commercials and fit ────────────────────────────────────────────────────
    cost: 0.05,
    clientPreference: 0.05,
    // Capacity vs branch size, budget adherence, and seniority-for-risk are genuine but
    // secondary tie-breakers. customerDensity is deliberately 0 — see the rebalance note.
    customerDensity: 0.00,
    profitability: 0.02,
    riskScore: 0.01,
    // Spread the work: whoever has had the fewest offers this month edges a near-tie. A nudge,
    // not a quota — see FairnessScoreCalculator.
    fairness: 0.04,
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
