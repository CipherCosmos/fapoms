import React, { useEffect, useRef, useState } from 'react';
import { X, Loader2, CheckCircle2, AlertTriangle, Rocket } from 'lucide-react';
import {
  getCoveragePlanPreview,
  createCoveragePlan,
  transitionCoveragePlan,
  executeCoveragePlan,
  type CoveragePlan,
  type CoveragePlanExecuteResult,
} from '../../services/planning';

/** The computed cluster/capacity preview (loosely typed — we render a stable subset). */
interface CoveragePreview {
  coveragePercentage: number;
  estimatedDurationDays: number;
  estimatedOperationalCost: number;
  requiredWorkforceCount: number;
  availableWorkforceCount: number;
  confidenceScore: number;
  uncoveredBranches: Array<{ branchName?: string; reason?: string }>;
  clusters: Array<{
    name?: string;
    assignedAssayerName: string | null;
    branchIds: string[];
    estimatedTotalFee: number | null;
    branchAssignments?: Array<{
      branchId: string;
      branchName: string;
      assayerId: string | null;
      assayerName: string | null;
      fee: number | null;
      /** 1 = the branch's own top recommendation; >1 means higher ranks were passed over. */
      rank: number | null;
      selectionNote: string | null;
    }>;
  }>;
}

import { money as inr } from '../../utils/money';

/**
 * The coverage-plan lifecycle, surfaced. The backend could always generate → approve → deploy a
 * whole project's assignments in one action; the workspace could only assign one branch or cluster
 * at a time. This drives that flow with a clear preview and an explicit approval gate before the
 * (irreversible) deploy.
 */
