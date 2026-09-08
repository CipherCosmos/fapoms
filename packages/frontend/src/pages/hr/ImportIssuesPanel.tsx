import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ChevronDown, ChevronRight, Check, ExternalLink, Users, ListChecks } from 'lucide-react';

import { api } from '../../services/api';
import { useToast, AlertBanner } from '../../components/ui';
import { Empty, Notice, fieldInput } from './hr-ui';
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
 * MASTER/DETAIL, IN TWO VIEWS. The panel used to print every group fully expanded — reason,
 * twenty person pills, resolve form — so 150 groups ran to an endless page nobody could work.
 * Now the left is a compact list of one-line rows and the right is the workspace for the one
 * selected row.
 *
 * Two views because the queue is written per person per check, and each shapes a different
 * job: "By problem" groups one decision across everyone it touches (one unreadable word in a
 * column, decided once); "By person" gathers everything open against one person, because a
 * clerk holding their record wants to clear the whole file in one pass rather than meet the
 * same person under five different headings.
 *
 * **Grouped, not listed.** The same unreadable word repeats across hundreds of rows, and a
 * flat list of them is a list nobody reads. One line per distinct problem, with the count and
 * the people behind it, so the decision is made once and applied to everyone it touches.
 *
 * **The header owns up to what it cannot show.** The server caps the list at 500 rows; when the
 * open count exceeds what came back, the header says "showing X of Y" rather than letting the
 * missing rows vanish.
 *
 * Closing entries demands an account of what was decided. The queue exists because nothing was
 * guessed; closing blank puts the guess back without a record of it, which the server refuses.
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

interface PersonBucket {
  key: string;
  code: string;
  name: string | null;
  assayerId: string | null;
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
 * list of 150-odd lines that grouping exists to prevent.
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

/** "No date of birth" for a scan finding, the column for an import cell. */
const problemTitle = (g: Group): string => g.column;

/** Who an issue is about, in words. */
const whoOf = (i: Issue): string =>
  i.assayer?.assayerCode ?? i.sourceAssayerCode ?? `Row ${i.sourceRow}`;

const personNameOf = (i: Issue): string | null => {
  const a = i.assayer as { firstName?: string; lastName?: string } | undefined;
  const full = `${a?.firstName ?? ''} ${a?.lastName ?? ''}`.trim();
  return full || null;
};

/**
 * Close every entry in one decision, and say honestly what happened to each.
 *
 * There is no batch endpoint (`POST /assayers/roster/import-issues/:id/resolve` takes one id),
 * so the calls still go one at a time — but through `allSettled`, so a failure part-way stops
 * nothing, and the outcome is reported per entry: how many closed, and which ones could not be,
 * with the server's reason against each.
 */
async function closeIssues(
  issues: Issue[],
  stated: string,
): Promise<{ closed: number; failed: { who: string; reason: string }[] }> {
  const outcomes = await Promise.allSettled(issues.map((i) =>
    api.request(`/assayers/roster/import-issues/${i.id}/resolve`, {
      method: 'POST', body: JSON.stringify({ resolution: stated }),
    })));
  const failed = outcomes.flatMap((o, idx) => (
    o.status === 'rejected'
      ? [{ who: whoOf(issues[idx]), reason: userMessage(o.reason) }]
      : []));
  return { closed: outcomes.length - failed.length, failed };
}

/** Import cell or standing data check — the two writers of this queue, told apart at a glance. */
const WriterTag: React.FC<{ fromScan: boolean }> = ({ fromScan }) => (
  <span
    title={fromScan ? 'Found by the standing data-integrity scan on a live record' : 'A cell the roster import could not read'}
    style={{
      fontSize: '11px', fontWeight: 700, padding: '1px 7px', borderRadius: '999px', whiteSpace: 'nowrap',
      border: '1px solid var(--border-color)', color: 'var(--text-muted)', flexShrink: 0,
    }}
  >
    {fromScan ? 'Data check' : 'Import'}
  </span>
);

const CountBadge: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{
    fontSize: '12px', fontWeight: 700, padding: '1px 7px', borderRadius: '9px', whiteSpace: 'nowrap',
    background: 'var(--bg-surface-2)', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
  }}>
    {children}
  </span>
);

