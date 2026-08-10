import React, { useState } from 'react';

export interface ExcludedCandidate {
  assayerId: string;
  displayName: string;
  reason: string;
  detail?: string;
  /** Why-category from the engine. DATE = fine on another day; the rest are structural. */
  kind?: 'DATE' | 'ROTATION' | 'DISTANCE' | 'POLICY' | 'SKILLS';
  distanceKm?: number | null;
  /** First day after a blocking leave, when the engine could compute it. */
  nextAvailableDate?: string | null;
}

const KIND_BADGE: Record<NonNullable<ExcludedCandidate['kind']>, { label: string; color: string; bg: string }> = {
  DATE: { label: 'AVAILABLE ANOTHER DAY', color: 'var(--success)', bg: 'var(--status-active-bg)' },
  ROTATION: { label: 'ROTATION RULE', color: 'var(--warning)', bg: 'var(--status-pending-bg)' },
  DISTANCE: { label: 'DISTANCE POLICY', color: 'var(--warning)', bg: 'var(--status-pending-bg)' },
  POLICY: { label: 'CLIENT POLICY', color: 'var(--danger)', bg: 'var(--status-cancelled-bg)' },
  SKILLS: { label: 'SKILLS / CERTS', color: 'var(--danger)', bg: 'var(--status-cancelled-bg)' },
};

const tomorrowKey = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

/**
 * Candidates the engine filtered out — and what can still be done with them.
 *
 * Exclusions are not equally final. A DATE exclusion (booked that day, on leave) is a good
 * candidate for another day, so those rows lead with a green "available another day" badge and
 * assign WITH a date picker (seeded from the day after their leave when known). Structural
 * exclusions (policy, skills) stay visible with their reason, overridable with a recorded
 * justification. Nothing eligible-adjacent is ever silently invisible.
 */
export const ExcludedCandidatesPanel: React.FC<{
  excluded: ExcludedCandidate[];
  onAssignAnyway?: (candidate: ExcludedCandidate, reason: string, scheduledDate?: string) => void | Promise<void>;
  assigningId?: string | null;
  /** Start expanded — used when the eligible list is empty and this panel IS the explanation. */
  defaultOpen?: boolean;
}> = ({ excluded, onAssignAnyway, assigningId, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');

  if (excluded.length === 0) return null;

  const dateBound = excluded.filter((e) => e.kind === 'DATE').length;

  const startOverride = (e: ExcludedCandidate) => {
    setOverrideFor(e.assayerId);
    // DATE-kind: the assignment is FOR a date — seed with the first day they're free.
    setDate(e.kind === 'DATE' ? (e.nextAvailableDate ?? tomorrowKey()) : '');
    setReason(e.kind === 'DATE' ? 'Assigned for a date the assayer is available' : '');
  };

  const confirmOverride = async (candidate: ExcludedCandidate) => {
    const trimmed = reason.trim();
    if (!trimmed || !onAssignAnyway) return;
    await onAssignAnyway(candidate, trimmed, date || undefined);
    setOverrideFor(null);
    setReason('');
    setDate('');
  };

  return (
    <div style={{ marginTop: '10px', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface-2)' }}>
      <button onClick={() => setOpen(!open)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer' }}>
        <span>
          {excluded.length} assayer{excluded.length > 1 ? 's' : ''} not eligible for this date
          {dateBound > 0 && (
            <span style={{ color: 'var(--success)', fontWeight: 700 }}> — {dateBound} available another day</span>
          )}
        </span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ padding: '0 10px 10px' }}>
          {excluded.map(e => {
            const isOverriding = overrideFor === e.assayerId;
            const busy = assigningId === e.assayerId;
            const badge = e.kind ? KIND_BADGE[e.kind] : null;
            const isDate = e.kind === 'DATE';
            return (
              <div key={e.assayerId} style={{ padding: '7px 0', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '12px', color: 'var(--text-primary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      {e.displayName}
                      {badge && (
                        <span style={{ fontSize: '9px', fontWeight: 800, padding: '1px 7px', borderRadius: '8px', background: badge.bg, color: badge.color, letterSpacing: '0.03em' }}>
                          {badge.label}
                        </span>
                      )}
                      {e.distanceKm != null && (
                        <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 500 }}>{Math.round(e.distanceKm)} km</span>
                      )}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      {e.reason}
                      {isDate && e.nextAvailableDate && (
                        <span style={{ color: 'var(--success)', fontWeight: 600 }}> · free from {e.nextAvailableDate}</span>
                      )}
                    </div>
                    {e.detail && <div style={{ fontSize: '10.5px', color: 'var(--warning)', marginTop: '2px' }}>└─ {e.detail}</div>}
                  </div>
                  {onAssignAnyway && !isOverriding && (
                    <button
                      onClick={() => startOverride(e)}
                      className="btn btn-secondary"
                      style={{ padding: '3px 8px', fontSize: '10px', whiteSpace: 'nowrap', flexShrink: 0, width: 'auto', ...(isDate ? { color: 'var(--success)', borderColor: 'var(--status-active-bg)' } : {}) }}
                    >
                      {isDate ? 'Assign another day' : 'Assign anyway'}
                    </button>
                  )}
                </div>
                {isOverriding && (
                  <div style={{ display: 'flex', gap: '6px', marginTop: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                    {isDate && (
                      <input
                        type="date"
                        value={date}
                        min={tomorrowKey()}
                        onChange={(ev) => setDate(ev.target.value)}
                        aria-label="Date to assign the audit for"
                        style={{ fontSize: '11px', padding: '4px 7px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none' }}
                      />
                    )}
                    <input
                      autoFocus={!isDate}
                      value={reason}
                      onChange={(ev) => setReason(ev.target.value)}
                      onKeyDown={(ev) => { if (ev.key === 'Enter') confirmOverride(e); if (ev.key === 'Escape') setOverrideFor(null); }}
                      placeholder={isDate ? 'Note (recorded)' : 'Reason for overriding this filter (recorded)'}
                      style={{ flex: 1, minWidth: '160px', fontSize: '11px', padding: '4px 7px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none' }}
                    />
                    <button
                      onClick={() => confirmOverride(e)}
                      disabled={!reason.trim() || busy || (isDate && !date)}
                      className="btn btn-primary"
                      style={{ padding: '4px 9px', fontSize: '10px', width: 'auto', opacity: !reason.trim() || busy || (isDate && !date) ? 0.6 : 1 }}
                    >
                      {busy ? 'Assigning…' : isDate ? `Offer for ${date || '…'}` : 'Confirm'}
                    </button>
                    <button onClick={() => setOverrideFor(null)} className="btn btn-secondary" style={{ padding: '4px 9px', fontSize: '10px', width: 'auto' }}>
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
