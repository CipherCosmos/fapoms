/**
 * FAPOMS — Canonical Geographic Regions
 *
 * `branches.region` was a free-text varchar and the data written into it disagreed with
 * itself: the demo seed wrote `'West'` / `'South'` / `'Central'`, while the RBL seed wrote
 * the *state name* into the same column. A region filter built on those values would show
 * "Maharashtra" and "West" as two sibling options and silently hide branches from whichever
 * convention the operator did not pick.
 *
 * This module is the single source of truth that resolves that: a closed enum of the six
 * regions Indian operations are actually organised into, and a state → region map that
 * derives the region from the one field that *is* reliably populated on every branch.
 *
 * Region is always derivable from state. Treat `resolveRegion(state)` as the authority and
 * `branches.region` as a materialised copy of it kept for indexed filtering — the migration
 * `NormalizeRegionsAndUserRegionScope` backfills it, and `BranchService` recomputes it on
 * every write.
 */

/** The six operational regions. Stored as-is in `branches.region` and `users.regions`. */
export enum Region {
  NORTH = 'NORTH',
  SOUTH = 'SOUTH',
  EAST = 'EAST',
  WEST = 'WEST',
  CENTRAL = 'CENTRAL',
  NORTH_EAST = 'NORTH_EAST',
}

/** Display labels, for dropdowns and table cells. */
export const REGION_LABELS: Record<Region, string> = {
  [Region.NORTH]: 'North',
  [Region.SOUTH]: 'South',
  [Region.EAST]: 'East',
  [Region.WEST]: 'West',
  [Region.CENTRAL]: 'Central',
  [Region.NORTH_EAST]: 'North East',
};

/** Stable display order — geographic, not alphabetical, so the list reads like a map legend. */
export const REGION_ORDER: Region[] = [
  Region.NORTH,
  Region.NORTH_EAST,
  Region.EAST,
  Region.CENTRAL,
  Region.WEST,
  Region.SOUTH,
];

/**
 * Every Indian state and union territory, mapped to its operational region.
 *
 * Keys are lower-cased and stripped of punctuation by `normalizeStateKey`, so the map
 * tolerates the spelling drift that real branch imports carry ("Orissa" vs "Odisha",
 * "Pondicherry" vs "Puducherry", "NCT of Delhi" vs "Delhi").
 */
const STATE_TO_REGION: Record<string, Region> = {
  // North
  'jammu and kashmir': Region.NORTH,
  'jammu kashmir': Region.NORTH,
  'j and k': Region.NORTH,
  'ladakh': Region.NORTH,
  'himachal pradesh': Region.NORTH,
  'punjab': Region.NORTH,
  'haryana': Region.NORTH,
  'uttarakhand': Region.NORTH,
  'uttaranchal': Region.NORTH,
  'delhi': Region.NORTH,
  'new delhi': Region.NORTH,
  'nct of delhi': Region.NORTH,
  'chandigarh': Region.NORTH,
  'uttar pradesh': Region.NORTH,
  'rajasthan': Region.NORTH,

  // North East
  'assam': Region.NORTH_EAST,
  'arunachal pradesh': Region.NORTH_EAST,
  'manipur': Region.NORTH_EAST,
  'meghalaya': Region.NORTH_EAST,
  'mizoram': Region.NORTH_EAST,
  'nagaland': Region.NORTH_EAST,
  'tripura': Region.NORTH_EAST,
  'sikkim': Region.NORTH_EAST,

  // East
  'west bengal': Region.EAST,
  'bihar': Region.EAST,
  'jharkhand': Region.EAST,
  'odisha': Region.EAST,
  'orissa': Region.EAST,
  'andaman and nicobar islands': Region.EAST,
  'andaman nicobar': Region.EAST,

  // Central
  'madhya pradesh': Region.CENTRAL,
  'chhattisgarh': Region.CENTRAL,
  'chattisgarh': Region.CENTRAL,

  // West
  'maharashtra': Region.WEST,
  'gujarat': Region.WEST,
  'goa': Region.WEST,
  'dadra and nagar haveli and daman and diu': Region.WEST,
  'dadra and nagar haveli': Region.WEST,
  'daman and diu': Region.WEST,

  // South
  'karnataka': Region.SOUTH,
  'kerala': Region.SOUTH,
  'tamil nadu': Region.SOUTH,
  'tamilnadu': Region.SOUTH,
  'andhra pradesh': Region.SOUTH,
  // Real spelling in the branch data: "ANDRAPRADESH". Kept as an explicit alias because the
  // despacing fallback below cannot recover a dropped 'h'.
  'andra pradesh': Region.SOUTH,
  'telangana': Region.SOUTH,
  'puducherry': Region.SOUTH,
  'pondicherry': Region.SOUTH,
  'lakshadweep': Region.SOUTH,
};

