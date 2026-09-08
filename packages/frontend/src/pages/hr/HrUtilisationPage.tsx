import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Stat, Empty, OpenLink, fmtDate, attritionExplainer, Section, Lede } from './hr-ui';
import { DataTable, SearchInput } from '../../components/ui';
import { counted } from '../../utils/plural';
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
  /**
   * The person-by-person table below is the whole active roster, uncapped — five hundred rows
   * with no way to narrow them is a wall, not a worklist. A clerk hunting the over-capacity
   * few typed nothing and scrolled; now a name/state search and a posture pick narrow it, and
   * the line under them says how many of the roster are on screen.
   */
  const [workloadQuery, setWorkloadQuery] = useState('');
  const [workloadPosture, setWorkloadPosture] = useState<'ALL' | keyof typeof WORKLOAD_POSTURE>('ALL');
  const workloadRows = d.utilisation.utilization.filter((r) => {
    if (workloadPosture !== 'ALL' && r.posture !== workloadPosture) return false;
    const q = workloadQuery.trim().toLowerCase();
    if (!q) return true;
    return `${r.displayName} ${r.state ?? ''} ${r.district ?? ''}`.toLowerCase().includes(q);
  });
  const POSTURE_FILTERS = [
    { key: 'ALL', label: 'Everyone', count: d.utilisation.utilizationCounts.total },
    { key: 'OVER_UTILIZED', label: 'Over capacity', count: d.utilisation.utilizationCounts.overUtilized },
    { key: 'UNDER_UTILIZED', label: 'Room for more', count: d.utilisation.utilizationCounts.underUtilized },
    { key: 'IDLE', label: 'No work at all', count: d.utilisation.utilizationCounts.idle },
  ] as const;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <Lede>
        {noWorkYet
          ? 'Who is busy, who is idle and who has left — none of it measurable yet, because no work has been assigned to anybody.'
          : `Who is carrying too much, who is carrying nothing, and who has gone. ${
            d.utilisation.utilizationCounts.overUtilized > 0
              ? `${counted(d.utilisation.utilizationCounts.overUtilized, 'person is', 'people are')} over capacity — move work off them before the next planning run.`
              : d.utilisation.idleCount > 0
                ? `${counted(d.utilisation.idleCount, 'person has', 'people have')} had no work in ${d.utilisation.idleAfterDays} days.`
                : 'Nobody is over capacity and nobody is sitting idle.'}`}
      </Lede>

      {/* The Lede above already says nothing is measurable yet and where work is created —
          repeating it as a Notice doubled the same paragraph. The in-section breakdown and the
          Idle table below carry the figures; the five-tile summary that used to sit here
          repeated them a third time (idle, never-assigned) beside ratings that are not workload. */}
      <Section title="Workload, person by person" count={d.utilisation.utilizationCounts.total}>
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
          <>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px' }}>
              <SearchInput
                value={workloadQuery}
                onChange={setWorkloadQuery}
                placeholder="Find a person or place…"
                compact
                style={{ minWidth: '200px', flex: '1 1 220px' }}
              />
              {POSTURE_FILTERS.map((f) => {
                const on = workloadPosture === f.key;
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setWorkloadPosture(f.key)}
                    aria-pressed={on}
                    style={{
                      padding: '5px 10px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                      borderRadius: '999px',
                      border: `1px solid ${on ? 'var(--accent)' : 'var(--border-color)'}`,
                      background: on ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                      color: on ? 'var(--accent)' : 'var(--text-secondary)',
                    }}
                  >
                    {f.label} · {f.count}
                  </button>
                );
              })}
            </div>
            {(workloadQuery.trim() || workloadPosture !== 'ALL') && (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                Showing {workloadRows.length} of {d.utilisation.utilization.length} people.
              </div>
            )}
            <DataTable
              density="compact"
              minWidth={false}
              rows={workloadRows}
              rowKey={(r) => r.id}
              emptyState={(
                <Empty>
                  Nobody on the roster matches that. Clear the search or pick Everyone above.
                </Empty>
              )}
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
          </>
        )}
      </Section>

      <Section
        title={noWorkYet ? 'Waiting for their first job' : 'Idle and never-deployed'}
        // The true total, not the length of the table beneath it — the table is capped at 50
        // rows server-side (see hr-workforce.service.ts's `utilisation()`), and a count that only
        // ever reads "however many rows fit" is how HR's own dashboard once understated this by
        // more than 10x (50 shown, 542 real) with nothing on screen suggesting it was capped.
        count={d.utilisation.idleCount}
        hint={d.utilisation.idle.length < d.utilisation.idleCount
          ? `Showing the longest-idle ${d.utilisation.idle.length} of ${d.utilisation.idleCount}.`
          : undefined}
      >
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
      </Section>

      <Section title="People who have left" count={d.attrition.recent.length}>
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
      </Section>
    </div>
  );
};

// ── Activity ───────────────────────────────────────────────────────────────

export const HrUtilisationPage: React.FC = () => {
  const { data: d } = useHr();
  const navigate = useNavigate();
  return <UtilisationTabBody d={d} navigate={navigate} />;
};
