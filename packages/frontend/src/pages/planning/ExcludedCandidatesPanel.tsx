import React, { useState } from 'react';

export interface ExcludedCandidate {
  assayerId: string;
  displayName: string;
  reason: string;
  detail?: string;
}

/**
 * Candidates the engine filtered out, and why.
 *
 * Display used to be the whole story — but the filters are advisory (proximity floor, workload,
 * soft rules), and a human often knows a filtered assayer is the right call. `onAssignAnyway` makes
 * each row actionable: assign the excluded candidate to the current branch with a recorded reason,
 * so the override is deliberate and auditable rather than impossible.
 */
export const ExcludedCandidatesPanel: React.FC<{
  excluded: ExcludedCandidate[];
  onAssignAnyway?: (candidate: ExcludedCandidate, reason: string) => void | Promise<void>;
  assigningId?: string | null;
}> = ({ excluded, onAssignAnyway, assigningId }) => {
  const [open, setOpen] = useState(false);
  // Which row currently has its reason box open, and the reason typed so far.
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  if (excluded.length === 0) return null;

  const startOverride = (id: string) => { setOverrideFor(id); setReason(''); };
  const confirmOverride = async (candidate: ExcludedCandidate) => {
    const trimmed = reason.trim();
    if (!trimmed || !onAssignAnyway) return;
    await onAssignAnyway(candidate, trimmed);
    setOverrideFor(null);
    setReason('');
  };

  return (
    <div style={{ marginTop: '10px', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface-2)' }}>
      <button onClick={() => setOpen(!open)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer' }}>
        <span>{excluded.length} assayer{excluded.length > 1 ? 's' : ''} not shown — why?</span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ padding: '0 10px 10px' }}>
          {excluded.map(e => {
            const isOverriding = overrideFor === e.assayerId;
            const busy = assigningId === e.assayerId;
            return (
              <div key={e.assayerId} style={{ padding: '6px 0', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '12px', color: 'var(--text-primary)', fontWeight: 600 }}>{e.displayName}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{e.reason}</div>
                    {e.detail && <div style={{ fontSize: '10.5px', color: 'var(--warning)', marginTop: '2px' }}>└─ {e.detail}</div>}
                  </div>
                  {onAssignAnyway && !isOverriding && (
                    <button
                      onClick={() => startOverride(e.assayerId)}
                      className="btn btn-secondary"
                      style={{ padding: '3px 8px', fontSize: '10px', whiteSpace: 'nowrap', flexShrink: 0 }}
                    >
                      Assign anyway
                    </button>
                  )}
                </div>
                {isOverriding && (
                  <div style={{ display: 'flex', gap: '6px', marginTop: '6px', alignItems: 'center' }}>
                    <input
                      autoFocus
                      value={reason}
                      onChange={(ev) => setReason(ev.target.value)}
                      onKeyDown={(ev) => { if (ev.key === 'Enter') confirmOverride(e); if (ev.key === 'Escape') setOverrideFor(null); }}
                      placeholder="Reason for overriding this filter (recorded)"
                      style={{ flex: 1, fontSize: '11px', padding: '4px 7px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none' }}
                    />
                    <button
                      onClick={() => confirmOverride(e)}
                      disabled={!reason.trim() || busy}
                      className="btn btn-primary"
                      style={{ padding: '4px 9px', fontSize: '10px', opacity: !reason.trim() || busy ? 0.6 : 1 }}
                    >
                      {busy ? 'Assigning…' : 'Confirm'}
                    </button>
                    <button onClick={() => setOverrideFor(null)} className="btn btn-secondary" style={{ padding: '4px 9px', fontSize: '10px' }}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
