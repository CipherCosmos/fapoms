import React from 'react';
import { AlertCircle, CheckCircle2, Download, Loader2, PauseCircle, XCircle, ClipboardCheck } from 'lucide-react';
import {
  backgroundJobHasDownload,
  backgroundJobLabel,
  isBackgroundJobInFlight,
  type BackgroundJobStatus,
  type BackgroundJobSummary,
} from '@fapoms/shared';

/**
 * One background job, said the same way in the Jobs tray and on the page that started it.
 *
 * Written for the clerk who uploaded the file, not for whoever built the importer: every state
 * answers "is it finished, and what do I do now?". A job in flight says it does not need the page
 * kept open; a finished one says what happened in the server's own sentence; a failure says why in
 * words, never a code.
 */

const STATUS_WORDS: Record<BackgroundJobStatus, string> = {
  QUEUED: 'Queued',
  RUNNING: 'In progress',
  AWAITING_REVIEW: 'Needs your review',
  SUCCEEDED: 'Done',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

const TONE: Record<BackgroundJobStatus, string> = {
  QUEUED: 'var(--text-muted)',
  RUNNING: 'var(--accent-primary, var(--primary))',
  AWAITING_REVIEW: 'var(--warning, #d97706)',
  SUCCEEDED: 'var(--success, #16a34a)',
  FAILED: 'var(--danger, #dc2626)',
  CANCELLED: 'var(--text-muted)',
};

function StatusIcon({ status }: { status: BackgroundJobStatus }) {
  const style = { color: TONE[status], flexShrink: 0 } as const;
  switch (status) {
    case 'QUEUED':
    case 'RUNNING':
      return <Loader2 size={16} className="spin" style={style} aria-hidden />;
    case 'AWAITING_REVIEW':
      return <ClipboardCheck size={16} style={style} aria-hidden />;
    case 'SUCCEEDED':
      return <CheckCircle2 size={16} style={style} aria-hidden />;
    case 'FAILED':
      return <AlertCircle size={16} style={style} aria-hidden />;
    default:
      return <XCircle size={16} style={style} aria-hidden />;
  }
}

const n = (value: number) => value.toLocaleString('en-IN');

/** "1,240 of 5,000" when the job counts, nothing when it does not. */
export function progressCount(job: Pick<BackgroundJobSummary, 'progress'>): string | null {
  const { processed, total } = job.progress;
  if (total === null || total === undefined) return processed > 0 ? `${n(processed)} done` : null;
  return `${n(Math.min(processed, total))} of ${n(total)}`;
}

export const ProgressBar: React.FC<{ percent: number | null; label: string }> = ({ percent, label }) => (
  <div
    role="progressbar"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={100}
    {...(percent !== null ? { 'aria-valuenow': percent } : {})}
    style={{
      height: 6,
      borderRadius: 3,
      background: 'var(--bg-subtle, rgba(127,127,127,0.18))',
      overflow: 'hidden',
      marginTop: 8,
    }}
  >
    {percent !== null ? (
      <div style={{ width: `${Math.max(0, Math.min(100, percent))}%`, height: '100%', background: 'var(--accent-primary, var(--primary))', transition: 'width 400ms ease' }} />
    ) : (
      <div className="job-progress-indeterminate" style={{ width: '35%', height: '100%', borderRadius: 3, background: 'var(--accent-primary, var(--primary))' }} />
    )}
    <style>{`
      @keyframes jobProgressIndeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(385%); } }
      .job-progress-indeterminate { animation: jobProgressIndeterminate 1.3s ease-in-out infinite; }
      @media (prefers-reduced-motion: reduce) { .job-progress-indeterminate { animation: none; width: 100%; opacity: 0.5; } }
    `}</style>
  </div>
);

const linkButton: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  fontSize: 'var(--text-2xs)',
  fontWeight: 600,
  color: 'var(--accent-primary, var(--primary))',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

export interface JobProgressCardProps {
  job: BackgroundJobSummary;
  onCancel?: (job: BackgroundJobSummary) => void;
  onDownload?: (job: BackgroundJobSummary) => void;
  /** Where the job's page is, and how to go there; omitted on the page itself. */
  onOpen?: (job: BackgroundJobSummary) => void;
  /** Commit a rehearsal; shown only for AWAITING_REVIEW. */
  onCommit?: (job: BackgroundJobSummary) => void;
  compact?: boolean;
}

export const JobProgressCard: React.FC<JobProgressCardProps> = ({ job, onCancel, onDownload, onOpen, onCommit, compact }) => {
  const inFlight = isBackgroundJobInFlight(job.status);
  const count = progressCount(job);
  const percent = job.status === 'SUCCEEDED' ? 100 : job.progress.percent;
  // A stored report, or a link to a file its feature keeps for a while (an export) that has not
  // expired — never the review file a page reads its rehearsal back from (a branch list's JSON).
  const downloadable = backgroundJobHasDownload(job);
  const canCancel = !!onCancel && (inFlight || job.status === 'AWAITING_REVIEW') && !job.cancelRequested && job.cancellable !== false;

  return (
    <div
      data-testid={`job-${job.id}`}
      style={{
        padding: compact ? '10px 14px' : '12px 16px',
        borderBottom: compact ? '1px solid var(--border-color)' : undefined,
        border: compact ? undefined : '1px solid var(--border-color)',
        borderRadius: compact ? undefined : 'var(--radius-md)',
        background: compact ? undefined : 'var(--bg-secondary)',
        display: 'grid',
        gap: 2,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <StatusIcon status={job.status} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)', color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
            {job.title}
          </div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
            {backgroundJobLabel(job.kind)} · <span style={{ color: TONE[job.status], fontWeight: 600 }}>{STATUS_WORDS[job.status]}</span>
            {job.cancelRequested && ' · stopping…'}
          </div>
        </div>
      </div>

      {inFlight && (
        <>
          <ProgressBar percent={percent} label={`${job.title}: ${job.progress.stage}`} />
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: 4 }}>
            <span>{job.progress.stage}</span>
            {count && <span>{count}{percent !== null ? ` · ${percent}%` : ''}</span>}
          </div>
          {job.progress.message && <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{job.progress.message}</div>}
          {!compact && (
            <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: 2 }}>
              This runs on the server — you can leave or refresh this page.
            </div>
          )}
        </>
      )}

      {!inFlight && job.result?.summary && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: 4 }}>{job.result.summary}</div>
      )}
      {job.status === 'FAILED' && job.error && (
        <div role="alert" style={{ fontSize: 'var(--text-xs)', color: TONE.FAILED, marginTop: 4 }}>{job.error}</div>
      )}

      {(canCancel || (onDownload && downloadable) || onOpen || (onCommit && job.status === 'AWAITING_REVIEW')) && (
        <div style={{ display: 'flex', gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
          {onCommit && job.status === 'AWAITING_REVIEW' && (
            <button type="button" style={linkButton} onClick={() => onCommit(job)}>
              <CheckCircle2 size={12} /> Go ahead
            </button>
          )}
          {onDownload && downloadable && (
            <button type="button" style={linkButton} onClick={() => onDownload(job)}>
              <Download size={12} /> Download report
            </button>
          )}
          {onOpen && (
            <button type="button" style={linkButton} onClick={() => onOpen(job)}>
              Open page
            </button>
          )}
          {canCancel && (
            <button type="button" style={{ ...linkButton, color: 'var(--text-muted)' }} onClick={() => onCancel!(job)}>
              <PauseCircle size={12} /> {job.status === 'AWAITING_REVIEW' ? 'Discard' : 'Cancel'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
