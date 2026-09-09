import React from 'react';
import { ShieldAlert, CheckCircle2, AlertTriangle, XCircle, HelpCircle } from 'lucide-react';
import { assayerLifecycleLabel, standingAllowsPlanning } from '@fapoms/shared';
import type { Assayer } from '../assayer-shared';
import type { AssayerDossier, PlanningSnapshot } from './record-types';

export interface DeploymentReadinessCardProps {
  assayer: Assayer;
  dossier: AssayerDossier | null;
  planningSnapshot?: PlanningSnapshot | null;
  onNavigateTab?: (tab: string) => void;
  onInspectDocuments?: () => void;
  onInspectVetting?: () => void;
}

/**
 * WHAT THE SERVER SAYS, AND NOTHING ELSE.
 *
 * This card has always been labelled "(Backend-Authoritative)" and has always branched on
 * `dossier.deployable` and `dossier.deploymentBlockers`. The dossier endpoint returned neither, so
 * both read `undefined` and the label was simply untrue: the verdict fell back to a rulebook this
 * component kept for itself — lifecycle, an explicit `unavailableReason`, and a missing lat/lng —
 * while everything else it displayed was demoted to a *warning*, and warnings never touched the
 * badge.
 *
 * What that produced, in the live UI: somebody ACTIVE with a coordinate, no bank account, no IFSC,
 * no PAN, no verified identity document and ZERO client empanelments got a green **Deployable**
 * badge, at the same moment the planning engine was refusing that same person outright with
 * "planning requires an Active or Recommended empanelment standing". A coordinator reading this
 * card would ring somebody the dispatch surface will not let them send.
 *
 * `RosterRecordsService.deploymentVerdict` now composes the real gates — the candidate-pool
 * predicate, `DeployabilityFilter`, `ClientEligibilityFilter`, `identityStanding`, `cannotBePaid`
 * — and emits the answer with the blockers already written as sentences. So this component holds
 * NO eligibility rules of its own. It has three jobs: render the verdict, render the blockers, and
 * — the part the old fallback got most wrong — say plainly when it has not been given an answer at
 * all rather than defaulting to green.
 *
 * That last case is real and not merely defensive: the dossier is ADMIN/OPERATIONS only, and
 * `AssayerRecord` swallows the 403 with `catch(() => {})`, leaving `dossier` null for everybody
 * else. Under the old code that null was indistinguishable from "no blockers found", so the one
 * viewer with the least information was shown the most confident answer.
 */
