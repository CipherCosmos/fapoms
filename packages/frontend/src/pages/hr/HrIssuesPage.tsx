import React from 'react';
import { Link } from 'react-router-dom';

import { ImportIssuesPanel } from './ImportIssuesPanel';
import { useImportIssues } from './useImportIssues';
import { useHr } from './HrLayout';
import { counted } from '../../utils/plural';

/**
 * The review queue, as a place you can go to.
 *
 * It had no destination at all. The panel rendered at the bottom of the roster, below the
 * import controls, collapsed, and returned `null` whenever nothing was open — so the only way to
 * discover that 431 record problems were waiting was to scroll past a thousand-row table on a
 * screen you had opened to do something else. Nothing in the navigation counted them, nothing
 * linked to them, and 283 of them had been sitting there since the roster was first imported.
 *
 * The work itself has not moved: this renders the same panel, so a decision made here and a
 * decision made on the roster are the same decision, recorded the same way. What is new is that
 * the queue can be reached deliberately, is open when you arrive, and answers you when it is
 * empty instead of showing a blank page.
 */
export const HrIssuesPage: React.FC = () => {
  const { canManage } = useHr();
  const { openCount, loading, failed } = useImportIssues();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div>
        <h2 style={{ fontSize: '17px', fontWeight: 700, margin: 0 }}>Review queue</h2>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '5px 0 0', lineHeight: 1.55, maxWidth: '760px' }}>
          {/*
            Two writers, one queue, and the distinction matters to whoever is clearing it: an
            import problem is about a cell in a spreadsheet somebody uploaded, a scan finding is
            about a record that is live right now. Neither ever changed anything on its own —
            which is why they are all still here waiting.

            Deliberately NOT a list of the checks. The scanner's set moves — four titles were
            added in the last change alone ("Home pin is a placeholder, not a home", "No home
            address on the record", "No phone number on the record", "Ticked as received, but no
            scan was kept") — and a hand-written list on this page is a list that goes stale
            silently. The findings themselves name their own check, and the two examples below
            are chosen as illustrations of the KIND of thing, not as an inventory.
          */}
          Everything the system found but would not decide for you: cells the roster import could
          not read, and things the standing data checks keep finding on live records — a missing
          date of birth, a home pin that is really the middle of a state, one bank account under
          two people. Nothing was guessed and nothing was changed automatically, so each one is
          here until somebody says what should happen to it.
        </p>
      </div>

      {!loading && !failed && openCount > 0 && (
        <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          {counted(openCount, 'problem is', 'problems are')} open.{' '}
          {canManage
            ? <>Open a person to correct their record, or decide a whole group at once where the same
                cell is wrong for everybody in it. Every close asks what was decided and keeps that
                on the record.</>
            : <>Closing these needs the workforce-management role, so they are shown here to read
                rather than to clear.</>}{' '}
          <Link to="/hr/roster" style={{ color: 'var(--accent)' }}>Back to the roster</Link>
        </div>
      )}

      <ImportIssuesPanel canManage={canManage} standalone />
    </div>
  );
};

export default HrIssuesPage;
