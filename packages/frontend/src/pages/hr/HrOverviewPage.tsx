import React from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { card, label, Stat, Bar, SEVERITY } from './hr-ui';
import type { HrAction, HrWorkforceOverview } from '../../hooks/useHrWorkforce';
import { useHr } from './HrLayout';

/**
 * The workforce position at a glance, and the worklist that comes out of it.
 *
 * Previously a tab inside the single HR workspace. It now has its own URL, so it can be linked
 * to from a worklist, bookmarked by whoever owns that part of the job, and grow the controls
 * that job needs without competing for room with seven other concerns.
 */

const OverviewTabBody = ({ d, onJump }: { d: HrWorkforceOverview; onJump: (page: string) => void }) => (
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
            const target = (a.link.split('tab=')[1] as string) || 'overview';
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
                    <span style={{ ...label, fontSize: '10px' }}>{a.area}</span>
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
      <Stat value={d.headcount.total} caption="Total on roster" />
      <Stat value={d.headcount.active} caption="Active" tone="var(--success)" />
      <Stat value={d.pipeline.inProgress} caption="In onboarding" tone={d.pipeline.inProgress ? 'var(--warning)' : undefined} />
      <Stat
        value={`${d.compliance.roster - d.compliance.incompleteCount}/${d.compliance.roster}`}
        caption="Records complete"
        tone={d.compliance.incompleteCount ? 'var(--warning)' : 'var(--success)'}
        hint="Assayers with every payroll- and duty-of-care-critical field filled in"
      />
      <Stat
        value={d.utilisation.idleCount}
        caption={`Idle > ${d.utilisation.idleAfterDays}d`}
        tone={d.utilisation.idleCount ? 'var(--warning)' : undefined}
      />
      <Stat value={`${d.attrition.attritionRate12m}%`} caption="Attrition (12m)" />
    </section>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '14px' }}>
      <section style={card}>
        <div style={{ ...label, marginBottom: '12px' }}>Onboarding funnel</div>
        {d.pipeline.stages.map((s) => (
          <div key={s.key} style={{ marginBottom: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
              <span>{s.label}</span>
              <span style={{ color: 'var(--text-muted)' }}>
                {s.count}{s.stalled > 0 && <span style={{ color: 'var(--warning)' }}> · {s.stalled} stalled</span>}
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

// ── Onboarding ─────────────────────────────────────────────────────────────

export const HrOverviewPage: React.FC = () => {
  const { data: d } = useHr();
  const navigate = useNavigate();
  return <OverviewTabBody d={d} onJump={(t: string) => navigate(t === "overview" ? "/hr" : `/hr/${t}`)} />;
};