export const DeploymentReadinessCard: React.FC<DeploymentReadinessCardProps> = ({
  assayer,
  dossier,
  planningSnapshot,
  onNavigateTab,
  onInspectDocuments,
  onInspectVetting,
}) => {
  const handleNavDocs = onInspectDocuments || (() => onNavigateTab && onNavigateTab('documents'));
  const handleNavVetting = onInspectVetting || (() => onNavigateTab && onNavigateTab('vetting'));
  void handleNavDocs;
  void handleNavVetting;

  /**
   * Three states, not two. `answered` is false when the dossier has not loaded, failed, or came
   * back from a server old enough not to carry the verdict — and in every one of those the honest
   * thing to draw is "we do not know", because this card has deliberately kept no way to work it
   * out for itself.
   */
  const answered = !!dossier && typeof dossier.deployable === 'boolean';
  const blockers: string[] = (dossier?.deploymentBlockers ?? []).filter(Boolean);
  const isDeployable = answered && dossier!.deployable === true;

  const warnings: string[] = [];

  /**
   * A full week is not a permanent bar, so it stays a warning and stays here rather than moving to
   * the server: `deployable` is a fact about the person, and this is a fact about one week. It is
   * also the only thing on this card that comes from the planning snapshot rather than the
   * dossier.
   */
  const remainingCapacity = planningSnapshot?.workload?.remaining ?? null;
  if (remainingCapacity !== null && remainingCapacity <= 0) {
    warnings.push('Weekly workload capacity is full (0 slots remaining)');
  }

  // A count for the readout beside the verdict, through the planner's own predicate rather than a
  // hand-written `=== 'ACTIVE' || === 'RECOMMENDED'`: DOCUMENTS_PENDING and INACTIVE are neither
  // refusals nor plannable, and that is exactly the distinction a second copy of the list loses.
  const plannableEmpanelmentCount = (dossier?.empanelments ?? [])
    .filter((e) => standingAllowsPlanning(e.status)).length;

  const verdictTone = !answered
    ? { bg: 'var(--bg-surface-2)', fg: 'var(--text-muted)', border: 'var(--border-color)' }
    : isDeployable
      ? { bg: 'var(--status-active-bg)', fg: 'var(--success)', border: 'var(--success)' }
      : { bg: 'var(--status-cancelled-bg)', fg: 'var(--danger)', border: 'var(--danger)' };

  return (
    <div
      data-testid="deployment-readiness-card"
      style={{
        background: 'var(--bg-surface-1)',
        border: '1px solid var(--border-color)',
        borderRadius: '10px',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
            Deployment Readiness
          </span>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>(Backend-Authoritative)</span>
        </div>
        <div
          data-testid="readiness-verdict-badge"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            padding: '3px 10px',
            borderRadius: '999px',
            fontSize: '11.5px',
            fontWeight: 700,
            background: verdictTone.bg,
            color: verdictTone.fg,
            border: `1px solid ${verdictTone.border}`,
          }}
        >
          {!answered ? (
            <>
              <HelpCircle size={13} /> Readiness Unavailable
            </>
          ) : isDeployable ? (
            <>
              <CheckCircle2 size={13} /> Deployable
            </>
          ) : (
            <>
              <XCircle size={13} /> Blocked from Deployment
            </>
          )}
        </div>
      </div>

      {/* Primary Status & Capacity Readout */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '10px',
          background: 'var(--bg-surface-2)',
          padding: '10px 12px',
          borderRadius: '8px',
          fontSize: '12px',
        }}
      >
        <div>
          <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '11px' }}>Lifecycle Stage</span>
          <strong style={{ color: 'var(--text-primary)' }}>{assayerLifecycleLabel(assayer.lifecycleStatus)}</strong>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '11px' }}>Active Banks</span>
          <strong style={{ color: 'var(--text-primary)' }}>
            {plannableEmpanelmentCount} plannable
          </strong>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '11px' }}>Spare Workload</span>
          <strong style={{ color: 'var(--text-primary)' }}>
            {remainingCapacity !== null ? `${remainingCapacity} slots` : '—'}
          </strong>
        </div>
      </div>

      {/* Blockers Section — the server's list, verbatim and in its order. */}
      {blockers.length > 0 && (
        <div
          data-testid="deployment-blockers-list"
          style={{
            background: 'var(--status-cancelled-bg)',
            border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)',
            borderRadius: '8px',
            padding: '10px 12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: 'var(--danger)' }}>
            <ShieldAlert size={14} />
            Blocking Reasons:
          </div>
          <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: '12px', color: 'var(--text-primary)' }}>
            {blockers.map((b, idx) => (
              <li key={idx} style={{ marginBottom: '2px' }}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Warnings / Attention */}
      {warnings.length > 0 && (
        <div
          data-testid="deployment-warnings-list"
          style={{
            background: 'var(--status-pending-bg)',
            border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)',
            borderRadius: '8px',
            padding: '10px 12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: 'var(--warning)' }}>
            <AlertTriangle size={14} />
            Compliance Attention:
          </div>
          <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: '12px', color: 'var(--text-primary)' }}>
            {warnings.map((w, idx) => (
              <li key={idx} style={{ marginBottom: '2px' }}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {!answered && (
        <div data-testid="readiness-unavailable-note" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          The readiness check has not answered for this record — the dossier is still loading, or
          this account is not entitled to read it. Nothing here is a statement that they are clear
          to deploy.
        </div>
      )}

      {isDeployable && warnings.length === 0 && (
        <div style={{ fontSize: '12px', color: 'var(--success)' }}>
          Profile meets all baseline operational and compliance gates for assignment dispatch.
        </div>
      )}
    </div>
  );
};