const rowButtonStyle = (selected: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: '8px', width: '100%', textAlign: 'left',
  padding: '8px 10px', borderRadius: '8px', cursor: 'pointer',
  border: `1px solid ${selected ? 'var(--accent)' : 'transparent'}`,
  background: selected ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent',
  color: 'var(--text-primary)',
});

/**
 * The decision form both detail panels share: what was decided, and the button that files it
 * against every open entry shown. Blank is refused here, in the form — closing one blank puts
 * the queue's founding guess back with no record of it, which the server also refuses.
 */
const ResolveForm: React.FC<{
  closeLabel: string;
  busy: boolean;
  onClose: (stated: string) => void;
}> = ({ closeLabel, busy, onClose }) => {
  const [text, setText] = useState('');
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onClose(text); }}
        placeholder="What was decided? e.g. “Availability note in the wrong column — ignore.”"
        aria-label="What was decided"
        style={{ ...fieldInput, flex: 1, minWidth: '220px', width: 'auto' }}
      />
      <button
        onClick={() => onClose(text)}
        disabled={busy}
        className="btn btn-primary"
        style={{ fontSize: '12px', padding: '8px 14px', display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}
      >
        <Check size={13} /> {busy ? 'Closing…' : closeLabel}
      </button>
    </div>
  );
};

/**
 * A part-closed decision, named entry by entry.
 *
 * The old loop stopped at the first failure and reported one generic toast, so "twelve closed,
 * twenty-eight still open" looked identical to "nothing closed". Whoever is on screen has to
 * know which of the two happened before they decide whether to press it again.
 */
const PartialOutcome: React.FC<{
  closed: number;
  failed: { who: string; reason: string }[];
  onClose: () => void;
}> = ({ closed, failed, onClose }) => (
  <AlertBanner type="error" onClose={onClose} style={{ marginTop: '9px', alignItems: 'flex-start' }}>
    <strong style={{ fontWeight: 600 }}>
      {counted(closed, 'cell')} closed; {counted(failed.length, 'cell')} could not be.
    </strong>
    <div style={{ fontWeight: 400, marginTop: '3px' }}>
      The ones that closed are gone from the list above and do not need doing again.
    </div>
    <ul style={{ margin: '6px 0 0', paddingLeft: '18px', fontWeight: 400, lineHeight: 1.5 }}>
      {failed.slice(0, 8).map((f, i) => <li key={i}>{f.who} — {f.reason}</li>)}
      {failed.length > 8 && <li>and {failed.length - 8} more</li>}
    </ul>
  </AlertBanner>
);

/** Every person behind one problem, each a link to their record. */
const PersonPills: React.FC<{ issues: Issue[]; onOpen: (i: Issue) => void }> = ({ issues, onOpen }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', maxHeight: '148px', overflowY: 'auto' }}>
    {issues.map((i) => {
      const who = whoOf(i);
      return i.assayer?.id ? (
        <button
          key={i.id}
          onClick={() => onOpen(i)}
          title={`Open ${who}'s record to correct it`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            padding: '5px 10px', fontSize: '12px', fontWeight: 600,
            background: 'var(--bg-surface)', color: 'var(--primary)',
            border: '1px solid var(--border-color)', borderRadius: '999px', cursor: 'pointer',
          }}
        >
          {who} <ExternalLink size={11} />
        </button>
      ) : (
        <span key={i.id} style={{ padding: '5px 10px', fontSize: '12px', color: 'var(--text-muted)' }}>{who}</span>
      );
    })}
  </div>
);

