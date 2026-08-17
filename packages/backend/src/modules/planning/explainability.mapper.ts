import { formatRouteDistance, RouteSource } from '@fapoms/shared';

export interface ExplanationReason {
  type: 'POSITIVE' | 'NEGATIVE';
  message: string;
}

export function generateExplanation(
  breakdown: Record<string, number>,
  details: {
    displayName: string;
    distanceKm: number | null;
    /**
     * How `distanceKm` was measured — 'OSRM' by road, 'ESTIMATE' as a straight line. The
     * sentence built below is read by a person, so it says which; absent (an older caller),
     * the figure is hedged as an estimate rather than presented as a road figure.
     */
    distanceSource?: RouteSource | null;
    performanceRating?: number | null;
    experienceYears?: number | null;
    baseFee?: number | null;
  }
): ExplanationReason[] {
  const reasons: ExplanationReason[] = [];

  // Proximity highlight. Thresholds are on the figure as measured; the wording says how it
  // was measured ("8.3 km by road" / "~164 km (straight line, estimate)").
  if (details.distanceKm !== null) {
    const distance = formatRouteDistance(details.distanceKm, details.distanceSource ?? null);
    if (details.distanceKm <= 15) {
      reasons.push({
        type: 'POSITIVE',
        message: `${details.displayName} is located very close to the branch (${distance}).`,
      });
    } else if (details.distanceKm > 100) {
      reasons.push({
        type: 'NEGATIVE',
        message: `${details.displayName} is located far from the branch (${distance}), which may increase travel costs.`,
      });
    }
  }

  // Performance rating highlight
  if (details.performanceRating !== undefined && details.performanceRating !== null) {
    if (details.performanceRating >= 4.5) {
      reasons.push({
        type: 'POSITIVE',
        message: `High performance rating of ${details.performanceRating} indicates exceptional service quality history.`,
      });
    } else if (details.performanceRating < 3.5) {
      reasons.push({
        type: 'NEGATIVE',
        message: `Performance rating is lower than average (${details.performanceRating}).`,
      });
    }
  }

  // Workload highlight
  if (breakdown.workload !== undefined) {
    if (breakdown.workload >= 80) {
      reasons.push({
        type: 'POSITIVE',
        message: `Excellent availability with ample remaining weekly workload capacity.`,
      });
    } else if (breakdown.workload < 30) {
      reasons.push({
        type: 'NEGATIVE',
        message: `High active workload; assayer is near weekly capacity limit.`,
      });
    }
  }

  // Cost / budget highlight
  if (breakdown.profitability !== undefined) {
    if (breakdown.profitability > 80) {
      reasons.push({
        type: 'POSITIVE',
        message: `Highly cost-effective selection fits well within client's target budget.`,
      });
    } else if (breakdown.profitability < 40) {
      reasons.push({
        type: 'NEGATIVE',
        message: `Higher commercial cost profile exceeds client's typical target budget parameters.`,
      });
    }
  }

  return reasons;
}
