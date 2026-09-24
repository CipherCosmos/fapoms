import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, Loader2 } from 'lucide-react';
import {
  backgroundJobReviewsOnPage,
  backgroundJobRoute,
  isBackgroundJobInFlight,
  type BackgroundJobList,
  type BackgroundJobSummary,
} from '@fapoms/shared';
import { queryKeys } from '../../hooks/queryKeys';
import { useSocketConnection } from '../../hooks/useSocketConnection';
import { jobPollInterval } from '../../hooks/useBackgroundJob';
import { applyJobUpdate, cancelJob, commitReviewedJob, downloadJobResult, fetchJobs } from '../../services/background-jobs';
import { userMessage } from '../../services/errors';
import { useToast } from '../ui/Toast';
import { JobProgressCard } from './JobProgressCard';

/**
 * The Jobs tray: every upload and background job this person has going, on every page.
 *
 * ## Why it reads from the server on every load
 *
 * The problem it exists to end is "I refreshed and my 5,000-branch upload vanished". So it keeps no
 * memory of its own — not in state that dies with the page, not in localStorage that disagrees with
 * the server after a deploy. Mounting (a navigation, a refresh, a hard refresh, a new tab) asks
 * `GET /jobs` for what is active and what finished lately, and draws that.
 *
 * ## How it stays current
 *
 * `job:updated` pushes are written straight into this list by `useSocketInvalidation` — no refetch
 * per progress tick. If the socket is down while something is in flight it polls every 5 s instead,
 * and every 30 s even with the socket up, as a net under a missed push.
 *
 * ## Why it is quiet
 *
 * An icon with no badge when nothing is happening. A spinner and a count while something is. It
 * never opens itself: the page that started a job already says so, and a panel sliding over
 * whatever the person is reading would be the loudest possible way to say "nothing needs you".
 */
export const JobsTray: React.FC = () => {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const socketLive = useSocketConnection();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();

  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.jobs.tray,
    queryFn: ({ signal }) => fetchJobs({ status: ['active', 'recent'], limit: 10 }, signal),
    refetchInterval: (q) => jobPollInterval(q.state.data as BackgroundJobList | undefined, socketLive),
  });

  const active = data?.active ?? [];
  const recent = data?.recent ?? [];
  const inFlight = active.filter((j) => isBackgroundJobInFlight(j.status)).length;
  const needsReview = active.length - inFlight;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const act = async (what: () => Promise<void>, failTitle: string) => {
    try { await what(); } catch (err) { toast({ type: 'error', title: failTitle, message: userMessage(err) }); }
  };

  const onCancel = (job: BackgroundJobSummary) =>
    void act(async () => applyJobUpdate(queryClient, await cancelJob(job.id)), 'Could not cancel');
  const onDownload = (job: BackgroundJobSummary) =>
    void act(() => downloadJobResult(job), 'Could not download the report');
  const onCommit = (job: BackgroundJobSummary) =>
    void act(async () => {
      const accepted = await commitReviewedJob(job.id);
      applyJobUpdate(queryClient, accepted.job);
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobs.all });
    }, 'Could not start it');
  const onOpen = (job: BackgroundJobSummary) => {
    const route = backgroundJobRoute(job);
    if (!route) return;
    setOpen(false);
    void navigate(route);
  };

  const label = inFlight > 0
    ? `Background jobs, ${inFlight} in progress`
    : needsReview > 0 ? `Background jobs, ${needsReview} waiting for your review` : 'Background jobs';
  const rect = anchorRef.current?.getBoundingClientRect();

  return (
    <div ref={anchorRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={label}
        style={{
          background: open ? 'var(--bg-tertiary)' : 'var(--bg-primary)',
          border: '1px solid var(--border-color)',
          color: inFlight + needsReview > 0 ? 'var(--accent-primary)' : 'var(--text-secondary)',
          cursor: 'pointer',
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          borderRadius: 'var(--radius-full)',
        }}
      >
        {inFlight > 0 ? <Loader2 size={16} className="spin" aria-hidden /> : <Layers size={16} aria-hidden />}
        {inFlight + needsReview > 0 && (
          <span
            data-testid="jobs-tray-count"
            style={{
              position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, borderRadius: 9, padding: '0 4px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 'var(--text-3xs)', fontWeight: 800, color: '#fff',
              background: needsReview > 0 && inFlight === 0 ? 'var(--warning, #d97706)' : 'var(--accent-primary, #2563eb)',
              border: '2px solid var(--bg-secondary)',
            }}
          >
            {inFlight + needsReview}
          </span>
        )}
      </button>

      {open && rect && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Background jobs"
          style={{
            position: 'fixed',
            top: rect.bottom + 10,
            left: Math.max(16, Math.min(rect.right - 380, window.innerWidth - 396)),
            width: 'min(380px, calc(100vw - 32px))',
            maxHeight: 'min(520px, calc(100vh - 100px))',
            background: 'var(--bg-surface-2, var(--bg-secondary))',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-lg)',
            overflow: 'hidden',
            zIndex: 999999,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color)', fontWeight: 700, fontSize: 'var(--text-base)' }}>
            Background jobs
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {isLoading && !data ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>Loading…</div>
            ) : isError && !data ? (
              <div role="alert" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                Could not load your jobs. They are still running on the server — try again in a moment.
              </div>
            ) : active.length + recent.length === 0 ? (
              <div style={{ padding: '28px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                Nothing running. Large uploads show their progress here, even after you refresh.
              </div>
            ) : (
              <>
                {active.length > 0 && <SectionHeading>In progress</SectionHeading>}
                {active.map((job) => (
                  <JobProgressCard key={job.id} job={job} compact onCancel={onCancel} onDownload={onDownload}
                    // A rehearsal reviewed row by row on its page (a branch list) is opened there, never
                    // accepted blind from here.
                    onCommit={backgroundJobReviewsOnPage(job.kind) ? undefined : onCommit}
                    onOpen={backgroundJobRoute(job) ? onOpen : undefined} />
                ))}
                {recent.length > 0 && <SectionHeading>Finished recently</SectionHeading>}
                {recent.map((job) => (
                  <JobProgressCard key={job.id} job={job} compact onDownload={onDownload}
                    onOpen={backgroundJobRoute(job) ? onOpen : undefined} />
                ))}
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

const SectionHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{
    padding: '8px 16px 4px', fontSize: 'var(--text-3xs)', fontWeight: 700, letterSpacing: '0.06em',
    textTransform: 'uppercase', color: 'var(--text-muted)',
  }}>
    {children}
  </div>
);