/** The workspace for one selected problem: what it means, who it touches, and the decision. */
const ProblemDetail: React.FC<{
  group: Group;
  canManage: boolean;
  onOpenRecord: (i: Issue) => void;
  onDone: () => void;
}> = ({ group, canManage, onOpenRecord, onDone }) => {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<
    { kind: 'needs-account' } | { kind: 'partial'; closed: number; failed: { who: string; reason: string }[] } | null
  >(null);

  const submit = async (stated: string) => {
    if (!stated.trim()) {
      setOutcome({ kind: 'needs-account' });
      return;
    }
    setBusy(true);
    setOutcome(null);
    try {
      const { closed, failed } = await closeIssues(group.issues, stated.trim());
      if (failed.length === 0) {
        toast({
          type: 'success',
          title: 'Closed',
          message: `${counted(closed, 'cell')} in “${group.column}” marked decided.`,
        });
      } else {
        // Stays on screen, because the reader has to decide what to do about the ones that
        // did not close.
        setOutcome({ kind: 'partial', closed, failed });
      }
      onDone();
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{problemTitle(group)}</span>
        <WriterTag fromScan={group.fromScan} />
        <CountBadge>{counted(group.issues.length, 'person', 'people')}</CountBadge>
      </div>
      <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
        {/*
          A scan finding says something different about each person it names — one has no date
          of birth, another has one that makes them nine years old — so the first row's
          sentence is an EXAMPLE, and printing it unlabelled would read as a description of
          all 67. An import cell is the opposite: the same unreadable text in the same column
          is what the whole group is about, so it is quoted.
        */}
        {group.fromScan ? (
          group.issues.length === 1
            ? group.reason
            : <><span style={{ color: 'var(--text-muted)' }}>For example: </span>{group.reason}</>
        ) : (
          <>“{group.rawValue}” — {group.reason}</>
        )}
      </div>
      <PersonPills issues={group.issues} onOpen={onOpenRecord} />
      {canManage ? (
        <>
          <ResolveForm
            closeLabel={`Close ${counted(group.issues.length, 'cell')}`}
            busy={busy}
            onClose={(stated) => void submit(stated)}
          />
          {outcome && (
            outcome.kind === 'needs-account' ? (
              <AlertBanner
                type="error"
                onClose={() => setOutcome(null)}
                style={{ alignItems: 'flex-start' }}
                message="Say what was decided about these cells before closing them — the queue exists because nothing was guessed, and closing one blank puts the guess back with no record of it."
              />
            ) : (
              <PartialOutcome closed={outcome.closed} failed={outcome.failed} onClose={() => setOutcome(null)} />
            )
          )}
        </>
      ) : (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Closing these needs the workforce-management role, so they are shown here to read rather than to clear.
        </div>
      )}
    </div>
  );
};

/** The workspace for one selected person: everything open against them, cleared in one pass. */
const PersonDetail: React.FC<{
  person: PersonBucket;
  canManage: boolean;
  onOpenRecord: (i: Issue) => void;
  onDone: () => void;
}> = ({ person, canManage, onOpenRecord, onDone }) => {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<
    { kind: 'needs-account' } | { kind: 'partial'; closed: number; failed: { who: string; reason: string }[] } | null
  >(null);

  const titleOf = (i: Issue): string => {
    const fromScan = i.sourceSheet === DATA_INTEGRITY_SHEET;
    return fromScan ? checkTitle(i.sourceColumn) : i.sourceColumn;
  };

  const submit = async (stated: string) => {
    if (!stated.trim()) {
      setOutcome({ kind: 'needs-account' });
      return;
    }
    setBusy(true);
    setOutcome(null);
    try {
      const { closed, failed } = await closeIssues(person.issues, stated.trim());
      if (failed.length === 0) {
        toast({
          type: 'success',
          title: 'Closed',
          message: `${counted(closed, 'open issue')} for ${person.code} marked decided.`,
        });
      } else {
        setOutcome({ kind: 'partial', closed, failed });
      }
      onDone();
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
          {person.code}{person.name ? ` — ${person.name}` : ''}
        </span>
        <CountBadge>{counted(person.issues.length, 'open issue')}</CountBadge>
        {person.assayerId && (
          <button
            type="button"
            onClick={() => onOpenRecord(person.issues[0])}
            title={`Open ${person.code}'s record to correct these fields`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'none',
              border: 'none', cursor: 'pointer', padding: '5px 4px',
              color: 'var(--accent)', fontSize: '12px', fontWeight: 600,
            }}
          >
            Open record <ExternalLink size={11} />
          </button>
        )}
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '7px' }}>
        {person.issues.map((i) => {
          const fromScan = i.sourceSheet === DATA_INTEGRITY_SHEET;
          return (
            <li
              key={i.id}
              style={{
                display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '12.5px',
                padding: '7px 10px', borderRadius: '7px', background: 'var(--bg-surface-2)',
              }}
            >
              <span style={{ fontWeight: 600, color: 'var(--text-primary)', flexShrink: 0 }}>{titleOf(i)}</span>
              <WriterTag fromScan={fromScan} />
              <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {fromScan ? i.reason : `“${i.rawValue}”`}
              </span>
            </li>
          );
        })}
      </ul>
      {canManage ? (
        <>
          <ResolveForm
            closeLabel={`Close ${counted(person.issues.length, 'issue')}`}
            busy={busy}
            onClose={(stated) => void submit(stated)}
          />
          {outcome && (
            outcome.kind === 'needs-account' ? (
              <AlertBanner
                type="error"
                onClose={() => setOutcome(null)}
                style={{ alignItems: 'flex-start' }}
                message="Say what was decided before closing these — the queue exists because nothing was guessed, and closing blank puts the guess back with no record of it."
              />
            ) : (
              <PartialOutcome closed={outcome.closed} failed={outcome.failed} onClose={() => setOutcome(null)} />
            )
          )}
        </>
      ) : (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Closing these needs the workforce-management role, so they are shown here to read rather than to clear.
        </div>
      )}
    </div>
  );
};

