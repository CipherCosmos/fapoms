import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock } from 'lucide-react';
import { card, label, Empty, OpenLink, fmtWhen } from './hr-ui';
import { DataTable, SearchInput } from '../../components/ui';
import type { HrWorkforceOverview } from '../../hooks/useHrWorkforce';
import { useHr } from './HrLayout';
import { activityEventLabel, assayerLifecycleLabel } from '@fapoms/shared';

/**
 * What has changed on the workforce record, and who changed it.
 *
 * Previously a tab inside the single HR workspace. It now has its own URL, so it can be linked
 * to from a worklist, bookmarked by whoever owns that part of the job, and grow the controls
 * that job needs without competing for room with seven other concerns.
 */

const ActivityTabBody = ({ d, navigate }: { d: HrWorkforceOverview; navigate: (path: string) => void }) => {
  /**
   * The trail is capped server-side at the 40 most recent entries, and with eleven hundred
   * people on the roster the entry being looked for is rarely on screen. A name/event search
   * narrows it; the count beside it says how many of the 40 are showing.
   */
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const rows = q
    ? d.activity.filter((a) => (
      `${a.displayName} ${activityEventLabel(a.eventType)} ${assayerLifecycleLabel(a.previousState)} `
      + `${assayerLifecycleLabel(a.newState)} ${a.performedBy ?? ''} ${a.remarks ?? ''}`
    ).toLowerCase().includes(q))
    : d.activity;
  return (
  <section style={card}>
    <div style={{ ...label, marginBottom: '4px' }}>Workforce audit trail</div>
    <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 12px' }}>
      Every change to a person's record, in order, with who made it.
    </p>
    {d.activity.length === 0 ? (
      <Empty>
        Nothing has changed on anyone's record yet. Entries appear here automatically whenever someone is
        added to the roster, moves through onboarding, or has their status changed — there is nothing to
        fill in on this screen.
      </Empty>
    ) : (
      <>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Find a person, event or note…"
          compact
          style={{ marginBottom: '10px', maxWidth: '340px' }}
        />
        {q && (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
            Showing {rows.length} of {d.activity.length} recent changes.
          </div>
        )}
        {rows.length === 0 ? (
          <Empty>Nothing in the recent trail matches that.</Empty>
        ) : (
      <DataTable
        density="compact"
        minWidth={false}
        rows={rows}
        rowKey={(a) => a.id}
        columns={[
          {
            key: 'when',
            header: 'When',
            render: (a) => (
              <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}><Clock size={11} /> {fmtWhen(a.occurredAt)}</span>
            ),
          },
          { key: 'who', header: 'Assayer', render: (a) => <strong>{a.displayName}</strong> },
          { key: 'event', header: 'Event', render: (a) => <span style={{ fontSize: '12px' }}>{activityEventLabel(a.eventType)}</span> },
          {
            key: 'change',
            header: 'Change',
            // The Change column is a lifecycle move: both ends are stored statuses. Wrapped
            // because the fallback is a free-text remark, which is a sentence rather than a value.
            wrap: true,
            render: (a) => (a.previousState || a.newState
              ? <span style={{ fontSize: '12px' }}>{assayerLifecycleLabel(a.previousState)} → <strong>{assayerLifecycleLabel(a.newState)}</strong></span>
              : <>{a.remarks ?? '—'}</>),
          },
          { key: 'by', header: 'By', render: (a) => <>{a.performedBy ?? 'system'}</> },
          { key: 'open', header: '', render: (a) => <OpenLink onClick={() => navigate(`/assayers/${a.assayerId}`)} /> },
        ]}
      />
        )}
      </>
    )}
  </section>
  );
};

// ── Shared bits ────────────────────────────────────────────────────────────

export const HrActivityPage: React.FC = () => {
  const { data: d } = useHr();
  const navigate = useNavigate();
  return <ActivityTabBody d={d} navigate={navigate} />;
};
