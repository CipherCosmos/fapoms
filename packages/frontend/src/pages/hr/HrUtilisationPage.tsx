import React from 'react';
import { useNavigate } from 'react-router-dom';
import { card, label, Stat, Empty, Table, OpenLink, fmtDate } from './hr-ui';
import type { HrWorkforceOverview } from '../../hooks/useHrWorkforce';
import { useHr } from './HrLayout';

/**
 * Who is overloaded, who is idle, and who is leaving.
 *
 * Previously a tab inside the single HR workspace. It now has its own URL, so it can be linked
 * to from a worklist, bookmarked by whoever owns that part of the job, and grow the controls
 * that job needs without competing for room with seven other concerns.
 */

const UtilisationTabBody = ({ d, navigate }: { d: HrWorkforceOverview; navigate: (path: string) => void }) => {
  const p = d.utilisation.performance;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <Stat value={d.utilisation.idleCount} caption={`No work in ${d.utilisation.idleAfterDays} days`} tone={d.utilisation.idleCount ? 'var(--warning)' : 'var(--success)'} />
        <Stat value={d.utilisation.neverAssigned} caption="Never assigned" tone={d.utilisation.neverAssigned ? 'var(--warning)' : undefined}
          hint="Onboarded but never deployed — an onboarding failure rather than a lull" />
        <Stat value={p.avgRating ?? '—'} caption={`Average rating (${p.rated} rated)`} />
        <Stat value={p.onTimeRate === null ? '—' : `${p.onTimeRate}%`} caption="On-time completion" />
        <Stat value={p.belowPar} caption="Rated below 3" tone={p.belowPar ? 'var(--warning)' : undefined} />
      </div>

      <section style={card}>
        <div style={{ ...label, marginBottom: '10px' }}>Who is under or over-utilised ({d.utilisation.utilizationCounts.underUtilized + d.utilisation.utilizationCounts.idle} under / {d.utilisation.utilizationCounts.overUtilized} over)</div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
          <Stat value={d.utilisation.utilizationCounts.overUtilized} caption="Over capacity" tone={d.utilisation.utilizationCounts.overUtilized ? 'var(--danger)' : undefined} />
          <Stat value={d.utilisation.utilizationCounts.balanced} caption="Balanced" tone='var(--success)' />
          <Stat value={d.utilisation.utilizationCounts.underUtilized} caption="Under-utilised" tone={d.utilisation.utilizationCounts.underUtilized ? 'var(--warning)' : undefined} />
          <Stat value={d.utilisation.utilizationCounts.idle} caption="Idle (no work)" tone={d.utilisation.utilizationCounts.idle ? 'var(--warning)' : undefined} />
        </div>
        {d.utilisation.utilization.length === 0 ? (
          <Empty>No active assayers to measure utilisation for.</Empty>
        ) : (
          <Table
            head={['Assayer', 'Location', 'Loaded', 'Capacity', 'Util %', 'Status', '']}
            rows={d.utilisation.utilization.map((r) => {
              const tone =
                r.posture === 'OVER_UTILIZED' ? 'var(--danger)' :
                r.posture === 'UNDER_UTILIZED' || r.posture === 'IDLE' ? 'var(--warning)' : 'var(--success)';
              return [
                <strong>{r.displayName}</strong>,
                [r.district, r.state].filter(Boolean).join(', ') || '—',
                `${r.currentAllocation} / ${r.weeklyCapacity}`,
                r.remainingCapacity > 0 ? `${r.remainingCapacity} free` : 'at limit',
                <strong style={{ color: tone }}>{r.utilizationPercentage}%</strong>,
                <span style={{ color: tone, fontSize: '11px', fontWeight: 600 }}>{r.posture.replace('_', ' ')}</span>,
                <OpenLink onClick={() => navigate(`/assayers/${r.id}`)} />,
              ];
            })}
          />
        )}
      </section>

      <section style={card}>
        <div style={{ ...label, marginBottom: '10px' }}>Idle and never-deployed ({d.utilisation.idle.length})</div>
        {d.utilisation.idle.length === 0 ? (
          <Empty>Everyone active has had work in the last {d.utilisation.idleAfterDays} days.</Empty>
        ) : (
          <Table
            head={['Assayer', 'Location', 'Last assignment', 'Idle', 'Lifetime jobs', '']}
            rows={d.utilisation.idle.map((r) => [
              <strong>{r.displayName}</strong>,
              r.state ?? '—',
              r.lastAssignmentDate ? fmtDate(r.lastAssignmentDate) : <span style={{ color: 'var(--warning)' }}>never</span>,
              r.daysIdle === null ? '—' : `${r.daysIdle}d`,
              r.totalAssignments ?? 0,
              <OpenLink onClick={() => navigate(`/assayers/${r.id}`)} />,
            ])}
          />
        )}
      </section>

      <section style={card}>
        <div style={{ ...label, marginBottom: '10px' }}>Attrition</div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
          <Stat value={d.attrition.exits90d} caption="Exits (90 days)" />
          <Stat value={d.attrition.exits12m} caption="Exits (12 months)" />
          <Stat value={d.attrition.terminations} caption="Terminations" />
          <Stat value={d.attrition.joins90d} caption="Joins (90 days)" />
          <Stat value={`${d.attrition.attritionRate12m}%`} caption="Attrition rate" />
        </div>
        {d.attrition.recent.length === 0 ? (
          <Empty>Nobody has left. Note that joining and exit dates are largely unrecorded, so tenure figures are thin.</Empty>
        ) : (
          <Table
            head={['Assayer', 'State', 'Joined', 'Left', 'Mode']}
            rows={d.attrition.recent.map((r) => [
              <strong>{r.displayName}</strong>, r.state ?? '—', fmtDate(r.joiningDate), fmtDate(r.exitDate),
              <span style={{ color: r.mode === 'TERMINATED' ? 'var(--danger)' : 'var(--text-muted)', fontSize: '11px', fontWeight: 600 }}>{r.mode}</span>,
            ])}
          />
        )}
      </section>
    </div>
  );
};

// ── Activity ───────────────────────────────────────────────────────────────

export const HrUtilisationPage: React.FC = () => {
  const { data: d } = useHr();
  const navigate = useNavigate();
  return <UtilisationTabBody d={d} navigate={navigate} />;
};