type QueueView = 'problem' | 'person';

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
  const [show, setShow] = useState(standalone);
  const [view, setView] = useState<QueueView>('problem');
  const [query, setQuery] = useState('');
  /** Import cells, data checks, or everything — the two writers clear differently. */
  const [writer, setWriter] = useState<'all' | 'import' | 'scan'>('all');
  /** Biggest group first answers "where is the work"; A–Z answers "is the PAN problem cleared". */
  const [sort, setSort] = useState<'biggest' | 'az'>('biggest');
  const [selectedProblem, setSelectedProblem] = useState<string | null>(null);
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
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
    return [...byKey.values()];
  }, [issues]);

  /**
   * The same queue, filed by who it is about. The writers key one row per person per check, so
   * one person lands under as many headings as they have problems — "AS0001" beside five
   * different checks reads as five people with one problem each. Filed by person, each one
   * appears once with everything open against them, which is the shape the fix takes too: open
   * the record once, correct every flagged field, close the file in one pass.
   *
   * Cells with nobody behind them (an unheadered column, a skipped row) file under "No person
   * attached" rather than vanishing from this view.
   */
  const people = useMemo<PersonBucket[]>(() => {
    const byKey = new Map<string, PersonBucket>();
    for (const i of issues ?? []) {
      const code = i.assayer?.assayerCode ?? i.sourceAssayerCode ?? null;
      const key = i.assayer?.id ?? (code ? `code:${code}` : `row:${i.sourceRow}`);
      const b = byKey.get(key) ?? {
        key,
        code: code ?? `Row ${i.sourceRow}`,
        name: personNameOf(i),
        assayerId: i.assayer?.id ?? null,
        issues: [],
      };
      b.issues.push(i);
      byKey.set(key, b);
    }
    return [...byKey.values()].sort((a, b) => b.issues.length - a.issues.length || a.code.localeCompare(b.code));
  }, [issues]);

  const writerCounts = useMemo(() => {
    const importIssues = groups.filter((g) => !g.fromScan).reduce((n, g) => n + g.issues.length, 0);
    const scanIssues = groups.filter((g) => g.fromScan).reduce((n, g) => n + g.issues.length, 0);
    return { importIssues, scanIssues };
  }, [groups]);

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = groups.filter((g) => {
      if (writer === 'import' && g.fromScan) return false;
      if (writer === 'scan' && !g.fromScan) return false;
      if (!q) return true;
      return `${g.column} ${g.rawValue} ${g.reason}`.toLowerCase().includes(q);
    });
    return [...matching].sort((a, b) => (
      sort === 'az'
        ? a.column.localeCompare(b.column)
        : b.issues.length - a.issues.length || a.column.localeCompare(b.column)
    ));
  }, [groups, query, writer, sort]);

  const visiblePeople = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter((p) =>
      `${p.code} ${p.name ?? ''} ${p.issues.map((i) => `${i.sourceColumn} ${i.reason}`).join(' ')}`
        .toLowerCase().includes(q));
  }, [people, query]);

  /** Open a person's record so the flagged fields can be corrected, then mark them decided. */
  const openRecord = (i: Issue) => {
    const id = i.assayer?.id;
    if (id) navigate(`/hr/roster/${id}`);
  };

  const onDone = () => {
    void refreshQueue();
    onResolved?.();
  };

  // Embedded under the roster: silent until there is something to review, and silent while the
  // first read is still in flight or was refused. On its own page (`standalone`) the question has
  // been asked out loud, so an empty queue is answered rather than shown as a blank screen.
  if (!standalone && (loading || failed || openCount === 0)) return null;

  const activeGroup = visibleGroups.find((g) => g.key === selectedProblem) ?? visibleGroups[0] ?? null;
  const activePerson = visiblePeople.find((p) => p.key === selectedPerson) ?? visiblePeople[0] ?? null;
  const q = query.trim();

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
              </strong>
              <br />
              <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                {groups.length === 1 ? 'One distinct problem' : `${groups.length} distinct problems`}
                {/* The grouping below only ever sees the page of rows that arrived — the same
                    shortfall the headline above admits to. "3 distinct problems" over a capped
                    page reads as the whole roster's tally; it is only this page's. */}
                {issues.length < openCount ? ' in this page' : ''} — import cells and checks
                failing on live records; each waits for a decision.
              </span>
            </>
          )}
        </span>
        {show ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>

      {show && openCount > 0 && (
        <div style={{ borderTop: '1px solid var(--border-hair)', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* The same "read this before you act on the list" block the rest of the section uses,
              rather than a tinted strip of this panel's own. */}
          <Notice tone="info" flush>
            Open a person to correct their record, or decide a whole problem — or a whole
            person — at once when one decision covers everything listed.
          </Notice>

          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
            {([
              { key: 'problem', label: 'By problem', Icon: ListChecks },
              { key: 'person', label: 'By person', Icon: Users },
            ] as const).map(({ key, label, Icon }) => {
              const on = view === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setView(key)}
                  aria-pressed={on}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '6px',
                    padding: '6px 12px', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer',
                    borderRadius: '7px',
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--border-color)'}`,
                    background: on ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                    color: on ? 'var(--accent)' : 'var(--text-secondary)',
                  }}
                >
                  <Icon size={13} /> {label}
                </button>
              );
            })}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={view === 'problem' ? 'Find a problem — a check, a column, or the unreadable text…' : 'Find a person — a name, a code, or a problem…'}
              aria-label={view === 'problem' ? 'Find a problem in the review queue' : 'Find a person in the review queue'}
              style={{
                flex: '1 1 220px', minWidth: '180px', padding: '7px 10px', fontSize: '12.5px',
                borderRadius: '7px', border: '1px solid var(--border-color)',
                background: 'var(--bg-surface)', color: 'var(--text-primary)', outline: 'none',
              }}
            />
          </div>

          {view === 'problem' && (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
              {([
                { key: 'all', label: `All · ${openCount}` },
                { key: 'import', label: `Import cells · ${writerCounts.importIssues}` },
                { key: 'scan', label: `Data checks · ${writerCounts.scanIssues}` },
              ] as const).map((f) => {
                const on = writer === f.key;
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setWriter(f.key)}
                    aria-pressed={on}
                    style={{
                      padding: '5px 10px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                      borderRadius: '999px',
                      border: `1px solid ${on ? 'var(--accent)' : 'var(--border-color)'}`,
                      background: on ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                      color: on ? 'var(--accent)' : 'var(--text-secondary)',
                    }}
                  >
                    {f.label}
                  </button>
                );
              })}
              <span style={{ flex: 1 }} />
              {(['biggest', 'az'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSort(s)}
                  aria-pressed={sort === s}
                  title={s === 'biggest' ? 'Biggest groups first' : 'Alphabetical by problem'}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer', padding: '5px 4px',
                    fontSize: '12px', fontWeight: 700,
                    color: sort === s ? 'var(--accent)' : 'var(--text-muted)',
                    textDecoration: sort === s ? 'underline' : 'none',
                  }}
                >
                  {s === 'biggest' ? 'Biggest first' : 'A–Z'}
                </button>
              ))}
            </div>
          )}

          {q && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {view === 'problem'
                ? (visibleGroups.length === 0
                  ? 'No problem here matches that.'
                  : `${counted(visibleGroups.length, 'matching problem')} — the rest are hidden, not closed.`)
                : (visiblePeople.length === 0
                  ? 'Nobody here matches that.'
                  : `${counted(visiblePeople.length, 'matching person', 'matching people')} — the rest are hidden, not closed.`)}
            </div>
          )}

          {view === 'problem' ? (
            visibleGroups.length === 0 && !q ? (
              <Empty>Nothing outstanding.</Empty>
            ) : (
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div data-testid="queue-group-list" style={{ flex: '1 1 260px', minWidth: '220px', display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '380px', overflowY: 'auto' }}>
                  {visibleGroups.map((g) => {
                    const on = activeGroup?.key === g.key;
                    return (
                      <button
                        key={g.key}
                        type="button"
                        onClick={() => setSelectedProblem(g.key)}
                        aria-pressed={on}
                        style={rowButtonStyle(on)}
                      >
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {g.column}
                          </span>
                          {!g.fromScan && (
                            <span style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              “{g.rawValue}” — {g.reason}
                            </span>
                          )}
                        </span>
                        <WriterTag fromScan={g.fromScan} />
                        <CountBadge>{counted(g.issues.length, 'person', 'people')}</CountBadge>
                      </button>
                    );
                  })}
                </div>
                <div data-testid="queue-group-detail" style={{ flex: '2 1 340px', minWidth: '260px', borderLeft: '1px solid var(--border-hair)', paddingLeft: '12px' }}>
                  {activeGroup ? (
                    <ProblemDetail
                      key={activeGroup.key}
                      group={activeGroup}
                      canManage={canManage}
                      onOpenRecord={openRecord}
                      onDone={onDone}
                    />
                  ) : (
                    <Empty>No problem here matches that.</Empty>
                  )}
                </div>
              </div>
            )
          ) : (
            visiblePeople.length === 0 && !q ? (
              <Empty>Nothing outstanding.</Empty>
            ) : (
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div data-testid="queue-person-list" style={{ flex: '1 1 260px', minWidth: '220px', display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '380px', overflowY: 'auto' }}>
                  {visiblePeople.map((p) => {
                    const on = activePerson?.key === p.key;
                    return (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => setSelectedPerson(p.key)}
                        aria-pressed={on}
                        style={rowButtonStyle(on)}
                      >
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {p.code}{p.name ? ` — ${p.name}` : ''}
                          </span>
                          <span style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {p.issues.slice(0, 2).map((i) => i.sourceSheet === DATA_INTEGRITY_SHEET ? checkTitle(i.sourceColumn) : i.sourceColumn).join(' · ')}
                            {p.issues.length > 2 ? ` · +${p.issues.length - 2} more` : ''}
                          </span>
                        </span>
                        <CountBadge>{counted(p.issues.length, 'open issue')}</CountBadge>
                      </button>
                    );
                  })}
                </div>
                <div data-testid="queue-person-detail" style={{ flex: '2 1 340px', minWidth: '260px', borderLeft: '1px solid var(--border-hair)', paddingLeft: '12px' }}>
                  {activePerson ? (
                    <PersonDetail
                      key={activePerson.key}
                      person={activePerson}
                      canManage={canManage}
                      onOpenRecord={openRecord}
                      onDone={onDone}
                    />
                  ) : (
                    <Empty>Nobody here matches that.</Empty>
                  )}
                </div>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
};
