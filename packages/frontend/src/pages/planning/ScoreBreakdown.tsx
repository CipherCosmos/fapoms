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

  /*
    One sentence first, the seventeen numbers second.

    Seventeen 0–100 dimensions is the engine's own vocabulary, and a coordinator was left to
    reverse-engineer "why this person?" out of a row of coloured pills. The strongest two
    dimensions already contain that answer; PLAIN_REASONS just says them the way a person would
    ("Closest, and free that day"). The pills are unchanged and one click away, because when a
    match is questioned the full breakdown is exactly what settles it.
  */
  const PLAIN_REASONS: Record<string, string> = {
    slaCompliance: 'far enough from the branch',
    acceptanceRate: 'usually accepts',
    workload: 'has room in their diary',
    distance: 'closest',
    travelTime: 'quickest to get there',
    performance: 'rated well',
    queryVolume: 'clean paperwork',
    deliverySpeed: 'fast turnaround',
    branchFamiliarity: 'knows this branch',
    experience: 'experienced',
    cost: 'cheapest',
    clientPreference: 'a good fit for this client',
    customerDensity: 'right size for this branch',
    profitability: 'good for the budget',
    riskScore: 'low risk',
    remarksScore: 'well spoken of by staff',
    fairness: 'due for their turn',
  };
  // Only dimensions the person genuinely scores well on may be quoted as a reason; a top-three
  // place on a weak card would otherwise read as praise the engine never gave.
  const reasonParts = strengths.filter(([, v]) => v >= 60).slice(0, 2).map(([k]) => PLAIN_REASONS[k]).filter(Boolean);
  const reasonLine = reasonParts.length > 0
    ? `${reasonParts.join(', and ')}`.replace(/^./, ch => ch.toUpperCase())
    : 'The best of the people available for this branch';
  const weakLine = weakest[1] < 50 ? ` — but ${(SCORE_DIMENSION_LABELS[weakest[0]] ?? '').toLowerCase()} is low` : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '2px' }}>
      <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
        {reasonLine}{weakLine}.
      </div>
      <details>
        <summary style={{ cursor: 'pointer', userSelect: 'none', fontSize: '10px', fontWeight: 600, color: 'var(--accent)' }}>
          Why this match?
        </summary>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
          {entries.map(([k, v]) => pill(k, v, v >= 50))}
        </div>
      </details>
    </div>
  );
};
