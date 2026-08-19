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
  /** The plain-language verdict. Never the geocoder's name for the match. */
  label: string;
  /** How close it is, in words. */
  accuracy: string;
  /** The long-form explanation behind the badge, shown on hover. */
  hint: string;
  color: string;
  bg: string;
  /** True when this coordinate is too coarse to plan against and wants a manual pin. */
  needsFixing: boolean;
}

/**
 * Nine geocoder outcomes, three verdicts.
 *
 * This map used to print the *provider's* word for how the match was made — GEOCODED, OSM_POI,
 * PINCODE AREA, UNVERIFIED — next to a metric distance (±60 m, ±15 km). Both halves are written
 * for whoever built the pipeline. A coordinator looking at a branch list has one question, "can
 * I plan against this pin or not?", and could not answer it: nothing about the word GEOCODED
 * says good and nothing about OSM_POI says better, and "±3 km" needs mental arithmetic against
 * a travel radius to become a decision.
 *
 * So the label now states the verdict in the three grades that actually change what someone
 * does — usable, roughly right, not a location at all — and the distance moves into the hover
 * text for the rare reader who wants it. The nine sources still map one-to-one to their own
 * entry: the precision is unchanged, only the wording is, and the colours (green / amber / red)
 * carry the same grading for anyone reading the row at a glance.
 */
const TIERS: Record<GeoSource, TierStyle> = {
  manual: {
    label: 'Location exact', accuracy: 'pinned by hand',
    hint: 'Somebody placed this pin on the map themselves. It is the most reliable kind of location there is.',
    color: 'var(--success)', bg: 'var(--status-active-bg)', needsFixing: false,
  },
  geocoder: {
    label: 'Location exact', accuracy: 'from the address',
    hint: 'Found from the branch address, accurate to about 60 metres. Safe to plan and cost against.',
    color: 'var(--success)', bg: 'var(--status-active-bg)', needsFixing: false,
  },
  osm_poi: {
    label: 'Location exact', accuracy: 'branch is on the map',
    hint: 'This branch is marked on the map itself, accurate to about 10 metres. The most reliable automatic match.',
    color: 'var(--success)', bg: 'var(--status-active-bg)', needsFixing: false,
  },
  osm_building: {
    label: 'Location exact', accuracy: 'building found',
    hint: 'The building is on the map, accurate to about 25 metres. Safe to plan and cost against.',
    color: 'var(--success)', bg: 'var(--status-active-bg)', needsFixing: false,
  },
  osm_street: {
    label: 'Location close', accuracy: 'street found',
    hint: 'The right street was found but not the building — the pin can be about 120 metres off. Fine for travel costs; pin it by hand if you need the exact door.',
    color: 'var(--accent-secondary)', bg: 'var(--bg-surface-2)', needsFixing: false,
  },
  osm_locality: {
    label: 'Approximate (area only)', accuracy: 'neighbourhood',
    hint: 'Only the neighbourhood was found, so the pin can be about 900 metres from the branch. Travel time and distance will be roughly right, not exact.',
    color: 'var(--accent-secondary)', bg: 'var(--bg-surface-2)', needsFixing: false,
  },
  pincode: {
    label: 'Approximate (area only)', accuracy: 'PIN code',
    hint: 'Placed from the PIN code alone, so the pin can be about 3 km from the branch. Travel costs worked out from it will be approximate.',
    color: 'var(--warning)', bg: 'var(--status-pending-bg)', needsFixing: false,
  },
  // The two that are not locations at all — they are placeholders standing in for one.
  locality: {
    label: 'Not the branch location', accuracy: 'district centre',
    hint: 'This is the middle of the district, not the branch — the address could not be found. It can be 15 km out, so assayer matching and travel costs based on it may be wrong. Pin it by hand to fix.',
    color: 'var(--danger)', bg: 'var(--status-cancelled-bg)', needsFixing: true,
  },
  none: {
    label: 'Not the branch location', accuracy: 'state centre',
    hint: 'This is the middle of the state, not the branch — the address could not be found at all. It can be 100 km out, so assayer matching and travel costs based on it will be wrong. Pin it by hand to fix.',
    color: 'var(--danger)', bg: 'var(--status-cancelled-bg)', needsFixing: true,
  },
};

const UNKNOWN: TierStyle = {
  label: 'Location not confirmed',
  accuracy: '',
  hint: 'Nothing is recorded about where this pin came from, so there is no way to say how close it is. Treat it as unchecked and pin it by hand.',
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
      title={tier.hint + (matchedName ? `\n\nMatched to: ${matchedName}` : '')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontSize: compact ? '9px' : '9.5px',
        fontWeight: 700,
        padding: compact ? '1px 5px' : '2px 7px',
        borderRadius: '8px',
        background: tier.bg,
        color: tier.color,
        whiteSpace: 'nowrap',
        cursor: 'help',
      }}
    >
      {tier.needsFixing ? '⚠ ' : ''}{tier.label}
      {tier.accuracy && <span style={{ fontWeight: 600, opacity: 0.75 }}>· {tier.accuracy}</span>}
    </span>
  );
};
