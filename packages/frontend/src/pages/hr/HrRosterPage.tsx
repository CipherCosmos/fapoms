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
 * The roster asks the server for a page of people and counts *those* for its filter chips, which
 * the page says plainly. That is tolerable for "how many have no skills recorded" and not for a
 * compliance flag, where a number short of the truth reads as the whole of it. The overview
 * payload this section already loads carries the real aggregate, so the chip borrows it.
 */
export const HrRosterPage: React.FC = () => {
  const { data } = useHr();
  return <AssayerRoster exactCounts={{ 'someone-else': data?.compliance?.workByOthersCount }} />;
};
