import React from 'react';
import { ShieldAlert, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { AssayerLifecycleStatus, assayerLifecycleLabel } from '@fapoms/shared';
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

export const DeploymentReadinessCard: React.FC<DeploymentReadinessCardProps> = ({
  assayer,
  dossier,
  planningSnapshot,
  onNavigateTab,
  onInspectDocuments,
  onInspectVetting,
}) => {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const handleNavDocs = onInspectDocuments || (() => onNavigateTab && onNavigateTab('documents'));
  const handleNavVetting = onInspectVetting || (() => onNavigateTab && onNavigateTab('vetting'));
  void handleNavDocs;
  void handleNavVetting;

  // Backend-authoritative deployment readiness & blockers
  if (dossier?.deploymentBlockers && dossier.deploymentBlockers.length > 0) {
    blockers.push(...dossier.deploymentBlockers);
  }

  const lifecycle = assayer.lifecycleStatus;

  // 1. Canonical lifecycle status check
  if (lifecycle !== AssayerLifecycleStatus.ACTIVE) {
    if (lifecycle === AssayerLifecycleStatus.SUSPENDED) {
      blockers.push('Suspended: Disciplinary action blocks all assignments and sign-in');
    } else if (lifecycle === AssayerLifecycleStatus.RESIGNED || lifecycle === AssayerLifecycleStatus.TERMINATED) {
      blockers.push(`Departed (${assayerLifecycleLabel(lifecycle)}): Record closed; rehire path required`);
    } else if (lifecycle === AssayerLifecycleStatus.ON_LEAVE) {
      blockers.push('On Leave: Temporarily marked unavailable for field dispatch');
    } else if (lifecycle === AssayerLifecycleStatus.INACTIVE) {
      blockers.push('Inactive: Parked from operational planning');
    } else {
      blockers.push(`Onboarding in progress (${assayerLifecycleLabel(lifecycle)})`);
    }
  }

  // 2. Unavailability check
  if (assayer.unavailableReason) {
    blockers.push(`Explicitly unavailable: ${assayer.unavailableReason}`);
  }

  // 3. Location/Pin blocker (only checked if backend did not already supply blockers)
  if (!dossier?.deploymentBlockers && (assayer.latitude == null || assayer.longitude == null)) {
    blockers.push('Missing home base coordinate (blocks automated distance filtering)');
  }

  // 4. Dossier facts (Identity compliance & Empanelment readiness)
  let plannableEmpanelmentCount = 0;
  if (dossier) {
    const onboarding = dossier.onboarding || [];
    const panDoc = onboarding.find((r) => r.requirement === 'PAN_CARD');
    const aadhaarFront = onboarding.find((r) => r.requirement === 'AADHAAR_FRONT');

    if (panDoc && panDoc.verificationStatus !== 'VERIFIED') {
      warnings.push('PAN Card scan is unverified or rejected');
    }
    if (aadhaarFront && aadhaarFront.verificationStatus !== 'VERIFIED') {
      warnings.push('Aadhaar scan is unverified or rejected');
    }

    const empanelments = dossier.empanelments || [];
    plannableEmpanelmentCount = empanelments.filter(
      (e) => e.status === 'ACTIVE' || e.status === 'RECOMMENDED',
    ).length;

    if (empanelments.length > 0 && plannableEmpanelmentCount === 0) {
      warnings.push('0 client bank empanelments in plannable standing (Active or Recommended)');
    }
  }

  // 5. Workload capacity
  const remainingCapacity = planningSnapshot?.workload?.remaining ?? null;
  if (remainingCapacity !== null && remainingCapacity <= 0) {
    warnings.push('Weekly workload capacity is full (0 slots remaining)');
  }

  const isDeployable = dossier && typeof dossier.deployable === 'boolean'
    ? dossier.deployable && blockers.length === 0
    : blockers.length === 0;

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
            background: isDeployable ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)',
            color: isDeployable ? 'var(--success)' : 'var(--danger)',
            border: `1px solid ${isDeployable ? 'var(--success)' : 'var(--danger)'}`,
          }}
        >
          {isDeployable ? (
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

      {/* Blockers Section */}
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

      {isDeployable && warnings.length === 0 && (
        <div style={{ fontSize: '12px', color: 'var(--success)' }}>
          Profile meets all baseline operational and compliance gates for assignment dispatch.
        </div>
      )}
    </div>
  );
};
