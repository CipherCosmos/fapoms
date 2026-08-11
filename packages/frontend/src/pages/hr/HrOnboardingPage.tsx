import React from 'react';
import { useNavigate } from 'react-router-dom';
import { card, label, Stat, Empty, Table, OpenLink } from './hr-ui';
import type { HrWorkforceOverview } from '../../hooks/useHrWorkforce';
import { useHr } from './HrLayout';

/**
 * Who is part-way through joining, and who has stopped moving.
 *
 * Previously a tab inside the single HR workspace. It now has its own URL, so it can be linked
 * to from a worklist, bookmarked by whoever owns that part of the job, and grow the controls
 * that job needs without competing for room with seven other concerns.
 */

const OnboardingTabBody = ({ d, navigate }: { d: HrWorkforceOverview; navigate: (path: string) => void }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
      {d.pipeline.stages.map((s) => (
        <Stat key={s.key} value={s.count} caption={s.label} tone={s.stalled ? 'var(--warning)' : undefined}
          hint={s.avgDaysInStage ? `Average ${s.avgDaysInStage} days in this stage` : undefined} />
      ))}
    </div>

    <section style={card}>
      <div style={{ ...label, marginBottom: '10px' }}>
        Stalled over {d.pipeline.stalledAfterDays} days ({d.pipeline.stalled.length})
      </div>
      {d.pipeline.stalled.length === 0 ? (
        <Empty>No candidate has been sitting in a stage longer than {d.pipeline.stalledAfterDays} days.</Empty>
      ) : (
        <Table
          head={['Assayer', 'Stage', 'Days waiting', 'Location', 'Last moved by', '']}
          rows={d.pipeline.stalled.map((r) => [
            <strong>{r.displayName}</strong>,
            r.stage,
            <span style={{ color: r.daysInStage > 30 ? 'var(--danger)' : 'var(--warning)', fontWeight: 600 }}>{r.daysInStage}d</span>,
            [r.district, r.state].filter(Boolean).join(', ') || '—',
            r.movedBy ?? '—',
            <OpenLink onClick={() => navigate(`/assayers/${r.id}`)} />,
          ])}
        />
      )}
    </section>
  </div>
);

// ── Records ────────────────────────────────────────────────────────────────

export const HrOnboardingPage: React.FC = () => {
  const { data: d } = useHr();
  const navigate = useNavigate();
  return <OnboardingTabBody d={d} navigate={navigate} />;
};