/**
 * Legacy region strings that predate this enum, mapped forward.
 *
 * The demo seed's `'West'` / `'South'` / `'Central'` land here. Kept separate from the state
 * map so a value that happens to be both (there are none today) stays unambiguous.
 */
const LEGACY_REGION_ALIASES: Record<string, Region> = {
  'north': Region.NORTH,
  'northern': Region.NORTH,
  'south': Region.SOUTH,
  'southern': Region.SOUTH,
  'east': Region.EAST,
  'eastern': Region.EAST,
  'west': Region.WEST,
  'western': Region.WEST,
  'central': Region.CENTRAL,
  'north east': Region.NORTH_EAST,
  'northeast': Region.NORTH_EAST,
  'north eastern': Region.NORTH_EAST,
  'ne': Region.NORTH_EAST,
};

/** Lower-case, collapse whitespace, drop punctuation — so "J&K." and "j and k" agree. */
function normalizeStateKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a region from a state name, a legacy region string, or an already-canonical value.
 *
 * Returns `null` rather than guessing when the input is unrecognised: a branch whose region
 * cannot be determined must stay visible under "All regions" and be fixed by a human, not be
 * silently filed under whichever region happened to sort first.
 */
export function resolveRegion(value: string | null | undefined): Region | null {
  if (!value) return null;

  const upper = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if ((Object.values(Region) as string[]).includes(upper)) return upper as Region;

  const key = normalizeStateKey(value);
  if (!key) return null;

  const exact = STATE_TO_REGION[key] ?? LEGACY_REGION_ALIASES[key];
  if (exact) return exact;

  // Branch imports routinely drop the space — "ANDRAPRADESH", "TAMILNADU", "WESTBENGAL".
  // Comparing with all spaces removed catches every such variant without needing an alias
  // per state, and cannot create a false match: no two entries collide once despaced.
  const despaced = key.replace(/\s/g, '');
  for (const [candidate, region] of [
    ...Object.entries(STATE_TO_REGION),
    ...Object.entries(LEGACY_REGION_ALIASES),
  ]) {
    if (candidate.replace(/\s/g, '') === despaced) return region;
  }

  return null;
}

/** True when `value` is one of the six canonical regions. */
export function isRegion(value: unknown): value is Region {
  return typeof value === 'string' && (Object.values(Region) as string[]).includes(value);
}

/** Display label for a stored region value, falling back to the raw string if unrecognised. */
export function regionLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return isRegion(value) ? REGION_LABELS[value] : value;
}

/** The state → region pairs, for the migration's backfill and for tests. */
export const STATE_REGION_PAIRS: ReadonlyArray<readonly [string, Region]> =
  Object.entries(STATE_TO_REGION) as ReadonlyArray<readonly [string, Region]>;

export const LEGACY_REGION_PAIRS: ReadonlyArray<readonly [string, Region]> =
  Object.entries(LEGACY_REGION_ALIASES) as ReadonlyArray<readonly [string, Region]>;
