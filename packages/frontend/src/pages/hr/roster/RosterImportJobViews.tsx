import React from 'react';
import { ClipboardCheck } from 'lucide-react';
import type { BackgroundJobSummary } from '@fapoms/shared';
import { AlertBanner } from '../../../components/ui';
import { counted } from '../../../utils/plural';
import type { ImportSummary, RosterImportSummary } from '../AssayerRoster';

/**
 * What the roster page shows of a `ROSTER_IMPORT` job once it has an answer. Both views are drawn
 * from the job the server holds (`result.details`), never from memory in this tab — so a rehearsal
 * that finished while the page was closed is offered exactly as if it had just finished here.
 */

/** The importer's summary a finished run carries, or null for a job that has none (yet). */
export function rosterImportDetails(job: Pick<BackgroundJobSummary, 'result'> | null | undefined): RosterImportSummary | null {
  const details = job?.result?.details as Partial<RosterImportSummary> | undefined;
  if (!details || typeof details !== 'object' || typeof details.rowsRead !== 'number') return null;
  return details as RosterImportSummary;
}

const n = (v: number) => v.toLocaleString('en-IN');
const NOTES_SHOWN = 4;

/** A rehearsal waiting for its answer: what importing the workbook would do, and the choice. */
export const RosterImportReview: React.FC<{
  job: BackgroundJobSummary;
  onImport: (dry: RosterImportSummary) => void;
  onDiscard: () => void;
}> = ({ job, onImport, onDiscard }) => {
  const dry = rosterImportDetails(job);

  // Offering "import" for a run that was not a rehearsal would import it a second time.
  if (!dry || dry.dryRun !== true) {
    return (
      <AlertBanner type="error" onClose={onDiscard}>
        The server imported this workbook instead of only checking it. Review the roster before uploading it again.
      </AlertBanner>
    );
  }

  const notes = [
    ...(dry.notes ?? []),
    dry.issues > 0 ? `${counted(dry.issues, 'cell')} couldn't be read — they will be filed under "Import issues".` : '',
  ].filter(Boolean);

  return (
    <div
      data-testid="roster-import-review"
      style={{
        padding: '12px 16px', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
        background: 'var(--bg-secondary)', display: 'grid', gap: 6, fontSize: 'var(--text-sm)',
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <ClipboardCheck size={16} aria-hidden style={{ color: 'var(--warning, #d97706)', flexShrink: 0 }} />
        <strong style={{ overflowWrap: 'anywhere' }}>
          {job.inputFileName ?? 'The workbook'} was checked — nothing has been saved yet
        </strong>
      </div>
      <div style={{ color: 'var(--text-secondary)' }}>
        Importing its {n(dry.rowsRead)} row(s) will add <strong>{n(dry.created)}</strong> and update{' '}
        <strong>{n(dry.updated)}</strong> appraisers.
        {dry.skipped > 0 && ` ${dry.skipped} row(s) without appraiser code will be skipped.`}
      </div>
      {notes.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--text-xs)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {notes.slice(0, NOTES_SHOWN).map((note, i) => <li key={i}>{note}</li>)}
          {notes.length > NOTES_SHOWN && <li>and {notes.length - NOTES_SHOWN} more</li>}
        </ul>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-primary"
          style={{ fontSize: 'var(--text-xs)', padding: '6px 12px' }}
          onClick={() => onImport(dry)}
        >
          Import {n(dry.rowsRead)} appraisers
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ fontSize: 'var(--text-xs)', padding: '6px 12px' }}
          onClick={onDiscard}
          title="Discard this check without importing anything"
        >
          Discard
        </button>
      </div>
    </div>
  );
};

/** A finished real import: what it did, in the page's own words. */
export const RosterImportOutcome: React.FC<{
  job: BackgroundJobSummary;
  summarise: (summary: RosterImportSummary) => ImportSummary;
  onDismiss: () => void;
}> = ({ job, summarise, onDismiss }) => {
  const details = rosterImportDetails(job);
  if (!details) return null;
  const said = summarise(details);
  return (
    <AlertBanner
      type={said.tone === 'error' ? 'error' : 'success'}
      onClose={onDismiss}
      style={{ alignItems: 'flex-start', fontSize: 'var(--text-sm)' }}
    >
      <span data-testid="roster-import-outcome" style={{ fontWeight: 600 }}>{said.text}</span>
      {(said.notes ?? []).length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 'var(--text-xs)', lineHeight: 1.5 }}>
          {said.notes!.map((note, i) => <li key={i}>{note}</li>)}
        </ul>
      )}
    </AlertBanner>
  );
};
