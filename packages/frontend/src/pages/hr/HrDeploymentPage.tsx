import React from 'react';
import { Link } from 'react-router-dom';
import { card, label, Stat, Empty, POSTURE } from './hr-ui';
import { DataTable } from '../../components/ui';
import type { HrWorkforceOverview } from '../../hooks/useHrWorkforce';
import { useHr } from './HrLayout';

/**
 * Where the workforce sits against where the work is.
 *
 * Previously a tab inside the single HR workspace. It now has its own URL, so it can be linked
 * to from a worklist, bookmarked by whoever owns that part of the job, and grow the controls
 * that job needs without competing for room with seven other concerns.
 */

const DeploymentTabBody = ({ d }: { d: HrWorkforceOverview }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
    <div style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: '86ch' }}>
      Branches carry the work and assayers carry the capacity, so the gap between them is the
      hiring brief. Open a state to see its people on the roster.
    </div>

    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
      <Stat value={d.deployment.hiringNeeded.length} caption="States that need more people" tone={d.deployment.hiringNeeded.length ? 'var(--danger)' : 'var(--success)'} />
      {/* This counts states whose posture is NO_WORK — assayers living where we have no branches at
          all. It used to be captioned "no local work", which reads as "they are idle" and collides
          with the Workload chip's idle figure; the two count different things. */}
      <Stat value={d.deployment.idleTerritories.length} caption="States with people but no branches" tone={d.deployment.idleTerritories.length ? 'var(--warning)' : undefined} />
    </div>

    <section style={card}>
      <div style={{ ...label, marginBottom: '10px' }}>Supply vs demand by state</div>
      {d.deployment.territories.length === 0 ? (
        <Empty>
          No states to compare yet. A state appears here as soon as it has either a project branch or an
          assayer on the roster; branches arrive with a project import, people arrive from Roster.
        </Empty>
      ) : (
      <DataTable
        density="compact"
        minWidth={false}
        rows={d.deployment.territories}
        rowKey={(t) => t.state}
        columns={[
          { key: 'state', header: 'State', render: (t) => <strong>{t.state}</strong> },
          {
            key: 'people',
            header: '',
            render: (t) => (
              <Link
                to={`/hr/roster?f_state=${encodeURIComponent(t.state)}`}
                title={`See everyone living in ${t.state} on the roster`}
                style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent)', whiteSpace: 'nowrap' }}
              >
                See people →
              </Link>
            ),
          },
          { key: 'branches', header: 'Branches', render: (t) => <>{t.branches}</> },
          { key: 'assayers', header: 'Assayers', render: (t) => <>{t.assayers}</> },
          { key: 'active', header: 'Active', render: (t) => <>{t.active}</> },
          { key: 'per', header: 'Branches per assayer', render: (t) => <>{t.branchesPerAssayer ?? '—'}</> },
          {
            key: 'posture',
            // "Posture" is the backend's word for this column and means nothing to a clerk; the
            // values under it ("No coverage", "Stretched") already say it plainly.
            header: 'Position',
            render: (t) => {
              const p = POSTURE[t.posture] ?? POSTURE.BALANCED;
              return <span title={p.hint} style={{ fontSize: '12px', fontWeight: 700, color: p.fg }}>{p.label}</span>;
            },
          },
        ]}
      />
      )}
    </section>
  </div>
);

// ── Utilisation ────────────────────────────────────────────────────────────

export const HrDeploymentPage: React.FC = () => {
  const { data: d } = useHr();

  return <DeploymentTabBody d={d} />;
};
