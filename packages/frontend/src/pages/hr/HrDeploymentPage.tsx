import React from 'react';
import { card, label, Stat, Empty, Table, POSTURE } from './hr-ui';
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
      <Stat value={d.deployment.hiringNeeded.length} caption="States that need more people" tone={d.deployment.hiringNeeded.length ? 'var(--danger)' : 'var(--success)'} />
      {/* "Territories in play" is a sales phrase for a plain fact: every state that has either a
          branch to visit or somebody living there. */}
      <Stat value={d.deployment.territories.length} caption="States with work or people"
        hint="Counted once for each state that has at least one branch or one assayer" />
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
      <Table
        // "Posture" is the backend's word for this column and means nothing to a clerk; the values
        // under it ("No coverage", "Stretched") already say it plainly.
        head={['State', 'Branches', 'Assayers', 'Active', 'Branches per assayer', 'Position']}
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
      )}
    </section>
  </div>
);

// ── Utilisation ────────────────────────────────────────────────────────────

export const HrDeploymentPage: React.FC = () => {
  const { data: d } = useHr();

  return <DeploymentTabBody d={d} />;
};
