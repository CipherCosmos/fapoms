import React from 'react';
import { formatRouteDistance, formatTravelTime, type CandidateRoute } from '@fapoms/shared';

/** Friendly names for the engine's scoring dimensions. */
export const SCORE_DIMENSION_LABELS: Record<string, string> = {
  slaCompliance: 'SLA compliance',
  acceptanceRate: 'Accepts offers',
  workload: 'Spare capacity',
  distance: 'Proximity',
  travelTime: 'Travel time',
  performance: 'Performance rating',
  queryVolume: 'Clean paperwork',
  deliverySpeed: 'Turnaround speed',
  branchFamiliarity: 'Knows this branch',
  experience: 'Experience',
  cost: 'Cost',
  clientPreference: 'Client fit',
  customerDensity: 'Capacity vs branch size',
  profitability: 'Budget fit',
  riskScore: 'Risk suitability',
  // The two added for staff remarks and rotation fairness. Unknown keys are dropped below, so
  // without these the dimensions would score silently.
  remarksScore: 'Staff remarks',
  fairness: 'Rotation fairness',
};

/**
 * Shows the strongest and weakest dimensions behind a candidate's score.
 *
 * `route`, when given, puts the figure behind the two geographic dimensions into their tooltip
 * — "Proximity: 62/100 — 213 km by road", "Travel time: 40/100 — ~4 h 6 min (estimate)" — so a
 * score is never a bare number, and an estimate is never dressed up as a road figure.
 */
export const ScoreBreakdown: React.FC<{ breakdown?: Record<string, number>; route?: Partial<CandidateRoute> | null }> = ({ breakdown, route }) => {
  if (!breakdown || Object.keys(breakdown).length === 0) return null;
  const entries = Object.entries(breakdown)
    .filter(([k]) => SCORE_DIMENSION_LABELS[k])
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const strengths = entries.slice(0, 3);
  const weakest = entries[entries.length - 1];

  const basis = (k: string): string => {
    if (!route) return '';
    const source = route.distanceSource ?? null;
    if (k === 'distance' && route.distanceKm != null) return ` — ${formatRouteDistance(route.distanceKm, source)}`;
    if (k === 'travelTime' && route.durationMinutes != null) return ` — ${formatTravelTime(route.durationMinutes, source)}`;
    return '';
  };

  const pill = (k: string, v: number, good: boolean) => (
    <span key={k} title={`${SCORE_DIMENSION_LABELS[k]}: ${Math.round(v)}/100${basis(k)}`}
      style={{ fontSize: '9.5px', fontWeight: 600, padding: '1px 5px', borderRadius: '4px', whiteSpace: 'nowrap',
        background: good ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)',
        color: good ? 'var(--success)' : 'var(--danger)' }}>
      {SCORE_DIMENSION_LABELS[k]} {Math.round(v)}
    </span>
  );

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '2px' }}>
      {strengths.map(([k, v]) => pill(k, v, true))}
      {weakest[1] < 50 && pill(weakest[0], weakest[1], false)}
    </div>
  );
};
