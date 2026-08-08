import React from 'react';
import { AssayerRoster } from './AssayerRoster';

/**
 * The roster: every assayer on the books, searchable, with bulk lifecycle actions.
 *
 * This was a tab; it is the page HR spends most of its day on, so it gets its own URL and can
 * be linked to directly from a worklist row elsewhere in the section.
 */
export const HrRosterPage: React.FC = () => <AssayerRoster />;
