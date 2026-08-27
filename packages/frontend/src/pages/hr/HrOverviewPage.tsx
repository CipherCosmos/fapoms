import React from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { card, label, Stat, Bar, SEVERITY, actionAreaLabel } from './hr-ui';
import type { HrAction, HrWorkforceOverview } from '../../hooks/useHrWorkforce';
import { useHr, resolveHrDestination } from './HrLayout';

/**
 * The workforce position at a glance, and the worklist that comes out of it.
 *
 * Previously a tab inside the single HR workspace. It now has its own URL, so it can be linked
 * to from a worklist, bookmarked by whoever owns that part of the job, and grow the controls
 * that job needs without competing for room with seven other concerns.
 */

const OverviewTabBody = ({ d, onJump }: { d: HrWorkforceOverview; onJump: (to: string) => void }) => {
  // Nobody has ever been assigned work, so idleness is the absence of assignments rather than a
  // performance signal. Kept in step with the same test on the Workload screen.
  const neverWorked =
    d.utilisation.performance.totalAssignments === 0 &&
    d.utilisation.idleCount === d.utilisation.neverAssigned;
  return (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
    <section>
      <div style={{ ...label, marginBottom: '8px' }}>Needs attention</div>
      {d.actions.length === 0 ? (
        <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--success)' }}>
          <CheckCircle2 size={18} /> Nothing outstanding — records are complete, onboarding is moving and every territory is covered.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: '10px' }}>
          {d.actions.map((a: HrAction, i) => {
            const s = SEVERITY[a.severity] ?? SEVERITY.low;
            // The backend hands these as paths (`/hr/records`, `/hr/compliance`, …) — see
            // hr-workforce.service.ts. This used to parse them for a `?tab=` value that has not
            // been in them for a long while, so every card silently fell back to 'overview' and
            // the worklist bounced you back to the page you were already on. Resolve the link
            // properly instead, through the same map that forwards legacy URLs, so a card now
            // lands on the merged page with the right filter chip already selected.
            const target = resolveHrDestination(a.link);
            return (
              <button
                key={i}
                onClick={() => onJump(target)}
                style={{ ...card, textAlign: 'left', cursor: 'pointer', borderLeft: `3px solid ${s.fg}`, display: 'flex', gap: '10px', alignItems: 'flex-start' }}
              >
                <AlertTriangle size={15} style={{ color: s.fg, flexShrink: 0, marginTop: '2px' }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '3px' }}>
                    <span style={{ fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: s.bg, color: s.fg }}>{s.label}</span>
                    <span style={{ ...label, fontSize: '10px' }}>{actionAreaLabel(a.area)}</span>
                  </div>
                  <div style={{ fontSize: '13px', fontWeight: 600 }}>{a.title}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{a.detail}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>

    <section style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
      {/*
        Two populations sit side by side on this row and nothing said so.
        
        "Total on roster" is everybody, including people who have left — 1,163 on the imported
        roster. Every compliance figure counts only those still workable (`ON_ROSTER`: active,
        not exited, not terminated), which is 717 of them, because chasing a bank account for
        somebody who resigned last year is not a task. Both numbers are right; reading "709 of
        717" under a tile saying 1,163 is what made them look wrong.
      */}
      <Stat
        value={d.headcount.total}
        caption="Total on roster"
        hint={d.headcount.total !== d.compliance.roster
          ? `Everyone on the books. The record and paperwork figures below count the ${d.compliance.roster} who can still be given work — people who have left are not chased for missing details.`
          : 'Everyone on the books'}
      />
      <Stat value={d.headcount.active} caption="Active" tone="var(--success)" />
      <Stat value={d.pipeline.inProgress} caption="In onboarding" tone={d.pipeline.inProgress ? 'var(--warning)' : undefined} />
      <Stat
        value={`${d.compliance.roster - d.compliance.incompleteCount}/${d.compliance.roster}`}
        caption="Records complete"
        tone={d.compliance.incompleteCount ? 'var(--warning)' : 'var(--success)'}
        hint={`Of the ${d.compliance.roster} people who can still be given work, how many have every critical field filled in — payroll, duty-of-care and the map location the planner needs to judge distance. People who have left are not counted.`}
      />
      {/* "Idle > 30d" said the team had stopped working. With no assignments in the system at all,
          every one of those people is simply waiting for a first job, and the amber accused them of
          something the data cannot show. Same figure, honest caption — and it now uses the same words
          as the Workload chip it sends you to, rather than a shorthand only this tile used. */}
      <Stat
        value={d.utilisation.idleCount}
        caption={neverWorked ? 'Waiting for their first job' : `No work in ${d.utilisation.idleAfterDays} days`}
        tone={neverWorked ? undefined : d.utilisation.idleCount ? 'var(--warning)' : undefined}
        hint={neverWorked ? 'No work has been assigned to anyone yet — assign branches in Planning' : undefined}
      />
      {/* "Attrition (12m)" is a percentage with no stated denominator and no stated period in
          words. A clerk could not tell whether 12% meant twelve people or twelve per cent of what,
          over which twelve months. Same number, said out loud, with the headcount behind it on
          hover — and the raw count of leavers alongside, which is the figure anyone actually
          repeats in a meeting. */}
      <Stat
        value={`${d.attrition.attritionRate12m}%`}
        caption="Left in the past year"
        // The denominator the rate was actually divided by. This used to quote
        // `headcount.total`, a different population — so a tile reading 25% was explained
        // underneath by two numbers that work out to 20%.
        hint={`${d.attrition.exits12m} ${d.attrition.exits12m === 1 ? 'person has' : 'people have'} left in the last 12 months, out of ${d.attrition.averageHeadcount12m} on the roster over that period`}
      />
    </section>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '14px' }}>
      <section style={card}>
        <div style={{ ...label, marginBottom: '12px' }}>Joining, stage by stage</div>
        {d.pipeline.stages.map((s) => (
          <div key={s.key} style={{ marginBottom: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
              <span>{s.label}</span>
              <span style={{ color: 'var(--text-muted)' }}>
                {s.count}{s.stalled > 0 && <span style={{ color: 'var(--warning)' }}> · {s.stalled} waiting too long</span>}
              </span>
            </div>
            <Bar pct={d.headcount.total ? (s.count / d.headcount.total) * 100 : 0} tone={s.stalled ? 'var(--warning)' : 'var(--accent)'} />
          </div>
        ))}
      </section>

      <section style={card}>
        <div style={{ ...label, marginBottom: '12px' }}>Record completeness</div>
        {d.compliance.fields.slice(0, 6).map((f) => (
          <div key={f.column} style={{ marginBottom: '10px' }} title={f.blocks}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
              <span>{f.label}{f.critical && <span style={{ color: 'var(--danger)' }}> *</span>}</span>
              <span style={{ color: 'var(--text-muted)' }}>{f.have}/{d.compliance.roster}</span>
            </div>
                <Bar pct={f.pct} tone={f.pct === 100 ? 'var(--success)' : f.critical ? 'var(--danger)' : 'var(--warning)'} />
          </div>
        ))}
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '10px' }}>
          <span style={{ color: 'var(--danger)' }}>*</span> blocks payroll, statutory filing or duty-of-care
        </div>
      </section>
    </div>
  </div>
  );
};

// ── Onboarding ─────────────────────────────────────────────────────────────

export const HrOverviewPage: React.FC = () => {
  const { data: d } = useHr();
  const navigate = useNavigate();
  return <OverviewTabBody d={d} onJump={(to: string) => navigate(to)} />;
};
