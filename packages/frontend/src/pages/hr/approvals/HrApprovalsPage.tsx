import React from 'react';
import { Link } from 'react-router-dom';
import { OnboardingApprovalEventKind as Kind, regionLabel } from '@fapoms/shared';
import { userMessage } from '../../../services/errors';
import { loadFailed } from '../../../queryClient';
import { Page } from '../../../components/ui/Page';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { fmtWhen } from '../hr-ui';
import { type QueuedApproval, useApprovalQueue, waitedFor, waitingSince } from './approval-queue';

/** The latest event of one of these kinds on the round — who said it, when, and what. */
const latest = (row: QueuedApproval, ...kinds: Kind[]) =>
  [...row.events].reverse().find((e) => kinds.includes(e.kind)) ?? null;

const quote = (text: string | null | undefined, max = 140) => {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const Person: React.FC<{ row: QueuedApproval }> = ({ row }) => (
  // The review: their whole file on one screen, with the decision beside it — where the bell links too.
  <Link to={`/hr/approvals/${row.assayerId}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>
    {row.displayName}
    {(row.assayerCode || row.region) && (
      <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
        {row.assayerCode ? ` · ${row.assayerCode}` : ''}{row.region ? ` · ${regionLabel(row.region)}` : ''}
      </span>
    )}
  </Link>
);

const Heading: React.FC<{ title: string; count: number; hint: string }> = ({ title, count, hint }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', marginTop: '6px' }}>
    <h2 style={{ fontSize: 'var(--text-sm)', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
      {title} <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>({count})</span>
    </h2>
    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{hint}</span>
  </div>
);

/**
 * AWAITING MY APPROVAL — the approver's list (owner, 2026-09-24).
 *
 * The approval before training could only be found by following its notification, or by opening
 * the Hiring page and reading down to the stage; the backend had a queue nobody's screen asked for.
 * This is that queue, split by what the reader can do about each row:
 *
 *   Waiting for your decision   sent up, nothing outstanding with HR, and not prepared by you
 *   Waiting on HR               you (or another approver) asked for more; it returns when answered
 *   Somebody else decides       you sent them up or answered on it, so you may not decide it
 *
 * Deciding happens on the person's record, in the approval panel — one place to approve, reject or
 * ask, not a second set of buttons here that could drift from it.
 */
export const HrApprovalsPage: React.FC = () => {
  const { query, canApprove, split, userId } = useApprovalQueue();

  if (!canApprove) {
    return (
      <Page>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: 0 }}>
          This list is for the people who approve joiners before training. Your account does not.
        </p>
      </Page>
    );
  }

  const decideColumns: Column<QueuedApproval>[] = [
    { key: 'person', header: 'Person', render: (r) => <Person row={r} /> },
    {
      key: 'sent', header: 'Sent up',
      render: (r) => {
        const e = latest(r, Kind.SUBMITTED);
        return <>{e?.byName ?? 'HR'}{e?.at ? <span style={{ color: 'var(--text-muted)' }}> · {fmtWhen(e.at)}</span> : null}</>;
      },
    },
    { key: 'waiting', header: 'Waiting', render: (r) => <>{waitedFor(waitingSince(r))}</> },
    {
      key: 'latest', header: 'Latest', wrap: true,
      render: (r) => {
        // HR's answer, when there is one, is what the approver is now reading it for.
        const answered = latest(r, Kind.ANSWERED);
        const e = answered ?? latest(r, Kind.SUBMITTED);
        const text = quote(e?.text);
        if (!text) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
        return <>{answered ? <strong>HR answered: </strong> : null}{text}</>;
      },
    },
  ];

  const hrColumns: Column<QueuedApproval>[] = [
    { key: 'person', header: 'Person', render: (r) => <Person row={r} /> },
    {
      key: 'asked', header: 'Asked of HR', wrap: true,
      render: (r) => {
        const e = latest(r, Kind.INFO_REQUESTED);
        return <>{quote(e?.text) || '—'}{e?.byName ? <span style={{ color: 'var(--text-muted)' }}> — {e.byName}</span> : null}</>;
      },
    },
    { key: 'waiting', header: 'Waiting', render: (r) => <>{waitedFor(waitingSince(r))}</> },
  ];

  const othersColumns: Column<QueuedApproval>[] = [
    { key: 'person', header: 'Person', render: (r) => <Person row={r} /> },
    {
      key: 'why', header: 'Why not you',
      // The two ways onto `preparers`: sending them up, or answering the approver on the round.
      render: (r) => <>{r.events.some((e) => e.kind === Kind.SUBMITTED && e.byId === userId) ? 'You sent them up' : 'You answered on it'}</>,
    },
    { key: 'waiting', header: 'Waiting', render: (r) => <>{waitedFor(waitingSince(r))}</> },
  ];

  const total = split.yours.length + split.waitingOnHr.length + split.othersDecide.length;

  return (
    <Page>
      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.55, maxWidth: '760px' }}>
        People HR has finished with, waiting for a senior&rsquo;s approval. Open a person to see their whole
        file and decide: approve them to training or straight to work, ask HR for more, or reject with a reason.
      </p>

      {loadFailed(query) ? (
        <div role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>
          The approvals could not be loaded, so this is not a list of nobody. {userMessage(query.error)}
        </div>
      ) : !Array.isArray(query.data) ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Loading…</div>
      ) : total === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
          Nobody is waiting for approval.
        </div>
      ) : (
        <>
          <Heading title="Waiting for your decision" count={split.yours.length} hint="Oldest first." />
          {split.yours.length === 0
            ? <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Nothing is waiting for your decision.</div>
            : <DataTable density="compact" rows={split.yours} rowKey={(r) => r.id} columns={decideColumns} />}

          {split.waitingOnHr.length > 0 && (
            <>
              <Heading title="Waiting on HR" count={split.waitingOnHr.length} hint="More was asked; it comes back here when HR answers." />
              <DataTable density="compact" rows={split.waitingOnHr} rowKey={(r) => r.id} columns={hrColumns} />
            </>
          )}

          {split.othersDecide.length > 0 && (
            <>
              <Heading
                title="Somebody else decides"
                count={split.othersDecide.length}
                hint="You sent these up or answered on them, so another approver has to decide them."
              />
              <DataTable density="compact" rows={split.othersDecide} rowKey={(r) => r.id} columns={othersColumns} />
            </>
          )}
        </>
      )}
    </Page>
  );
};

export default HrApprovalsPage;
