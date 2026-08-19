import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { card, label, Stat, Empty, Table, OpenLink, fmtDate } from './hr-ui';
import type { HrWorkforceOverview } from '../../hooks/useHrWorkforce';
import { useHr } from './HrLayout';
import { assayerLifecycleLabel } from '@fapoms/shared';

/**
 * How loaded one assayer is. Not a stored status — the backend derives it per person from
 * assignments against weekly capacity (hr-workforce.service.ts), so there is no shared label
 * for it the way there is for lifecycle or activity events. It is spelled out here rather than
 * de-cased on the fly because `UNDER_UTILIZED` de-cases to "UNDER UTILIZED", which is both
 * shouting and American, and because "Idle" alone was read as a choice the person had made.
 */
const WORKLOAD_POSTURE: Record<string, string> = {
  IDLE: 'No work',
  UNDER_UTILIZED: 'Room for more',
  BALANCED: 'Balanced',
  OVER_UTILIZED: 'Over capacity',
};

/**
 * Who is overloaded, who is idle, and who is leaving.
 *
 * Previously a tab inside the single HR workspace. It now has its own URL, so it can be linked
 * to from a worklist, bookmarked by whoever owns that part of the job, and grow the controls
 * that job needs without competing for room with seven other concerns.
 */

const UtilisationTabBody = ({ d, navigate }: { d: HrWorkforceOverview; navigate: (path: string) => void }) => {
  const p = d.utilisation.performance;
  // Nobody has ever been assigned anything. Every number on this screen is then a zero that
  // describes the *absence of work*, not the behaviour of the people — and a screen full of
  // amber "idle" and "0%" reads as an accusation. Say once, at the top, why it is all zero and
  // where work is created, and stand the per-person amber down for the same reason.
  const noWorkYet = p.totalAssignments === 0 && d.utilisation.idleCount === d.utilisation.neverAssigned;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {noWorkYet && (
        <div style={{ ...card, fontSize: '13px', color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>No work has been assigned to anyone yet.</strong>{' '}
          Everything below is zero because there are no assignments in the system — not because the team is
          sitting idle. Workload figures start filling in once branches are offered to assayers in{' '}
          <Link to="/planning" style={{ color: 'var(--accent)', fontWeight: 600 }}>Planning</Link>.
        </div>
      )}
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <Stat
          value={d.utilisation.idleCount}
          caption={noWorkYet ? 'Waiting for their first job' : `No work in ${d.utilisation.idleAfterDays} days`}
          tone={noWorkYet ? undefined : d.utilisation.idleCount ? 'var(--warning)' : 'var(--success)'}
          hint={noWorkYet ? 'Nobody has been assigned work yet, so nobody can have worked recently' : undefined}
        />
        <Stat value={d.utilisation.neverAssigned} caption="Never assigned" tone={noWorkYet ? undefined : d.utilisation.neverAssigned ? 'var(--warning)' : undefined}
          hint="Onboarded but never deployed — an onboarding failure rather than a lull" />
        <Stat value={p.avgRating ?? '—'} caption={`Average rating (${p.rated} rated)`} />
        <Stat value={p.onTimeRate === null ? '—' : `${p.onTimeRate}%`} caption="On-time completion" />
        <Stat value={p.belowPar} caption="Rated below 3" tone={p.belowPar ? 'var(--warning)' : undefined} />
      </div>

      <section style={card}>
        {/* The chip that got you here says "Workload", so this section says workload too — it used to
            say "under or over-utilised", which is a third word for the same thing on the same click. */}
        <div style={{ ...label, marginBottom: '10px' }}>Workload, person by person ({d.utilisation.utilizationCounts.total})</div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
          <Stat value={d.utilisation.utilizationCounts.overUtilized} caption="Over capacity" tone={d.utilisation.utilizationCounts.overUtilized ? 'var(--danger)' : undefined} />
          <Stat value={d.utilisation.utilizationCounts.balanced} caption="Balanced" tone='var(--success)' />
          <Stat value={d.utilisation.utilizationCounts.underUtilized} caption="Under-utilised" tone={d.utilisation.utilizationCounts.underUtilized ? 'var(--warning)' : undefined} />
          <Stat value={d.utilisation.utilizationCounts.idle} caption="Idle (no work)" tone={d.utilisation.utilizationCounts.idle ? 'var(--warning)' : undefined} />
        </div>
        {d.utilisation.utilization.length === 0 ? (
          <Empty>Nobody is on the active roster yet, so there is no workload to measure. Add people in Roster first.</Empty>
        ) : (
          <Table
            head={['Assayer', 'Location', 'Loaded', 'Capacity', 'Util %', 'Status', '']}
            rows={d.utilisation.utilization.map((r) => {
              const tone = noWorkYet ? 'var(--text-muted)' :
                r.posture === 'OVER_UTILIZED' ? 'var(--danger)' :
                r.posture === 'UNDER_UTILIZED' || r.posture === 'IDLE' ? 'var(--warning)' : 'var(--success)';
              return [
                <strong>{r.displayName}</strong>,
                [r.district, r.state].filter(Boolean).join(', ') || '—',
                `${r.currentAllocation} / ${r.weeklyCapacity}`,
                r.remainingCapacity > 0 ? `${r.remainingCapacity} free` : 'at limit',
                <strong style={{ color: tone }}>{r.utilizationPercentage}%</strong>,
                <span style={{ color: tone, fontSize: '11px', fontWeight: 600 }}>{WORKLOAD_POSTURE[r.posture] ?? r.posture}</span>,
                <OpenLink onClick={() => navigate(`/assayers/${r.id}`)} />,
              ];
            })}
          />
        )}
      </section>

      <section style={card}>
        <div style={{ ...label, marginBottom: '10px' }}>
          {noWorkYet ? 'Waiting for their first job' : 'Idle and never-deployed'} ({d.utilisation.idle.length})
        </div>
        {d.utilisation.idle.length === 0 ? (
          <Empty>Everyone on the active roster has had work in the last {d.utilisation.idleAfterDays} days.</Empty>
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
          <Empty>
            Nobody has left. People appear here once an exit or termination date is recorded on their record;
            joining and exit dates are largely unfilled today, so tenure figures are thin.
          </Empty>
        ) : (
          <Table
            head={['Assayer', 'State', 'Joined', 'Left', 'Mode']}
            rows={d.attrition.recent.map((r) => [
              <strong>{r.displayName}</strong>, r.state ?? '—', fmtDate(r.joiningDate), fmtDate(r.exitDate),
              <span style={{ color: r.mode === 'TERMINATED' ? 'var(--danger)' : 'var(--text-muted)', fontSize: '11px', fontWeight: 600 }}>{assayerLifecycleLabel(r.mode)}</span>,
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
