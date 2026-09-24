import React from 'react';
import { AlertCircle, UploadCloud, X } from 'lucide-react';
import type { BackgroundJobHandle } from '../../hooks/useBackgroundJob';
import { JobProgressCard, ProgressBar } from './JobProgressCard';

/**
 * What a page shows about its own upload: the bytes going up (with a real bar, and the honest
 * warning that they need this tab until they arrive), then the job the server is running.
 *
 * Renders nothing when there is nothing to say. Pair it with `useBackgroundJob`:
 *
 * ```tsx
 * const branches = useBackgroundJob('BRANCH_IMPORT', { type: 'CLIENT', id: clientId });
 * <BackgroundJobPanel handle={branches} />
 * ```
 */
export const BackgroundJobPanel: React.FC<{
  handle: BackgroundJobHandle;
  /** Show the latest job even once it has finished (default). False hides settled jobs. */
  showFinished?: boolean;
}> = ({ handle, showFinished = true }) => {
  const { upload, job } = handle;

  if (upload.phase === 'uploading') {
    const pct = Math.round(upload.progress.fraction * 100);
    return (
      <div
        data-testid="job-upload"
        style={{ padding: '12px 16px', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', background: 'var(--bg-secondary)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <UploadCloud size={16} style={{ color: 'var(--accent-primary, var(--primary))' }} aria-hidden />
          <strong style={{ fontSize: 'var(--text-sm)', flex: 1, overflowWrap: 'anywhere' }}>Uploading {upload.fileName}</strong>
          <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{pct}%</span>
          <button
            type="button"
            onClick={handle.abortUpload}
            aria-label="Stop uploading"
            title="Stop uploading"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex' }}
          >
            <X size={14} />
          </button>
        </div>
        <ProgressBar percent={pct} label={`Uploading ${upload.fileName}`} />
        <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: 6 }}>
          Keep this page open until the upload finishes. Once it is received, the work carries on without you.
        </div>
      </div>
    );
  }

  if (upload.phase === 'error') {
    return (
      <div
        role="alert"
        style={{ padding: '12px 16px', border: '1px solid var(--danger, #dc2626)', borderRadius: 'var(--radius-md)', display: 'flex', gap: 8, alignItems: 'flex-start' }}
      >
        <AlertCircle size={16} style={{ color: 'var(--danger, #dc2626)', flexShrink: 0 }} aria-hidden />
        <div style={{ flex: 1, fontSize: 'var(--text-sm)' }}>
          <strong>{upload.fileName} was not uploaded.</strong>
          <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{upload.message}</div>
        </div>
        <button type="button" onClick={handle.resetUpload} aria-label="Dismiss" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
          <X size={14} />
        </button>
      </div>
    );
  }

  if (!job) return null;
  if (!showFinished && !handle.active.some((j) => j.id === job.id)) return null;

  return (
    <JobProgressCard
      job={job}
      onCancel={(j) => void handle.cancel(j.id)}
      onDownload={(j) => void handle.downloadResult(j.id)}
      onCommit={(j) => void handle.commit(undefined, j.id)}
    />
  );
};
