import React from 'react';
import { card, label, Stat, Table, POSTURE } from './hr-ui';
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
    <div style={{ ...card, fontSize: '13px', color: 'var(--text-secondary)' }}>
      Branches carry the work and assayers carry the capacity, so the gap between them is the hiring brief.
      State names are normalised across the branch and assayer imports before comparison — they are spelled
      differently in each source.
    </div>

    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
      <Stat value={d.deployment.hiringNeeded.length} caption="Territories needing hires" tone={d.deployment.hiringNeeded.length ? 'var(--danger)' : 'var(--success)'} />
      <Stat value={d.deployment.territories.length} caption="Territories in play" />
      <Stat value={d.deployment.idleTerritories.length} caption="Assayers with no local work" tone={d.deployment.idleTerritories.length ? 'var(--warning)' : undefined} />
    </div>

    <section style={card}>
      <div style={{ ...label, marginBottom: '10px' }}>Supply vs demand by state</div>
      <Table
        head={['State', 'Branches', 'Assayers', 'Active', 'Branches / assayer', 'Posture']}
        rows={d.deployment.territories.map((t) => {
          const p = POSTURE[t.posture] ?? POSTURE.BALANCED;
          return [
            <strong>{t.state}</strong>,
            t.branches,
            t.assayers,
            t.active,
            t.branchesPerAssayer ?? '—',
            <span title={p.hint} style={{ fontSize: '11px', fontWeight: 700, color: p.fg }}>{p.label}</span>,
          ];
        })}
      />
    </section>
  </div>
);

// ── Utilisation ────────────────────────────────────────────────────────────

export const HrDeploymentPage: React.FC = () => {
  const { data: d } = useHr();

  return <DeploymentTabBody d={d} />;
};
