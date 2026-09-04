import React from 'react';
import { AlertCircle, CheckCircle, FileSpreadsheet, Loader2, X } from 'lucide-react';
import { ImportPhase, ImportReport, ImportSummary, summariseImport } from './useImportJob';

/**
 * FAPOMS — what an import is doing, said the same way everywhere.
 *
 * The audience is a branch operations clerk who is not technical and may not read English
 * comfortably, so this panel keeps to one rule: at every moment it answers "is it finished, and
 * what do I do now?" — never "here is a job id and a status code". A queued import that is going to
 * take twenty minutes says so in minutes, and says the page can be closed, because the alternative
 * (an operator watching a spinner, concluding it has hung, and uploading the file a second time) is
 * the failure this whole change exists to end.
 */

/** A row's worth of detail, capped — five reasons is enough to see the pattern. */
const RowNotes: React.FC<{ notes: { row: number; reason: string }[]; limit: number }> = ({ notes, limit }) => (
  <ul style={{ margin: '6px 0 0', paddingLeft: 18, display: 'grid', gap: 2 }}>
    {notes.slice(0, limit).map((n) => (
      <li key={n.row} style={{ fontSize: 13, lineHeight: 1.45 }}>
        <strong>Row {n.row}</strong> — {n.reason}
      </li>
    ))}
    {notes.length > limit && (
      <li style={{ fontSize: 13, color: 'var(--text-muted)' }}>
        …and {notes.length - limit} more.
      </li>
    )}
  </ul>
);

