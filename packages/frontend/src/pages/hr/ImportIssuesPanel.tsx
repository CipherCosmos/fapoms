import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ChevronDown, ChevronRight, Check, ExternalLink } from 'lucide-react';

import { api } from '../../services/api';
import { useToast, AlertBanner } from '../../components/ui';
import { label, Empty, Notice, LinkButton, fieldInput } from './hr-ui';
import { userMessage } from '../../services/errors';
import { counted } from '../../utils/plural';
import { useImportIssues, useRefreshImportIssues, type ImportIssue as Issue } from './useImportIssues';

/**
 * The review queue: cells the roster import could not read, and defects the standing
 * data-integrity scan keeps finding on live records — both waiting for somebody to decide.
 *
 * Neither writer guesses: the import keeps an unreadable cell with its original text, the scan
 * reports a contradiction (a leaving date on an active record, one PAN on two records) without
 * touching either record. This is where both land.
 *
 * **Grouped, not listed.** The same unreadable word repeats across hundreds of rows — 145 people
 * carry one variant, 25 another — and a flat list of them is a list nobody reads. One line per
 * distinct problem, with the count and the people behind it, so the decision is made once and
 * applied to everyone it touches.
 *
 * **The header owns up to what it cannot show.** The server caps the list at 500 rows; when the
 * open count exceeds what came back, the header says "showing X of Y" rather than letting the
 * missing rows vanish — the exact failure the old 200-row default caused, with 83 findings
 * invisible behind a headline that counted them.
 *
 * Closing an entry demands an account of what was decided. The queue exists because nothing was
 * guessed; closing one blank puts the guess back without a record of it, which the server also
 * refuses.
 */

interface Group {
  key: string;
  /** The heading: a spreadsheet column for import rows, a check title for scan findings. */
  column: string;
  rawValue: string;
  reason: string;
  /** True when this group came from the standing data-integrity scan rather than the importer. */
  fromScan: boolean;
  issues: Issue[];
}

/**
 * The sheet name the data-integrity scanner stamps on everything it writes.
 *
 * Mirrors `DATA_INTEGRITY_SHEET` in
 * `packages/backend/src/modules/assayer/data-integrity.service.ts`. It is the only thing that
 * separates a finding about a live record from a cell an import could not read, and the two need
 * grouping differently — see `checkTitle`.
 */
const DATA_INTEGRITY_SHEET = 'Data integrity';

/**
 * The name of the check, with the appraiser code the scanner appends stripped off.
 *
 * THE SCANNER KEYS ONE ROW PER PERSON PER CHECK. Its `source_column` is `"<title> · <code>"` —
 * "No date of birth · AS0088" — because the queue's unique constraint is on (sheet, column) and
 * each person's finding has to be resolvable on its own. Grouped on the raw column, therefore,
 * every one of the 133 scan findings is a group of exactly one, and the panel becomes the flat
 * list of 150-odd lines that grouping exists to prevent: 67 separate rows all saying "no date of
 * birth", each with one name beside it.
 *
 * Grouped on the title instead, "No date of birth" is one line with 67 people behind it, which
 * is both what a reader wants and what one decision actually covers. The code is not lost — it
 * is on the person chip, which is the link to their record.
 *
 * Importer rows have no suffix and are grouped on column AND raw value, unchanged: there the
 * distinct thing IS the unreadable text, and "Active / Inactive" holding "???" is a different
 * decision from the same column holding "N/A".
 */
const checkTitle = (sourceColumn: string): string => sourceColumn.split(' · ')[0];

