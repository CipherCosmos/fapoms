import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock } from 'lucide-react';
import { card, label, Empty, Table, OpenLink, fmtWhen } from './hr-ui';
import type { HrWorkforceOverview } from '../../hooks/useHrWorkforce';
import { useHr } from './HrLayout';

/**
 * What has changed on the workforce record, and who changed it.
 *
 * Previously a tab inside the single HR workspace. It now has its own URL, so it can be linked
 * to from a worklist, bookmarked by whoever owns that part of the job, and grow the controls
 * that job needs without competing for room with seven other concerns.
 */

const ActivityTabBody = ({ d, navigate }: { d: HrWorkforceOverview; navigate: (path: string) => void }) => (
  <section style={card}>
    <div style={{ ...label, marginBottom: '4px' }}>Workforce audit trail</div>
    <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 12px' }}>
      Every change to a person's record, in order, with who made it.
    </p>
    {d.activity.length === 0 ? (
      <Empty>No workforce activity recorded yet.</Empty>
    ) : (
      <Table
        head={['When', 'Assayer', 'Event', 'Change', 'By', '']}
        rows={d.activity.map((a) => [
          <span style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: '11px' }}><Clock size={11} /> {fmtWhen(a.occurredAt)}</span>,
          <strong>{a.displayName}</strong>,
          <span style={{ fontSize: '11px' }}>{a.eventType.replace(/_/g, ' ').toLowerCase()}</span>,
          a.previousState || a.newState
            ? <span style={{ fontSize: '11px' }}>{a.previousState ?? '—'} → <strong>{a.newState ?? '—'}</strong></span>
            : (a.remarks ?? '—'),
          a.performedBy ?? 'system',
          <OpenLink onClick={() => navigate(`/assayers/${a.assayerId}`)} />,
        ])}
      />
    )}
  </section>
);

// ── Shared bits ────────────────────────────────────────────────────────────

export const HrActivityPage: React.FC = () => {
  const { data: d } = useHr();
  const navigate = useNavigate();
  return <ActivityTabBody d={d} navigate={navigate} />;
};
