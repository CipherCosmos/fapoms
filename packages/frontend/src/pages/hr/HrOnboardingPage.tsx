import React from 'react';
import { useNavigate } from 'react-router-dom';
import { card, label, Stat, Empty, Table, OpenLink, FIELD_LABELS } from './hr-ui';
import type { HrWorkforceOverview } from '../../hooks/useHrWorkforce';
import { useHr } from './HrLayout';

/**
 * Who is part-way through joining, and who has stopped moving.
 *
 * Previously a tab inside the single HR workspace. It now has its own URL, so it can be linked
 * to from a worklist, bookmarked by whoever owns that part of the job, and grow the controls
 * that job needs without competing for room with seven other concerns.
 *
 * It answered "who is stuck" but not "what is stopping them", which is the question the person
 * on this page is actually trying to close. The readiness section below names, per candidate,
 * the fields their record is missing and what each one blocks — the same `compliance` payload
 * this page already receives — so the next click is a fix rather than another look.
 */

/** The lifecycle stages that mean "not yet able to take work"; ACTIVE is the finish line. */
const PRE_ACTIVE_STAGES = new Set(['INVITED', 'DOCUMENT_VERIFICATION', 'BACKGROUND_VERIFICATION', 'TRAINING']);

const OnboardingTabBody = ({ d, navigate }: { d: HrWorkforceOverview; navigate: (path: string) => void }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
      {d.pipeline.stages.map((s) => (
        <Stat key={s.key} value={s.count} caption={s.label} tone={s.stalled ? 'var(--warning)' : undefined}
          hint={s.avgDaysInStage ? `Average ${s.avgDaysInStage} days in this stage` : undefined} />
      ))}
    </div>

    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
      A new hire moves Invited → Document check → Background check → Training → Active. Only an
      Active assayer can be given work, and only once the fields below are on their record.
    </div>

    <ReadinessSection d={d} navigate={navigate} />

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
            <OpenLink onClick={() => navigate(`/hr/roster?assayer=${r.id}`)} />,
          ])}
        />
      )}
    </section>
  </div>
);

/**
 * What is still missing before each in-progress hire can be assigned.
 *
 * Restricted to people who have not reached ACTIVE — the roster-wide version of the same data
 * is the Compliance page's job, and repeating it here would bury the handful of records that
 * someone is actively trying to finish today.
 */
const ReadinessSection = ({ d, navigate }: { d: HrWorkforceOverview; navigate: (path: string) => void }) => {
  // `blocks` explains a missing field in terms of the consequence, which is the part that tells
  // an HR user whether to chase it now; `FIELD_LABELS` covers columns the payload doesn't name.
  const blocksByColumn = new Map(d.compliance.fields.map((f) => [f.column, f]));
  const joining = d.compliance.incomplete.filter((r) => PRE_ACTIVE_STAGES.has(r.lifecycleStatus));
  // The raw lifecycle value is an enum name; the pipeline block already carries the wording
  // used in the stage counters above, so the same word appears in both places on this page.
  const stageLabel = new Map(d.pipeline.stages.map((st) => [st.key, st.label]));

  return (
    <section style={card}>
      <div style={{ ...label, marginBottom: '10px' }}>
        Not yet ready to be assigned ({joining.length})
      </div>
      {joining.length === 0 ? (
        <Empty>
          {d.pipeline.inProgress === 0
            ? 'Nobody is part-way through joining right now.'
            : 'Everyone still joining has a complete record — they only need their stage moved on.'}
        </Empty>
      ) : (
        <Table
          head={['Assayer', 'Stage', 'Still needed', 'What it blocks', 'Location', '']}
          rows={joining.map((r) => {
            const missing = r.missing.map((col) => blocksByColumn.get(col) ?? { label: FIELD_LABELS[col] || col, blocks: '', critical: false });
            return [
              <strong>{r.displayName}</strong>,
              stageLabel.get(r.lifecycleStatus) || r.lifecycleStatus,
              <span>{missing.map((m) => m.label).join(', ')}</span>,
              <span style={{ color: 'var(--text-muted)' }}>
                {Array.from(new Set(missing.map((m) => m.blocks).filter(Boolean))).join('; ') || '—'}
              </span>,
              [r.district, r.state].filter(Boolean).join(', ') || '—',
              <OpenLink onClick={() => navigate(`/hr/roster?assayer=${r.id}`)} label="Fill them in" />,
            ];
          })}
        />
      )}
    </section>
  );
};

// ── Records ────────────────────────────────────────────────────────────────

export const HrOnboardingPage: React.FC = () => {
  const { data: d } = useHr();
  const navigate = useNavigate();
  return <OnboardingTabBody d={d} navigate={navigate} />;
};
