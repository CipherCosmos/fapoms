/**
 * One word per thing on the Planning screen — and the two jobs it exists to do.
 *
 * This page offered a **Simple/Advanced** toggle and, inside Advanced, a six-item **Layout**
 * menu: Map + Drawer, Branch + Match, Branch + Map, 3 Column, Map Only, Day Plans. That is
 * eleven ways to arrange one screen, and it hid rather than revealed:
 *
 *  - In Simple — the default, so what most people saw — the layout menu did NOTHING.
 *    `effectiveLayout = advanced ? layout : 'two-col-branch-recom'` forced one arrangement, and
 *    that arrangement has **no map in it at all**. The interactive planning map was unreachable
 *    for a default user.
 *  - "Day Plans" is not a layout. It is a different JOB — cluster nearby branches and send one
 *    assayer to cover several in a day — 520 lines of it, filed in a display menu behind a mode
 *    toggle, where nobody looking for it would think to look.
 *  - The four remaining entries were genuine arrangements of the same two or three panels, and
 *    nobody had asked for the choice. One of them, "3 Column", was reachable another way
 *    entirely: pressing **Map** on a candidate silently rewrote the page's layout setting to
 *    reveal the map, which is a global preference being used as a local toggle.
 *
 * So: name the jobs, and let the map be a panel you open rather than an arrangement you choose.
 * Same method as `billing/vocabulary.ts` — plain words for what the thing IS to the person
 * looking at it, never the shape of the code behind it.
 */

/** What a planner is actually doing when they open this screen. */
export const PLANNING_JOBS = [
  {
    key: 'branch' as const,
    label: 'Staff a branch',
    /** The one-line answer to "what is this for?", shown under the tab. */
    hint: 'Take the branches waiting for an audit, one at a time, and put the right assayer on each.',
  },
  {
    key: 'day' as const,
    label: 'Plan a day',
    hint: 'Group branches that sit near each other so one assayer can cover several in a single day.',
  },
] as const;

export type PlanningJob = (typeof PLANNING_JOBS)[number]['key'];

/** The job a fresh visitor lands on: the everyday one. */
export const DEFAULT_PLANNING_JOB: PlanningJob = 'branch';

/** Remembered per person, so the tab they work in is the tab they come back to. */
export const PLANNING_JOB_STORAGE_KEY = 'planning_job';

export const planningJobLabel = (key: string): string =>
  PLANNING_JOBS.find((j) => j.key === key)?.label ?? key;

export const planningJobHint = (key: string): string =>
  PLANNING_JOBS.find((j) => j.key === key)?.hint ?? '';

/**
 * The map is a panel, not a layout.
 *
 * Kept beside the jobs on purpose: it is the one thing that used to be five of the six layout
 * entries, and stating here that it is a toggle is what stops it becoming an arrangement again.
 */
export const MAP_PANEL = {
  label: 'Map',
  showHint: 'Show where this branch and its candidates are',
  hideHint: 'Hide the map and give the candidate list the full width',
  storageKey: 'planning_showMap',
} as const;

/** What the rate card read, for the form to show as a reference. */
export interface FeeReference {
  total: number;
  usedFallbackBaseFee?: boolean;
}

/**
 * What the rate card SUGGESTS — a reading the desk compares against, never a decision.
 *
 * The owner's rule (2026-09-21): the desk agrees ONE number on a phone call and types it, and
 * "internally we'll keep the record of base fee and travel fee of each assignment based on the
 * base fee set for an assayer". So the form asks for one figure and this line offers one figure.
 * The split is not the operator's problem: billing carves it from that assayer's own audit fee
 * (`assignment-money.ts`), which is a fact about the person, not something to re-enter here.
 *
 * The platform-default caveat stays, because it changes what the suggestion is WORTH: a figure
 * derived from a rate nobody contracted is a weaker starting point than one that was.
 */
export function feeReferenceLine(quote: FeeReference | null): string {
  if (!quote) {
    // Never invent a figure. The desk can still type one; they just have no reading to compare
    // it against.
    return 'The rate card could not be read just now — type the fee you agreed.';
  }
  const total = `₹${Math.round(Number(quote.total) || 0).toLocaleString('en-IN')}`;
  return quote.usedFallbackBaseFee
    ? `Rate card suggests ${total} — but this assayer has no contracted rate on file, so that uses the platform default.`
    : `Rate card suggests ${total}.`;
}
