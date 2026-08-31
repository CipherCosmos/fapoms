import { AssayerLifecycleStatus, EmpanelmentStatus } from '@fapoms/shared';

/**
 * One colour per client, everywhere the map colours by bank.
 *
 * Assignment is by index over the clients IN THE CALLER'S ORDER (the map hands them in
 * alphabetically by name) — not a hash. With ~22 lenders on the real roster, hashing into a
 * palette collides almost surely (birthday bound), and two banks sharing a colour defeats the
 * entire point of the mode. Indexed assignment is collision-free up to the palette size, and
 * name order keeps a bank's colour stable and predictable across pages and reloads.
 *
 * The palette is ORDERED for adjacency: consecutive entries jump hue families (blue → rose →
 * green → amber → violet → cyan …), so the banks that sit next to each other alphabetically —
 * and therefore next to each other in the legend — can never come out in look-alike shades.
 * The first version grouped its hues (three greens, three blues in a row) and which bank got
 * which was uuid-ordered, i.e. random: two big lenders could easily land on near-identical
 * colours, which read as "the map doesn't colour the banks differently".
 */
export const CLIENT_COLOR_PALETTE: readonly string[] = [
  '#2563eb', // blue
  '#e11d48', // rose
  '#059669', // green
  '#f59e0b', // amber
  '#7c3aed', // violet
  '#06b6d4', // cyan
  '#db2777', // pink
  '#84cc16', // lime
  '#b91c1c', // dark red
  '#6366f1', // indigo
  '#0d9488', // teal
  '#ea580c', // orange
  '#a21caf', // fuchsia
  '#166534', // dark green
  '#38bdf8', // sky
  '#ca8a04', // dark yellow
  '#9333ea', // purple
  '#f43f5e', // light rose
  '#22c55e', // mid green
  '#78350f', // brown
  '#1e40af', // deep blue
  '#d946ef', // magenta
  '#047857', // pine
  '#facc15', // yellow
];

/** The colour of "no active bank standing" — matches the blocked-pin grey family, deliberately dull. */
export const NO_CLIENT_COLOR = '#64748b';

/** Stable colour lookup over the clients actually present, in the order the caller gives them. */
export function buildClientColorScale(clientIds: Iterable<string>): (clientId?: string | null) => string {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of clientIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  const byId = new Map(ordered.map((id, i) => [id, CLIENT_COLOR_PALETTE[i % CLIENT_COLOR_PALETTE.length]]));
  return (clientId) => (clientId && byId.get(clientId)) || NO_CLIENT_COLOR;
}

/** The spotlight colour — the ONE bank singled out on the map — and the muted colour every other bank shares. */
export const SPOTLIGHT_COLOR = '#e11d48';   // rose — the highlighted bank
export const OTHER_BANK_COLOR = '#2563eb';  // one blue for every other bank

/**
 * Colour ONE bank apart from the rest.
 *
 * The full per-bank palette answers "which of twenty lenders is this?"; this answers a sharper
 * question — "is this the bank I care about right now, or not?" The spotlit client takes the
 * rose; every other bank shares one blue; no active bank stays grey. `spotlightId` is resolved
 * from the data (by name — see the map), so nothing about a specific bank is baked in here.
 */
export function buildSpotlightColorScale(spotlightId: string | null): (clientId?: string | null) => string {
  // The spotlit bank is apart; EVERYONE else — other banks and no bank alike — shares the one
  // colour, so the map reads as "ICICI, or not". No-bank is not singled out with its own grey.
  return (clientId) => (spotlightId && clientId === spotlightId) ? SPOTLIGHT_COLOR : OTHER_BANK_COLOR;
}

export interface MapEmpanelment {
  clientId: string;
  clientName: string;
  status: string;
}

/** The standings that mean "can actually work for this bank" — the same pair the planning gate accepts. */
const QUALIFYING_STANDINGS = new Set<string>([EmpanelmentStatus.ACTIVE, EmpanelmentStatus.RECOMMENDED]);

export const isQualifyingStanding = (status?: string | null): boolean =>
  QUALIFYING_STANDINGS.has(status ?? '');

/**
 * The empanelment that colours the pin: an ACTIVE standing beats RECOMMENDED — and nothing
 * else counts at all. A person whose only record with a bank is REJECTED / RESIGNED /
 * TERMINATED / dormant does NOT belong to that bank on a capability map; falling back to
 * "first row" here once painted 655 ICICI-rejected-or-dormant people as ICICI's workforce
 * when the bank's real roster was 34. No qualifying standing = grey.
 */
export function bestEmpanelment(list?: MapEmpanelment[] | null): MapEmpanelment | null {
  if (!list?.length) return null;
  return (
    list.find((e) => e.status === EmpanelmentStatus.ACTIVE) ??
    list.find((e) => e.status === EmpanelmentStatus.RECOMMENDED) ??
    null
  );
}

/**
 * The four operational buckets the map filters assayers by — mirroring the way the branch
 * status filter groups its statuses rather than exposing eleven raw enum values.
 */
export const ASSAYER_LIFECYCLE_BUCKETS: ReadonlyArray<{ key: string; label: string; statuses: string[] }> = [
  { key: 'active', label: 'Active', statuses: [AssayerLifecycleStatus.ACTIVE] },
  {
    key: 'onboarding', label: 'Onboarding',
    statuses: [
      AssayerLifecycleStatus.INVITED,
      AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
      AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
      AssayerLifecycleStatus.TRAINING,
    ],
  },
  {
    key: 'paused', label: 'Paused',
    statuses: [
      AssayerLifecycleStatus.ON_LEAVE,
      AssayerLifecycleStatus.SUSPENDED,
      AssayerLifecycleStatus.INACTIVE,
    ],
  },
  {
    key: 'exited', label: 'Exited',
    statuses: [
      AssayerLifecycleStatus.RESIGNED,
      AssayerLifecycleStatus.TERMINATED,
      AssayerLifecycleStatus.ARCHIVED,
    ],
  },
];

/** Ring colour per lifecycle bucket — the map's pin ring AND the control panel's chips read from this one source, so they cannot drift. */
export const LIFECYCLE_RING_COLORS: Record<string, string> = {
  active: 'rgba(255,255,255,0.9)',
  onboarding: '#38bdf8',
  paused: '#f59e0b',
  exited: '#ef4444',
};

/** Chip tint per lifecycle bucket, for the pin popup. */
export const LIFECYCLE_BUCKET_TINT: Record<string, { bg: string; fg: string }> = {
  active: { bg: '#dcfce7', fg: '#166534' },
  onboarding: { bg: '#dbeafe', fg: '#1e40af' },
  paused: { bg: '#fef3c7', fg: '#92400e' },
  exited: { bg: '#fee2e2', fg: '#991b1b' },
};

export function lifecycleBucketOf(lifecycleStatus?: string | null): { key: string; label: string } {
  const bucket = ASSAYER_LIFECYCLE_BUCKETS.find((b) => b.statuses.includes(lifecycleStatus ?? ''));
  return bucket ?? { key: 'paused', label: lifecycleStatus || 'Unknown' };
}
