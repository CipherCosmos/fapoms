import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { card, label, Stat, Empty, OpenLink, fmtDate, attritionExplainer } from './hr-ui';
import { DataTable } from '../../components/ui';
import type { HrWorkforceOverview } from '../../hooks/useHrWorkforce';
import { useHr } from './HrLayout';
import { assayerLifecycleLabel } from '@fapoms/shared';

/**
 * What each departure mode is called on screen.
 *
 * `assayerLifecycleLabel` covers the lifecycle values, but two of these are not lifecycle values:
 * a death is filed as INACTIVE with a reason, and LEFT is the honest answer where a record carries
 * a leaving date and nothing saying why. Falling through to the lifecycle labeller for those two
 * printed the raw enum at a person's name.
 */
const DEPARTURE_MODE_LABEL: Record<string, string> = {
  RESIGNED: 'Resigned',
  TERMINATED: 'Terminated',
  DECEASED: 'Died in service',
  LEFT: 'Left — reason not recorded',
};

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
 * The colour a workload figure is printed in.
 *
 * Lifted out of the row so the percentage and the status word beside it cannot come out in
 * different colours — they are the same judgement twice. `noWorkYet` stands the amber down: when
 * nothing has been assigned to anybody, every row is "idle" and a screen of amber reads as an
 * accusation aimed at people who were never given work.
 */
