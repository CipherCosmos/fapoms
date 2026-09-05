import React from 'react';
import { AssayerRoster } from './AssayerRoster';
import { useHr } from './HrLayout';

/**
 * The roster: every assayer on the books, searchable, with bulk lifecycle actions.
 *
 * This was a tab; it is the page HR spends most of its day on, so it gets its own URL and can
 * be linked to directly from a worklist row elsewhere in the section.
 */
/**
 * Every chip is the overview's own count now, not a tally of whatever page the roster happened to
 * have loaded.
 *
 * This used to borrow exactly two aggregates (`workByOthersCount`, the expired-certificate count)
 * because those were the only two the compliance-flag reasoning above once called out by name —
 * every other chip counted the loaded window and said so. `data.segments` is the workforce
 * overview's answer for EVERY `ROSTER_SEGMENTS` key, keyed identically
 * (`all`/`active`/`onboarding`/`to-verify`/…), so passing the whole map is what makes every chip —
 * not just two of them — describe the same scoped population as the header above it.
 *
 * `data.segments` is optional on `HrWorkforceOverview`: it is a pending backend contract addition
 * landing alongside this frontend change, so a server that has not shipped it yet simply sends no
 * `segments` key, `exactCounts` is `undefined`, and `AssayerRoster` falls back to counting its own
 * loaded rows exactly as it always has — nothing breaks while the two tracks land in parallel.
 */
export const HrRosterPage: React.FC = () => {
  const { data } = useHr();
  return <AssayerRoster exactCounts={data?.segments} />;
};
