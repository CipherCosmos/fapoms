import React, { useState } from 'react';

export interface ExcludedCandidate {
  assayerId: string;
  displayName: string;
  reason: string;
  detail?: string;
}

/**
 * Candidates the engine filtered out, and why.
 */
export const ExcludedCandidatesPanel: React.FC<{ excluded: ExcludedCandidate[] }> = ({ excluded }) => {
  const [open, setOpen] = useState(false);
  if (excluded.length === 0) return null;
  return (
    <div style={{ marginTop: '10px', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface-2)' }}>
      <button onClick={() => setOpen(!open)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer' }}>
        <span>{excluded.length} assayer{excluded.length > 1 ? 's' : ''} not shown — why?</span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ padding: '0 10px 10px' }}>
          {excluded.map(e => (
            <div key={e.assayerId} style={{ padding: '6px 0', borderTop: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-primary)', fontWeight: 600 }}>{e.displayName}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{e.reason}</div>
              {e.detail && <div style={{ fontSize: '10.5px', color: 'var(--warning)', marginTop: '2px' }}>└─ {e.detail}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