export const ImportIssuesPanel: React.FC<{
  canManage: boolean;
  onResolved?: () => void;
  /**
   * Render the queue even when it is empty, already open.
   *
   * The panel returns null on an empty queue because it lives at the bottom of the roster, where
   * a permanent "nothing outstanding" card would be noise on a screen about people. Its own
   * page is the opposite case: somebody who clicked "Review queue" has asked the question, and
   * a blank page is not an answer.
   */
  standalone?: boolean;
}> = ({ canManage, onResolved, standalone = false }) => {
  const { rows: issues, openCount, loading, failed } = useImportIssues();
  const refreshQueue = useRefreshImportIssues();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(standalone);
  /**
   * What the last attempt to close this group ran into — one channel, not two.
   *
   * Either a group-close that did not close everything (see `resolveGroup`) or the one thing
   * the server will refuse outright: closing a cell without saying what was decided. Both are
   * the reader's next move, and both belong beside the form they are about rather than in a
   * toast that leaves the screen before the sentence is finished.
   */
  const [outcome, setOutcome] = useState<
    { kind: 'needs-account' } | { kind: 'partial'; closed: number; failed: { who: string; reason: string }[] } | null
  >(null);
  const { toast } = useToast();
  const navigate = useNavigate();

  const groups = useMemo<Group[]>(() => {
    const byKey = new Map<string, Group>();
    for (const i of issues ?? []) {
      // Grouped on what the problem *is* rather than on where it was found, because that is what
      // one decision covers. What counts as "the same problem" differs by writer — see
      // `checkTitle`: a scan finding is the check, an import cell is the column and its text.
      const fromScan = i.sourceSheet === DATA_INTEGRITY_SHEET;
      const title = fromScan ? checkTitle(i.sourceColumn) : i.sourceColumn;
      const key = fromScan ? `scan::${title}` : `import::${title}::${i.rawValue.toLowerCase()}`;
      const g = byKey.get(key) ?? {
        key, column: title, rawValue: i.rawValue, reason: i.reason, fromScan, issues: [],
      };
      g.issues.push(i);
      byKey.set(key, g);
    }
    return [...byKey.values()].sort((a, b) => b.issues.length - a.issues.length);
  }, [issues]);

  /**
   * Close every cell in one group, and say honestly what happened to each.
   *
   * This was a `for` loop of individual POSTs inside one `try`, so the FIRST failure threw and
   * everything after it was never attempted — while the ones before it had already been closed
   * on the server. A group of forty could end as "twelve closed, twenty-eight untouched", and
   * all the operator saw was a single red toast carrying whichever error happened to be
   * thrown. Pressing the button again then re-posted the twelve that had already worked.
   *
   * There is no batch endpoint (`POST /assayers/roster/import-issues/:id/resolve` takes one id;
   * adding a batch route is a backend change and is written up in the handover). So the calls
   * still go one at a time — but through `allSettled`, so a failure part-way stops nothing, and
   * the outcome is reported per cell: how many closed, and which people could not be, with the
   * server's reason against each. The queue is then re-read, so what is still on screen is what
   * is still open rather than this component's guess at it.
   */
  const resolveGroup = async (g: Group) => {
    const stated = resolution.trim();
    if (!stated) {
      setOutcome({ kind: 'needs-account' });
      return;
    }
    setBusy(true);
    setOutcome(null);
    const who = (i: Issue) => i.assayer?.assayerCode ?? i.sourceAssayerCode ?? `Row ${i.sourceRow}`;
    try {
      const outcomes = await Promise.allSettled(g.issues.map((i) =>
        api.request(`/assayers/roster/import-issues/${i.id}/resolve`, {
          method: 'POST', body: JSON.stringify({ resolution: stated }),
        })));

      const failures = outcomes.flatMap((o, idx) => (
        o.status === 'rejected'
          ? [{ who: who(g.issues[idx]), reason: userMessage(o.reason) }]
          : []));
      const closed = outcomes.length - failures.length;

      if (failures.length === 0) {
        toast({
          type: 'success',
          title: 'Closed',
          message: `${counted(closed, 'cell')} in “${g.column}” marked decided.`,
        });
        setExpanded(null);
        setResolution('');
      } else {
        // Stays on the page, with the group still open and the wording still typed, because the
        // reader has to decide what to do about the ones that did not close.
        setOutcome({ kind: 'partial', closed, failed: failures });
      }
      refreshQueue();
      onResolved?.();
    } finally { setBusy(false); }
  };

  /** Open a person's record so the flagged field can be corrected, then mark the cell decided. */
  const openRecord = (i: Issue) => {
    const id = i.assayer?.id;
    if (id) navigate(`/hr/roster/${id}`);
  };

  // Embedded under the roster: silent until there is something to review, and silent while the
  // first read is still in flight or was refused. On its own page (`standalone`) the question has
  // been asked out loud, so an empty queue is answered rather than shown as a blank screen.
  if (!standalone && (loading || failed || openCount === 0)) return null;

  return (
    <div style={{
      border: `1px solid ${openCount === 0 ? 'var(--border-color)' : 'var(--warning)'}`,
      borderRadius: '10px',
      background: 'var(--bg-card)', overflow: 'hidden',
    }}>
      <button
        onClick={() => setShow((s) => !s)}
        aria-expanded={show}
        style={{
          display: 'flex', alignItems: 'center', gap: '8px', width: '100%', textAlign: 'left',
          padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text-primary)', fontSize: '13px',
        }}
      >
        {openCount > 0
          ? <AlertTriangle size={15} style={{ color: 'var(--warning)', flexShrink: 0 }} />
          : <Check size={15} style={{ color: 'var(--success)', flexShrink: 0 }} />}
        <span style={{ flex: 1 }}>
          {openCount === 0 ? (
            <>
              <strong style={{ fontWeight: 600 }}>
                {loading ? 'Reading the review queue…' : failed ? 'The review queue could not be read.' : 'Nothing to review.'}
              </strong>{' '}
              <span style={{ color: 'var(--text-muted)' }}>
                {failed
                  ? 'You may not have permission to see it, or the server did not answer. Nothing has been lost.'
                  : 'Every problem the roster import and the standing data checks have found has been decided.'}
              </span>
            </>
          ) : (
            <>
              <strong style={{ fontWeight: 600 }}>
                {counted(openCount, 'record problem')} to review
                {/* Never hide rows silently: the server caps the list, so when the open count
                    exceeds what came back the headline says so instead of miscounting the body. */}
                {issues.length < openCount ? ` — showing ${issues.length} of ${openCount}` : ''}.
              </strong>{' '}
              <span style={{ color: 'var(--text-muted)' }}>
                {groups.length === 1 ? 'One distinct problem' : `${groups.length} distinct problems`} —
                cells the roster import could not read, and checks failing on live records.
                Nothing was guessed or changed automatically; each waits for a decision.
              </span>
            </>
          )}
        </span>
        {show ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>

      {show && openCount > 0 && (
        <div style={{ borderTop: '1px solid var(--border-hair)' }}>
          {/* The same "read this before you act on the list" block the rest of the section uses,
              rather than a tinted strip of this panel's own. */}
          <Notice tone="info" flush>
            Two ways to clear one: <strong style={{ color: 'var(--text-secondary)' }}>click a person</strong> to open their
            record and correct the field, then close it — or, when the same cell is wrong for everyone
            listed (a note that landed in the wrong column), <strong style={{ color: 'var(--text-secondary)' }}>decide the whole group at once</strong>.
          </Notice>
          {groups.length === 0 ? (
            <Empty>Nothing outstanding.</Empty>
          ) : groups.map((g) => (
            <div key={g.key} style={{ borderBottom: '1px solid var(--border-hair)', padding: '10px 14px' }}>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                <div style={{ ...label, minWidth: '150px' }}>{g.column}</div>
                <div style={{ fontSize: '13px', color: 'var(--text-primary)', flex: 1, minWidth: '220px' }}>
                  {/*
                    A scan finding says something different about each person it names — one has
                    no date of birth, another has one that makes them nine years old — so the
                    first row's sentence is an EXAMPLE, and printing it unlabelled would read as
                    a description of all 67. An import cell is the opposite: the same unreadable
                    text in the same column is what the whole group is about, so it is quoted.
                  */}
                  {g.fromScan ? (
                    g.issues.length === 1
                      ? g.reason
                      : <><span style={{ color: 'var(--text-muted)' }}>For example: </span>{g.reason}</>
                  ) : (
                    <>“{g.rawValue}” — {g.reason}</>
                  )}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {counted(g.issues.length, 'person', 'people')}
                </div>
              </div>

              {/*
                Each affected person is a link to their record, so a cell that is wrong for THAT
                person — a malformed PAN, an Aadhaar that is really a status note — gets corrected
                on the record and then closed here. A cell with no person behind it (an unheadered
                column, a skipped row) has nothing to open, so it stays plain text.
              */}
              <div style={{ marginTop: '6px', display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                {g.issues.slice(0, 20).map((i) => {
                  const who = i.assayer?.assayerCode ?? i.sourceAssayerCode ?? `Row ${i.sourceRow}`;
                  const clickable = !!i.assayer?.id;
                  return clickable ? (
                    <button
                      key={i.id}
                      onClick={() => openRecord(i)}
                      title={`Open ${who}'s record to correct it`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: '4px',
                        padding: '2px 8px', fontSize: '12px', fontWeight: 600,
                        background: 'var(--bg-surface)', color: 'var(--primary)',
                        border: '1px solid var(--border-color)', borderRadius: '999px', cursor: 'pointer',
                      }}
                    >
                      {who} <ExternalLink size={11} />
                    </button>
                  ) : (
                    <span key={i.id} style={{ padding: '2px 8px', fontSize: '12px', color: 'var(--text-muted)' }}>{who}</span>
                  );
                })}
                {g.issues.length > 20 && (
                  <span style={{ padding: '2px 4px', fontSize: '12px', color: 'var(--text-muted)' }}>
                    and {g.issues.length - 20} more
                  </span>
                )}
              </div>

              {canManage && (expanded === g.key ? (
                <>
                  <div style={{ marginTop: '9px', display: 'flex', gap: '8px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <input
                      autoFocus
                      value={resolution}
                      onChange={(e) => setResolution(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void resolveGroup(g); if (e.key === 'Escape') setExpanded(null); }}
                      placeholder="What was decided? e.g. “Availability note in the wrong column — ignore.”"
                      aria-label={`What was decided about the ${g.column} cells reading “${g.rawValue}”`}
                      style={{ ...fieldInput, flex: 1, minWidth: '260px', width: 'auto' }}
                    />
                    {/*
                      The app's own primary button. This was a fourth hand-written one — its own
                      padding, its own radius, its own disabled cursor — sitting a few pixels off
                      the primary buttons on every other HR screen.
                    */}
                    <button
                      onClick={() => void resolveGroup(g)}
                      disabled={busy}
                      className="btn btn-primary"
                      style={{ fontSize: '12px', padding: '8px 14px', display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}
                    >
                      <Check size={13} /> {busy ? 'Closing…' : `Close ${counted(g.issues.length, 'cell')}`}
                    </button>
                    <LinkButton
                      tone="muted"
                      onClick={() => { setExpanded(null); setResolution(''); setOutcome(null); }}
                    >
                      Cancel
                    </LinkButton>
                  </div>
                  {/*
                    A part-closed group, named cell by cell.

                    The old loop stopped at the first failure and reported one generic toast, so
                    "twelve closed, twenty-eight still open" looked identical to "nothing
                    closed". Whoever is on screen has to know which of the two happened before
                    they decide whether to press it again.
                  */}
                  {outcome && (
                    <AlertBanner type="error" onClose={() => setOutcome(null)} style={{ marginTop: '9px', alignItems: 'flex-start' }}>
                      {outcome.kind === 'needs-account' ? (
                        'Say what was decided about these cells before closing them — the queue exists because '
                        + 'nothing was guessed, and closing one blank puts the guess back with no record of it.'
                      ) : (
                        <>
                          <strong style={{ fontWeight: 600 }}>
                            {counted(outcome.closed, 'cell')} closed; {counted(outcome.failed.length, 'cell')} could not be.
                          </strong>
                          <div style={{ fontWeight: 400, marginTop: '3px' }}>
                            The ones that closed are gone from the list above and do not need doing again.
                          </div>
                          <ul style={{ margin: '6px 0 0', paddingLeft: '18px', fontWeight: 400, lineHeight: 1.5 }}>
                            {outcome.failed.slice(0, 8).map((f, i) => <li key={i}>{f.who} — {f.reason}</li>)}
                            {outcome.failed.length > 8 && <li>and {outcome.failed.length - 8} more</li>}
                          </ul>
                        </>
                      )}
                    </AlertBanner>
                  )}
                </>
              ) : (
                <LinkButton
                  onClick={() => { setExpanded(g.key); setResolution(''); setOutcome(null); }}
                  style={{ paddingTop: '6px' }}
                >
                  Decide this
                </LinkButton>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