export const CoveragePlanModal: React.FC<{
  projectId: string;
  projectName: string;
  onClose: () => void;
  onDeployed: () => void;
}> = ({ projectId, projectName, onClose, onDeployed }) => {
  const [preview, setPreview] = useState<CoveragePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(true);

  const [plan, setPlan] = useState<CoveragePlan | null>(null);
  const [busy, setBusy] = useState<null | 'generate' | 'approve' | 'deploy'>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CoveragePlanExecuteResult | null>(null);

  const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })();
  const [scheduledDate, setScheduledDate] = useState<string>(tomorrow);

  const loadPreview = async () => {
    setLoadingPreview(true);
    setPreviewError(null);
    try {
      setPreview(await getCoveragePlanPreview<CoveragePreview>(projectId));
    } catch (e: any) {
      setPreviewError(e?.message || 'Could not load the coverage plan.');
    } finally {
      setLoadingPreview(false);
    }
  };

  useEffect(() => { void loadPreview(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectId]);

  // onClose is an inline arrow at the call site (a new reference every render of the parent, the
  // busiest-re-rendering page in the app) — held in a ref, as Modal.tsx/DetailDrawer.tsx do, so
  // this effect only runs once rather than tearing down and re-adding the listener constantly.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const run = async (
    phase: 'generate' | 'approve' | 'deploy',
    fn: () => Promise<void>,
  ) => {
    setBusy(phase);
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      setError(e?.message || `Could not ${phase} the plan.`);
    } finally {
      setBusy(null);
    }
  };

  const doGenerate = () => run('generate', async () => { setPlan(await createCoveragePlan(projectId)); });
  const doApprove = () => run('approve', async () => {
    if (!plan) return;
    setPlan(await transitionCoveragePlan(plan.id, 'APPROVED'));
  });
  const doDeploy = () => run('deploy', async () => {
    if (!plan) return;
    const res = await executeCoveragePlan(plan.id, scheduledDate);
    setResult(res);
    onDeployed();
  });

  const status = plan?.status;
  const approved = status === 'APPROVED';

  const stat = (label: string, value: React.ReactNode, tone?: string) => (
    <div style={{ flex: 1, minWidth: '120px', padding: '10px 12px', background: 'var(--bg-surface-2)', borderRadius: '8px' }}>
      <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: '18px', fontWeight: 800, color: tone || 'var(--text-primary)', marginTop: '2px' }}>{value}</div>
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '16px' }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="coverage-plan-title"
        style={{ width: 'min(680px, 100%)', maxHeight: '90vh', overflowY: 'auto', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
          <div>
            <div id="coverage-plan-title" style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>Coverage Plan — {projectName}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
              Generate → approve → deploy the whole project's assignments in one flow.
            </div>
          </div>
          <button onClick={onClose} className="btn btn-secondary" style={{ padding: '6px', lineHeight: 0 }} aria-label="Close"><X size={16} /></button>
        </div>

        {/* Preview */}
        {loadingPreview ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)', padding: '20px', justifyContent: 'center' }}>
            <Loader2 size={16} className="spin" /> Analysing coverage…
          </div>
        ) : previewError ? (
          <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', color: 'var(--danger)', fontSize: '13px' }}>
            <AlertTriangle size={18} /> {previewError}
            <button onClick={loadPreview} className="btn btn-secondary" style={{ fontSize: '11px', padding: '4px 10px' }}>Retry</button>
          </div>
        ) : preview ? (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {stat('Coverage', `${preview.coveragePercentage}%`, preview.coveragePercentage >= 90 ? 'var(--success)' : 'var(--warning)')}
              {stat('Clusters', preview.clusters.length)}
              {stat('Assayers needed', preview.requiredWorkforceCount)}
              {stat('Duration', `${preview.estimatedDurationDays}d`)}
              {stat('Est. cost', inr(preview.estimatedOperationalCost))}
              {stat('Confidence', `${preview.confidenceScore}`)}
            </div>
            {preview.uncoveredBranches.length > 0 && (
              <div style={{ padding: '8px 10px', background: 'var(--status-cancelled-bg)', borderRadius: '6px', fontSize: '11.5px', color: 'var(--danger)' }}>
                <AlertTriangle size={12} style={{ verticalAlign: '-2px' }} /> {preview.uncoveredBranches.length} branch(es) cannot be covered by this plan and will be skipped on deploy.
              </div>
            )}

            {/* Per-branch picks with rank + why. "#2 — #1 at capacity" is an explainable decision;
                without this it is indistinguishable from a wrong pick. */}
            {preview.clusters.some(c => (c.branchAssignments?.length ?? 0) > 0) && (
              <details style={{ border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden' }}>
                <summary style={{ padding: '9px 12px', fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none', background: 'var(--bg-surface-2)' }}>
                  Per-branch assignments ({preview.clusters.reduce((n, c) => n + (c.branchAssignments?.length ?? 0), 0)} branches)
                </summary>
                <div style={{ maxHeight: '260px', overflowY: 'auto', padding: '4px 12px 10px' }}>
                  {preview.clusters.flatMap(c => c.branchAssignments ?? []).map((ba) => (
                    <div key={ba.branchId} style={{ padding: '7px 0', borderBottom: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                        <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ba.branchName}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                          {ba.assayerName ? (
                            <>
                              <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>{ba.assayerName}</span>
                              {ba.rank != null && (
                                <span
                                  title={ba.rank === 1 ? "This branch's own top recommendation" : `Rank #${ba.rank} in this branch's recommendation list — higher ranks were unavailable (see note)`}
                                  style={{ fontSize: '10px', fontWeight: 800, padding: '1px 7px', borderRadius: '8px', background: ba.rank === 1 ? 'var(--status-active-bg)' : 'var(--status-pending-bg)', color: ba.rank === 1 ? 'var(--success)' : 'var(--warning)' }}
                                >
                                  #{ba.rank}
                                </span>
                              )}
                              {ba.fee != null && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{inr(ba.fee)}</span>}
                            </>
                          ) : (
                            <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--danger)' }}>Uncovered</span>
                          )}
                        </span>
                      </div>
                      {ba.selectionNote && (
                        <div style={{ fontSize: '10.5px', color: 'var(--warning)' }}>└─ {ba.selectionNote}</div>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        ) : null}

        {error && (
          <div style={{ padding: '8px 10px', background: 'var(--status-cancelled-bg)', borderRadius: '6px', fontSize: '12px', color: 'var(--danger)' }} role="alert">{error}</div>
        )}

        {/* Result */}
        {result ? (
          <div style={{ padding: '14px', background: 'var(--status-active-bg)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 800, color: 'var(--success)' }}>
              <CheckCircle2 size={18} /> {result.deployedCount} assignment(s) deployed
              {result.skippedCount > 0 && <span style={{ color: 'var(--warning)', fontWeight: 700 }}>· {result.skippedCount} skipped</span>}
            </div>
            {result.skipped.length > 0 && (
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', maxHeight: '120px', overflowY: 'auto' }}>
                {result.skipped.slice(0, 20).map((s, i) => (
                  <div key={i}>• {s.branchId ?? s.clusterId}: {s.reason}</div>
                ))}
              </div>
            )}
            <button onClick={onClose} className="btn btn-primary" style={{ alignSelf: 'flex-start', marginTop: '4px', fontSize: '12px', padding: '6px 14px' }}>Done</button>
          </div>
        ) : (
          /* Lifecycle actions */
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', borderTop: '1px solid var(--border-color)', paddingTop: '14px' }}>
            {!plan && (
              <button onClick={doGenerate} disabled={busy != null || loadingPreview || !!previewError} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {busy === 'generate' ? <Loader2 size={14} className="spin" /> : null} Generate plan version
              </button>
            )}
            {plan && !approved && (
              <>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Version {plan.currentVersion} · <b>{plan.status}</b></span>
                <button onClick={doApprove} disabled={busy != null} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {busy === 'approve' ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />} Approve plan
                </button>
              </>
            )}
            {plan && approved && (
              <>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Version {plan.currentVersion} · <b style={{ color: 'var(--success)' }}>APPROVED</b></span>
                <label style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  Deploy for
                  <input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)}
                    style={{ fontSize: '11px', padding: '3px 6px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }} />
                </label>
                <button onClick={doDeploy} disabled={busy != null} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'var(--success)' }}>
                  {busy === 'deploy' ? <Loader2 size={14} className="spin" /> : <Rocket size={14} />} Deploy whole project
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
