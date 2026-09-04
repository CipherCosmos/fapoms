import { Region, REGION_ORDER, resolveRegion } from '@fapoms/shared';

/**
 * `preferredRegions` as this screen edits it: the six canonical regions the assayer has
 * actually ticked, plus whatever the stored value carried that is not one of them.
 *
 * Kept as two lists rather than one, because they are handled differently on screen: `selected`
 * drives the tick-list, `legacy` is rendered as its own "as recorded" row so an existing value
 * this picker cannot represent is still visible and still round-trips on save instead of being
 * silently dropped. See the module comment on `parsePreferredRegions` for why a value is sorted
 * into one list or the other.
 */
export interface ParsedPreferredRegions {
  selected: Region[];
  legacy: string[];
}

function splitTokens(value: string | null | undefined): string[] {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse the comma-joined string this screen stores `preferredRegions` as.
 *
 * A token is only ever treated as one of the six canonical regions when it IS one already,
 * ignoring case and dashes/spaces (`resolveRegion` normalises "north-east" and "NORTH EAST" to
 * `NORTH_EAST` the same way it normalises the literal enum value). Deliberately NOT accepting a
 * token that merely resolves to a region through a state name or a legacy word like "Western" -
 * `resolveRegion("Maharashtra")` returns `WEST`, but silently rewriting a profile's stored text
 * that way is exactly the kind of invisible reinterpretation this feature exists to avoid. A
 * stored value this rule cannot place goes into `legacy` and is shown, not guessed at.
 */
export function parsePreferredRegions(value: string | null | undefined): ParsedPreferredRegions {
  const tokens = splitTokens(value);
  const selectedSet = new Set<Region>();
  const legacy: string[] = [];

  for (const token of tokens) {
    const normalised = token.toUpperCase().replace(/[\s-]+/g, '_');
    const region = resolveRegion(token);
    if (region && region === normalised) {
      selectedSet.add(region);
    } else {
      legacy.push(token);
    }
  }

  return { selected: REGION_ORDER.filter((r) => selectedSet.has(r)), legacy };
}

/** Rejoin a parsed selection back into the comma-joined string the screen stores. Canonical
 *  regions always precede legacy tokens, in the same geographic order the picker lists them, so
 *  saving without touching anything reproduces a stable value rather than reshuffling on every
 *  round trip. */
export function composePreferredRegions(parsed: ParsedPreferredRegions): string {
  return [...REGION_ORDER.filter((r) => parsed.selected.includes(r)), ...parsed.legacy].join(', ');
}

/** Add or remove one region from the selection, keeping `legacy` untouched. */
export function toggleRegionSelection(parsed: ParsedPreferredRegions, region: Region): ParsedPreferredRegions {
  const has = parsed.selected.includes(region);
  return {
    selected: has ? parsed.selected.filter((r) => r !== region) : [...parsed.selected, region],
    legacy: parsed.legacy,
  };
}

/** Drop one off-list value the assayer has chosen to remove, keeping `selected` untouched. */
export function removeLegacyRegionValue(parsed: ParsedPreferredRegions, token: string): ParsedPreferredRegions {
  return { selected: parsed.selected, legacy: parsed.legacy.filter((t) => t !== token) };
}