export function ImportProgressPanel<TReport = ImportReport>({
  state,
  onDismiss,
  summarise,
}: {
  state: ImportPhase<TReport>;
  onDismiss: () => void;
  /**
   * How to describe this importer's finished report.
   *
   * Defaults to the branch summary. The roster importer reports different things — references,
   * background checks, cells it could not read — so it supplies its own rather than having this
   * panel learn about every importer there will ever be.
   */
  summarise?: (report: TReport) => ImportSummary;
}) {
  if (state.phase === 'idle') return null;

  const shell = (
    tone: 'info' | 'success' | 'warning' | 'error',
    icon: React.ReactNode,
    body: React.ReactNode,
    dismissible = true,
  ) => {
    const color = {
      info: 'var(--primary)',
      success: 'var(--success)',
      warning: 'var(--warning)',
      error: 'var(--danger)',
    }[tone];
    return (
      <div
        // Announced, because an operator watching a long import may not be looking at this corner
        // of the screen when it finishes. The app has exactly one other live region.
        role="status"
        aria-live="polite"
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'flex-start',
          padding: '14px 16px',
          borderRadius: 10,
          border: `1px solid ${color}`,
          background: 'var(--bg-card)',
          borderLeftWidth: 4,
          marginBottom: 16,
        }}
      >
        <div style={{ color, flexShrink: 0, marginTop: 1 }}>{icon}</div>
        <div style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 1.5 }}>{body}</div>
        {dismissible && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss import result"
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', padding: 4, flexShrink: 0,
            }}
          >
            <X size={16} />
          </button>
        )}
      </div>
    );
  };

  if (state.phase === 'uploading') {
    return shell(
      'info',
      <Loader2 size={20} className="spin" />,
      <>
        <strong>Sending {state.fileName}…</strong>
        <div style={{ color: 'var(--text-muted)' }}>Checking the file before anything is imported.</div>
      </>,
      false,
    );
  }

  if (state.phase === 'running') {
    /**
     * Some importers never have a partial count to show.
     *
     * The roster importer's own job status always reports `progress: null` — its work per row
     * spans five tables inside one transaction, so there is no partial count that means anything
     * until the whole thing commits (see `ImportJobService.getRosterImportStatus`). Rendered
     * through the determinate branch below, that read as `done = 0`, `total = state.totalRows`
     * (the row count the server already told us up front) — a progress bar frozen at a
     * confidently wrong 0% and a static "0 of 1,155 rows" for however long the import actually
     * takes. That is the exact failure this panel's own file docblock says the whole redesign
     * exists to end: an operator watching what looks like a stalled bar, concluding the page has
     * hung, and uploading the file a second time. A branch import can be in the same state
     * briefly too, in the moment between being queued and the worker's first reported batch —
     * `getBranchImportStatus` hands back `null` there for the same reason (Bull's own
     * `progress()` returns `0` for a job that has never reported, which is not a real progress
     * object either). Either way, "no count yet" has to look different from "0 of N done", not
     * be silently drawn as it.
     */
    if (!state.progress) {
      return shell(
        'info',
        <Loader2 size={20} className="spin" />,
        <>
          <strong>Importing {state.fileName}</strong>
          <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{state.message}</div>

          {/* Indeterminate: a moving segment rather than a filled width, and no `aria-valuenow`
              — the WAI-ARIA shape for "working, no measurable fraction yet" rather than "0%". */}
          <div
            style={{
              marginTop: 10, height: 8, borderRadius: 4,
              background: 'var(--bg-subtle, rgba(127,127,127,0.15))', overflow: 'hidden',
            }}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Importing ${state.fileName}, in progress`}
          >
            <div className="import-progress-indeterminate" style={{ height: '100%', width: '35%', borderRadius: 4, background: 'var(--primary)' }} />
          </div>

          <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-muted)' }}>
            Working — this can take a while for a large file, and does not need this page kept open.
          </div>
          <style>{`
            @keyframes importProgressIndeterminate {
              0% { transform: translateX(-100%); }
              100% { transform: translateX(385%); }
            }
            .import-progress-indeterminate { animation: importProgressIndeterminate 1.3s ease-in-out infinite; }
            @media (prefers-reduced-motion: reduce) {
              .import-progress-indeterminate { animation: none; width: 100%; opacity: 0.5; }
            }
          `}</style>
        </>,
        false,
      );
    }

    const done = state.progress.processed ?? 0;
    const total = state.progress.total || state.totalRows || 0;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

    return shell(
      'info',
      <Loader2 size={20} className="spin" />,
      <>
        <strong>Importing {state.fileName}</strong>
        <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
          {/*
            The server's own sentence, which already explains in plain words why this takes a while
            and that the page does not need to stay open. Repeating it here in different words is
            how the two upload screens drifted apart in the first place.
          */}
          {state.message}
        </div>

        <div
          style={{
            marginTop: 10, height: 8, borderRadius: 4,
            background: 'var(--bg-subtle, rgba(127,127,127,0.15))', overflow: 'hidden',
          }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Import progress: ${done} of ${total} rows`}
        >
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--primary)', transition: 'width 400ms ease' }} />
        </div>

        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
          {total > 0 ? `${done} of ${total} rows` : 'Starting…'}
          {state.progress && (state.progress.created > 0 || state.progress.updated > 0) && (
            <> — {state.progress.created} created, {state.progress.updated} updated</>
          )}
        </div>
      </>,
      false,
    );
  }

  if (state.phase === 'error') {
    return shell(
      'error',
      <AlertCircle size={20} />,
      <>
        <strong>{state.fileName} could not be imported</strong>
        <div style={{ marginTop: 2 }}>{state.error}</div>
      </>,
    );
  }

  const summarize = summarise ?? (summariseImport as unknown as (r: TReport) => ImportSummary);
  const summary = summarize(state.report);

  return shell(
    summary.tone,
    summary.tone === 'success' ? <CheckCircle size={20} /> : <FileSpreadsheet size={20} />,
    <>
      <strong>{state.fileName}</strong>
      <div style={{ marginTop: 2 }}>{summary.text}</div>

      {(summary.notes ?? []).map((note, i) => (
        <div key={i} style={{ marginTop: 6, fontSize: 13, color: 'var(--text-muted)' }}>{note}</div>
      ))}

      {(summary.sections ?? []).map((section) => (
        <details key={section.label} style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>{section.label}</summary>
          <RowNotes notes={section.rows} limit={20} />
        </details>
      ))}
    </>,
  );
}