const workloadTone = (posture: string, noWorkYet: boolean): string => {
  if (noWorkYet) return 'var(--text-muted)';
  if (posture === 'OVER_UTILIZED') return 'var(--danger)';
  if (posture === 'UNDER_UTILIZED' || posture === 'IDLE') return 'var(--warning)';
  return 'var(--success)';
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
  const attrition = attritionExplainer(d.attrition);
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
          {/* The tile said "Under-utilised" while the Status column beneath it, for exactly the same
            people, said "Room for more". Two words for one set on one screen. The tile now uses the
            column's words. */}
          <Stat value={d.utilisation.utilizationCounts.underUtilized} caption="Room for more work" tone={d.utilisation.utilizationCounts.underUtilized ? 'var(--warning)' : undefined} />
          <Stat value={d.utilisation.utilizationCounts.idle} caption="No work at all" tone={d.utilisation.utilizationCounts.idle ? 'var(--warning)' : undefined} />
        </div>
        {d.utilisation.utilization.length === 0 ? (
          <Empty>Nobody is on the active roster yet, so there is no workload to measure. Add people in Roster first.</Empty>
        ) : (
          <DataTable
            density="compact"
            minWidth={false}
            rows={d.utilisation.utilization}
            rowKey={(r) => r.id}
            columns={[
              // "Loaded" and "Util %" are the model's words, not a clerk's: "Loaded 3 / 6" reads as
              // a fraction of nothing in particular, and "Util %" is an abbreviation of a word this
              // audience does not use. The headers say what the cell beneath them contains.
              { key: 'who', header: 'Assayer', render: (r) => <strong>{r.displayName}</strong> },
              { key: 'where', header: 'Location', render: (r) => <>{[r.district, r.state].filter(Boolean).join(', ') || '—'}</> },
              { key: 'load', header: 'Jobs now / can take', render: (r) => <>{r.currentAllocation} / {r.weeklyCapacity}</> },
              { key: 'spare', header: 'Spare capacity', render: (r) => <>{r.remainingCapacity > 0 ? `${r.remainingCapacity} free` : 'at limit'}</> },
              {
                key: 'pct',
                header: 'Share of capacity used',
                render: (r) => <strong style={{ color: workloadTone(r.posture, noWorkYet) }}>{r.utilizationPercentage}%</strong>,
              },
              {
                key: 'posture',
                header: 'Status',
                render: (r) => (
                  <span style={{ color: workloadTone(r.posture, noWorkYet), fontSize: '12px', fontWeight: 600 }}>
                    {WORKLOAD_POSTURE[r.posture] ?? r.posture}
                  </span>
                ),
              },
              { key: 'open', header: '', render: (r) => <OpenLink onClick={() => navigate(`/assayers/${r.id}`)} /> },
            ]}
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
          <DataTable
            density="compact"
            minWidth={false}
            rows={d.utilisation.idle}
            rowKey={(r) => r.id}
            columns={[
              { key: 'who', header: 'Assayer', render: (r) => <strong>{r.displayName}</strong> },
              { key: 'where', header: 'Location', render: (r) => <>{r.state ?? '—'}</> },
              {
                key: 'last',
                header: 'Last assignment',
                render: (r) => (r.lastAssignmentDate
                  ? <>{fmtDate(r.lastAssignmentDate)}</>
                  : <span style={{ color: 'var(--warning)' }}>never</span>),
              },
              { key: 'idle', header: 'Idle', render: (r) => <>{r.daysIdle === null ? '—' : `${r.daysIdle}d`}</> },
              { key: 'total', header: 'Lifetime jobs', render: (r) => <>{r.totalAssignments ?? 0}</> },
              { key: 'open', header: '', render: (r) => <OpenLink onClick={() => navigate(`/assayers/${r.id}`)} /> },
            ]}
          />
        )}
      </section>

      <section style={card}>
        <div style={{ ...label, marginBottom: '10px' }}>People who have left</div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
          <Stat value={d.attrition.exits90d} caption="Exits (90 days)" />
          <Stat value={d.attrition.exits12m} caption="Exits (12 months)" />
          <Stat value={d.attrition.terminations} caption="Terminations" />
          <Stat value={d.attrition.joins90d} caption="Joins (90 days)" />
          {/*
            The same percentage the Overview tile prints, so it gets the same sentence under it —
            this one said "as a percentage of the people on the books" and named no numbers at
            all, which is a description of a formula rather than an account of this figure.
          */}
          <Stat value={`${d.attrition.attritionRate12m}%`} caption="Share of the roster, past year"
            hint={attrition.hint} />
        </div>
        {/*
          The leavers the percentage cannot hold, printed beside the exit counts they contradict.
          "Exits (12 months)" and "Share of the roster" both leave these people out, and this is
          the only screen that shows the two side by side — so it is the screen where the gap
          would otherwise look like an error in one of them.
        */}
        {attrition.unaccounted && (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '12px' }}>
            {attrition.unaccounted}
          </div>
        )}
        {d.attrition.recent.length === 0 ? (
          <Empty>
            Nobody has left. People appear here once an exit or termination date is recorded on their record;
            joining and exit dates are largely unfilled today, so tenure figures are thin.
          </Empty>
        ) : (
          <DataTable
            density="compact"
            minWidth={false}
            rows={d.attrition.recent}
            rowKey={(r) => r.id}
            columns={[
              { key: 'who', header: 'Assayer', render: (r) => <strong>{r.displayName}</strong> },
              { key: 'state', header: 'State', render: (r) => <>{r.state ?? '—'}</> },
              { key: 'joined', header: 'Joined', render: (r) => <>{fmtDate(r.joiningDate)}</> },
              { key: 'left', header: 'Left', render: (r) => <>{fmtDate(r.exitDate)}</> },
              {
                key: 'mode',
                header: 'How they left',
                /**
                 * Four outcomes, not two.
                 *
                 * The server derived this from `termination_date`, a column that is NULL on every
                 * row, so every departure arrived here as 'RESIGNED' and the TERMINATED branch of
                 * this very expression was unreachable. On the live roster that mislabelled 315 of
                 * 421 departures — including three people who had died, listed as resigned. It
                 * reads from the lifecycle now, and can also say DECEASED, or LEFT where a record
                 * carries a leaving date and nothing saying why.
                 *
                 * DECEASED is deliberately not coloured as a danger: red here marks a decision
                 * that went badly, and a bereavement is not one. Plain tone, honest word.
                 */
                render: (r) => (
                  <span style={{
                    color: r.mode === 'TERMINATED' ? 'var(--danger)' : 'var(--text-muted)',
                    fontSize: '12px',
                    fontWeight: 600,
                  }}>
                    {DEPARTURE_MODE_LABEL[r.mode] ?? assayerLifecycleLabel(r.mode)}
                  </span>
                ),
              },
            ]}
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
