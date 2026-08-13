import React from 'react';

/**
 * How much to trust a stored coordinate, said out loud.
 *
 * Every coordinate in the platform used to look identical: two numbers. But a branch resolved to
 * its mapped front door and one that fell back to its state's centroid are 100 km apart in
 * confidence, and the assayer-matching radius, the travel-cost calculation and the "no assayer
 * within serviceable range" flag all read them as equally true. On this database 40 of 82
 * branches shared a coordinate with another branch, because they had all landed on the same city
 * or state centroid — and nothing on screen said so.
 *
 * This badge is the smallest thing that fixes that: it makes an unreliable pin *look*
 * unreliable, which is the whole reason anybody goes and corrects one.
 */

export type GeoSource =
  | 'manual' | 'geocoder' | 'osm_poi' | 'osm_building'
  | 'osm_street' | 'osm_locality' | 'pincode' | 'locality' | 'none';

interface TierStyle {
  label: string;
  /** Plain-language accuracy, because "±15000 m" is not a unit operators think in. */
  accuracy: string;
  color: string;
  bg: string;
  /** True when this coordinate is too coarse to plan against and wants a manual pin. */
  needsFixing: boolean;
}

const TIERS: Record<GeoSource, TierStyle> = {
  manual: { label: 'PINNED BY HAND', accuracy: 'exact', color: 'var(--success)', bg: 'var(--status-active-bg)', needsFixing: false },
  geocoder: { label: 'GEOCODED', accuracy: '±60 m', color: 'var(--success)', bg: 'var(--status-active-bg)', needsFixing: false },
  osm_poi: { label: 'MAPPED BRANCH', accuracy: '±10 m', color: 'var(--success)', bg: 'var(--status-active-bg)', needsFixing: false },
  osm_building: { label: 'BUILDING', accuracy: '±25 m', color: 'var(--success)', bg: 'var(--status-active-bg)', needsFixing: false },
  osm_street: { label: 'STREET', accuracy: '±120 m', color: 'var(--accent-secondary)', bg: 'var(--bg-surface-2)', needsFixing: false },
  osm_locality: { label: 'LOCALITY', accuracy: '±900 m', color: 'var(--accent-secondary)', bg: 'var(--bg-surface-2)', needsFixing: false },
  pincode: { label: 'PINCODE AREA', accuracy: '±3 km', color: 'var(--warning)', bg: 'var(--status-pending-bg)', needsFixing: false },
  // The two that are not locations at all — they are placeholders standing in for one.
  locality: { label: 'DISTRICT CENTRE', accuracy: '±15 km', color: 'var(--danger)', bg: 'var(--status-cancelled-bg)', needsFixing: true },
  none: { label: 'STATE CENTRE', accuracy: '±100 km', color: 'var(--danger)', bg: 'var(--status-cancelled-bg)', needsFixing: true },
};

const UNKNOWN: TierStyle = {
  label: 'UNVERIFIED',
  accuracy: 'unknown',
  color: 'var(--danger)',
  bg: 'var(--status-cancelled-bg)',
  needsFixing: true,
};

export function geoTier(source?: string | null): TierStyle {
  return (source && TIERS[source as GeoSource]) || UNKNOWN;
}

/** True when this coordinate is a placeholder rather than a location. */
export function geoNeedsFixing(source?: string | null): boolean {
  return geoTier(source).needsFixing;
}

export const GeoPrecisionBadge: React.FC<{
  source?: string | null;
  /** What the geocoder matched. The tier says how precise; only this says whether it is right. */
  matchedName?: string | null;
  compact?: boolean;
}> = ({ source, matchedName, compact = false }) => {
  const tier = geoTier(source);
  return (
    <span
      title={
        tier.needsFixing
          ? `This is not the branch's location — it is the centre of its ${tier.label.toLowerCase()}, ` +
            `used because the address could not be resolved. Distances and assayer matching against ` +
            `it can be wrong by ${tier.accuracy.replace('±', '')}. Pin it by hand to fix.`
          : `${tier.label.toLowerCase()} · accurate to about ${tier.accuracy}` +
            (matchedName ? `\n\nMatched: ${matchedName}` : '')
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontSize: compact ? '9px' : '9.5px',
        fontWeight: 800,
        padding: compact ? '1px 5px' : '2px 7px',
        borderRadius: '8px',
        background: tier.bg,
        color: tier.color,
        letterSpacing: '0.03em',
        whiteSpace: 'nowrap',
        cursor: 'help',
      }}
    >
      {tier.needsFixing ? '⚠ ' : ''}{tier.label} {tier.accuracy}
    </span>
  );
};
