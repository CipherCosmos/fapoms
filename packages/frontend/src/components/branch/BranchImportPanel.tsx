import React, { useEffect, useState } from 'react';
import { ClipboardCheck, RotateCcw } from 'lucide-react';
import type { BranchImportHandle } from '../../hooks/useBranchImport';
import { BackgroundJobPanel } from '../jobs/BackgroundJobPanel';
import { BranchReconciliationModal } from './BranchReconciliationModal';

/**
 * What a page shows about its branch import, whatever state it is in — and it is always read from
 * the server, so a refresh shows the same thing:
 *
 *  - uploading / rehearsing / saving: the job's own progress (`BackgroundJobPanel`);
 *  - rehearsed: "Review ready", and the review itself (`BranchReconciliationModal`), opened for the
 *    person when a rehearsal they were watching finishes;
 *  - failed or cancelled: why, and Retry — over the file the server already has.
 */
export const BranchImportPanel: React.FC<{
  handle: BranchImportHandle;
  /** The review's heading: "Reconcile Branches: SBI". */
  reviewTitle: string;
}> = ({ handle, reviewTitle }) => {
  const [reviewOpen, setReviewOpen] = useState(false);
  const { reviewJob, jobs } = handle;
  const latest = jobs.job;

  // The rehearsal the person was waiting on has just finished: open its review for them.
  useEffect(() => {
    if (handle.reviewJustBecameReady) {
      setReviewOpen(true);
      handle.acknowledgeReviewReady();
    }
  }, [handle.reviewJustBecameReady, handle]);

  // A review that stopped waiting (committed or discarded elsewhere) closes.
  useEffect(() => {
    if (!reviewJob) setReviewOpen(false);
  }, [reviewJob]);

  const failed = !reviewJob && latest && (latest.status === 'FAILED' || latest.status === 'CANCELLED') && jobs.upload.phase === 'idle';

  return (
    <>
      {reviewJob ? (
        <div
          data-testid="branch-review-ready"
          style={{ padding: '12px 16px', border: '1px solid var(--warning, #d97706)', borderRadius: 'var(--radius-md)', background: 'var(--bg-secondary)', display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}
        >
          <ClipboardCheck size={16} style={{ color: 'var(--warning, #d97706)', flexShrink: 0, marginTop: 2 }} aria-hidden />
          <div style={{ flex: 1, minWidth: 220 }}>
            <strong style={{ fontSize: 'var(--text-sm)' }}>Review ready — {reviewJob.title}</strong>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: 2 }}>
              {reviewJob.result?.summary ?? 'The file has been checked.'} Nothing has been saved yet.
            </div>
            {handle.reviewError && (
              <div role="alert" style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginTop: 4 }}>{handle.reviewError}</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-primary" onClick={() => setReviewOpen(true)} disabled={!handle.review}>
              {handle.reviewLoading ? 'Loading review…' : 'Review & commit'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => void handle.discard()}>
              Discard
            </button>
          </div>
        </div>
      ) : (
        <BackgroundJobPanel handle={jobs} />
      )}

      {failed && latest && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -4 }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void handle.retry(latest)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', padding: '5px 10px' }}
          >
            <RotateCcw size={13} /> Retry with the same file
          </button>
        </div>
      )}

      {reviewOpen && handle.review && (
        <BranchReconciliationModal
          open={reviewOpen}
          onClose={() => setReviewOpen(false)}
          report={handle.review}
          title={reviewTitle}
          onCommit={handle.commit}
        />
      )}
    </>
  );
};
