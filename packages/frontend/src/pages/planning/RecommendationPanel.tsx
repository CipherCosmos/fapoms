import React from 'react';
import { RefreshCw } from 'lucide-react';
import { NegotiationBanner } from './NegotiationBanner';
import { ProjectBranch } from './BranchListPanel';

import { assignmentFee } from '../../utils/money';
/**
 * Shared definition of the recommended assayers panel.
 */
export const RecommendationPanel: React.FC<{
  selectedPb: ProjectBranch | null | undefined;
  renderCandidatesList: (horizontal: boolean) => React.ReactNode;
  width?: number;
  flex?: boolean;
  horizontal?: boolean;
  showAllCandidates: boolean;
  onToggleShowAll: (v: boolean) => void;
  slaEnabled: boolean;
  onToggleSla: (v: boolean) => void;
  slaRadius: number;
  onSlaRadiusChange: (v: number) => void;
  maxRadiusEnabled: boolean;
  onToggleMaxRadius: (v: boolean) => void;
  maxRadius: number;
  onMaxRadiusChange: (v: number) => void;
  /**
   * The audit date candidates are evaluated FOR (YYYY-MM-DD). Availability, double-booking
   * and fee quotes all describe this date — changing it re-fetches the ranking. Without it
   * the engine assumed "today", which is rarely the day being planned.
   */
  planDate?: string;
  onPlanDateChange?: (v: string) => void;
  /**
   * Rank the whole nearby workforce, treating a booking or a leave on `planDate` as advisory
   * instead of disqualifying. Unlike every other control in this row it changes what the
   * ENGINE returns, not what this panel shows, so it re-fetches. Candidates kept this way are
   * labelled with their clash on the row.
   */
  ignoreDateAvailability?: boolean;
  onToggleIgnoreDateAvailability?: (v: boolean) => void;
  /**
   * Advanced view. Simple shows the handful of controls the everyday task needs and states the
   * independence rule in words; Advanced adds the raw numeric overrides back. No control is
   * removed by Simple — each one is still reachable one click away.
   */
  advanced?: boolean;
  /**
   * Starts the everyday task from the empty state: opens the most urgent branch nobody is on.
   * The empty panel used to offer only a sentence of instruction, which is a hint, not an action.
   */
  onNextUnassigned?: () => void;
  /** Name of the branch that button would open, so the empty state can say where it leads. */
  nextBranchName?: string | null;
  onRefresh: () => void;
  onAccept: (assignmentId: string, proposedFee: number) => void;
  onCounter: (assignment: NonNullable<ProjectBranch['assignment']>) => void;
  onDecline: (assignmentId: string) => void;
  onViewHistory: (projectBranchId: string) => void;
}> = ({
  selectedPb, renderCandidatesList, width = 380, flex = false, horizontal = false,
  showAllCandidates, onToggleShowAll, slaEnabled, onToggleSla, slaRadius, onSlaRadiusChange,
  maxRadiusEnabled, onToggleMaxRadius, maxRadius, onMaxRadiusChange,
  planDate, onPlanDateChange,
  ignoreDateAvailability = false, onToggleIgnoreDateAvailability,
  advanced = false, onNextUnassigned, nextBranchName,
  onRefresh, onAccept, onCounter, onDecline, onViewHistory,
}) => {
  /**
   * The single "Nearby only" answer, derived from the two pieces of state that used to be two
   * controls. `showAllCandidates` (no limit) and a disabled max radius mean the same thing to the
   * coordinator — "any distance" — so both map to the same option rather than to two.
   */
  const nearbyValue = showAllCandidates || !maxRadiusEnabled ? 'ANY' : String(maxRadius);
  /** 50 / 100 / Any, plus whatever custom figure is already in force, so nothing is lost. */
  const nearbyOptions = React.useMemo(() => {
    const presets = [50, 100];
    const opts = presets.map(v => ({ value: String(v), label: `${v} km` }));
    if (nearbyValue !== 'ANY' && !presets.includes(maxRadius)) {
      opts.push({ value: String(maxRadius), label: `${maxRadius} km` });
      opts.sort((a, b) => Number(a.value) - Number(b.value));
    }
    return [...opts, { value: 'ANY', label: 'Any distance' }];
  }, [nearbyValue, maxRadius]);
  const onNearbyChange = (v: string) => {
    if (v === 'ANY') {
      // "Any distance" is the old "Show all distances" tick — it lifts the limit outright rather
      // than leaving a stale radius that quietly contradicts the menu.
      onToggleShowAll(true);
      return;
    }
    onToggleShowAll(false);
    onToggleMaxRadius(true);
    onMaxRadiusChange(Number(v));
  };

  const isDone = selectedPb && (
    ['AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'].includes(selectedPb.status) ||
    selectedPb.assignment?.status === 'COMPLETED'
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden', ...(flex ? { flex: 1, minWidth: 0 } : { width: `${width}px`, minWidth: `${width}px` }) }}>
      {selectedPb ? (
        isDone ? (
          <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '24px' }}>{selectedPb.status === 'CLOSED' ? '✅' : '🔍'}</span>
              <div>
                <div style={{ fontSize: '15px', fontWeight: 800, color: selectedPb.status === 'CLOSED' ? 'var(--success)' : 'var(--warning)' }}>
                  {selectedPb.status === 'CLOSED' ? 'Audit Closed & Finalized' : 'Audit Completed — Under Validation'}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px' }}>
                  {selectedPb.branch.name} • {selectedPb.branch.city}, {selectedPb.branch.state}
                </div>
              </div>
            </div>
            {selectedPb.assignment && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', background: 'var(--bg-surface-2)', borderRadius: '8px', border: '1px solid var(--border-hair)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' }}>ASSAYER</div>
                    <div style={{ fontSize: '13px', color: 'var(--accent)', fontWeight: 600 }}>👤 {selectedPb.assignment.assayer?.displayName}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' }}>AGREED FEE</div>
                    <div style={{ fontSize: '13px', color: 'var(--success)', fontWeight: 700 }}>{assignmentFee(selectedPb.assignment)}</div>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' }}>BRANCH STATUS</div>
                  <span style={{ fontSize: '12px', padding: '2px 8px', borderRadius: '4px', background: selectedPb.status === 'CLOSED' ? 'var(--status-active-bg)' : 'var(--status-pending-bg)', color: selectedPb.status === 'CLOSED' ? 'var(--success)' : 'var(--warning)', fontWeight: 700 }}>
                    {selectedPb.status.replace(/_/g, ' ')}
                  </span>
                </div>
              </div>
            )}
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.5 }}>
              This branch audit is {selectedPb.status === 'CLOSED' ? 'closed and finalized' : 'completed and currently under validator review'}. No further scheduling or reassignment actions are available.
            </div>
            <button
              onClick={() => onViewHistory(selectedPb.id)}
              style={{
                marginTop: '10px', padding: '8px 12px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                background: 'var(--bg-page)', border: '1px solid var(--border-color)',
                color: 'var(--text-primary)', fontSize: '12px', fontWeight: 600,
                display: 'flex', alignItems: 'center', gap: '6px', width: '100%', justifyContent: 'center',
              }}
            >
              View full branch history
            </button>
          </div>
        ) : (
          <>
            {selectedPb.status === 'NEGOTIATION' && selectedPb.assignment && (
              <NegotiationBanner
                assignment={selectedPb.assignment}
                onAccept={() => onAccept(selectedPb.assignment!.id, selectedPb.assignment!.proposedFee)}
                onCounter={() => onCounter(selectedPb.assignment!)}
                onDecline={() => onDecline(selectedPb.assignment!.id)}
              />
            )}

            <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-surface-2)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700 }}>MATCHING INSPECTOR</span>
                  <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginTop: '1px' }}>{selectedPb.branch.name}</div>
                </div>
                <button onClick={onRefresh}
                  className="btn btn-secondary" title="Refresh candidates"
                  style={{ padding: '4px 8px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <RefreshCw size={11} /> Refresh
                </button>
              </div>

              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                {/* The date this ranking answers for. Leads the row because every other control
                    filters WITHIN the answer; this one changes the question ("who can audit on…"). */}
                {planDate != null && onPlanDateChange && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)', userSelect: 'none' }}
                    title="Audit date — availability, workload and fees are evaluated for this day">
                    <span style={{ fontWeight: 700 }}>Audit on</span>
                    <input
                      type="date"
                      value={planDate}
                      onChange={e => { if (e.target.value) onPlanDateChange(e.target.value); }}
                      aria-label="Audit date candidates are evaluated for"
                      style={{ fontSize: '10.5px', padding: '2px 6px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--accent)', fontWeight: 600, outline: 'none' }}
                    />
                  </label>
                )}
                {/* Plain words for what this actually does. "Ignore date availability" read as a
                    switch that discards a rule; it in fact widens the list to people who are
                    booked or on leave that day, and each clash is still printed on the row. */}
                {onToggleIgnoreDateAvailability && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: ignoreDateAvailability ? 'var(--accent-secondary)' : 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}
                    title="Ranks everyone nearby even if they are booked or on leave that day. Each clash is still shown on the person's card.">
                    <input type="checkbox" checked={ignoreDateAvailability} onChange={(e) => onToggleIgnoreDateAvailability(e.target.checked)} />
                    Also show people who are busy that day
                  </label>
                )}

                {/*
                  One distance control instead of two contradictory ones.

                  "Within [n] km" and "Show all distances" were separate and could be set to
                  disagree — a radius typed in one box and silently overridden by a tick in the
                  other. They are one question with one answer, so they are now one menu, and the
                  two pieces of state behind it are always set together and consistently.
                */}
                <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)', userSelect: 'none' }}
                  title="How far from the branch to look. 'Any distance' lists everyone, however far away.">
                  <span style={{ fontWeight: 700 }}>Nearby only</span>
                  <select
                    aria-label="How far from the branch to look for people"
                    value={nearbyValue}
                    onChange={e => onNearbyChange(e.target.value)}
                    style={{ fontSize: '10.5px', padding: '2px 6px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--accent)', fontWeight: 600, outline: 'none' }}
                  >
                    {nearbyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>

                {/*
                  The independence floor is a CLIENT COMPLIANCE RULE, not a taste setting: an
                  assayer may not audit a branch on their own doorstep. Asking a coordinator to
                  invent the kilometre figure ("Min radius [__] km") put a rule they do not own
                  in a box they had to fill in. Simple therefore states the rule as policy and
                  explains who it hides; Advanced keeps the full override, unchanged.
                */}
                {advanced ? (
                  <>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: slaEnabled ? 'var(--warning)' : 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}
                      title="Override the independence rule: hide people closer than this to the branch">
                      <input type="checkbox" checked={slaEnabled} onChange={(e) => onToggleSla(e.target.checked)} />
                      Minimum distance rule
                    </label>
                    {slaEnabled && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
                        <input
                          type="number" min={0} step={5} value={slaRadius} list="radius-presets"
                          aria-label="Minimum distance in kilometres a person must be from the branch"
                          onChange={e => onSlaRadiusChange(Math.max(0, Number(e.target.value) || 0))}
                          style={{ width: '56px', fontSize: '10px', padding: '2px 5px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--warning)', outline: 'none' }}
                        />
                        <span style={{ fontSize: '10px', color: 'var(--warning)' }}>km</span>
                      </span>
                    )}
                    {/* The exact service-radius figure, for the cases the three-option menu above
                        cannot express. Editing it keeps the menu in step. */}
                    <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }} title="Exact distance limit, when the menu's options do not fit">
                      <input
                        type="number" min={0} step={10} value={maxRadius} list="radius-presets"
                        aria-label="Exact distance limit in kilometres"
                        onChange={e => { const v = Math.max(0, Number(e.target.value) || 0); onMaxRadiusChange(v); onToggleMaxRadius(true); onToggleShowAll(false); }}
                        style={{ width: '60px', fontSize: '10px', padding: '2px 5px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--accent)', outline: 'none' }}
                      />
                      <span style={{ fontSize: '10px', color: 'var(--accent)' }}>km</span>
                    </span>
                  </>
                ) : (
                  <details style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                    <summary style={{ cursor: 'pointer', userSelect: 'none', color: 'var(--accent)', fontWeight: 600 }}>
                      Why is someone hidden?
                    </summary>
                    <div style={{ marginTop: '6px', padding: '8px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-hair)', borderRadius: '6px', lineHeight: 1.6, maxWidth: '340px', fontWeight: 500 }}>
                      {slaEnabled
                        ? <>Someone you expected may be missing because of the <b>independence rule</b>: a person living within <b>{slaRadius} km</b> of a branch may not audit it. That distance comes from the client's contract, not from a setting here.</>
                        : <>The independence rule — which hides people living too close to the branch to audit it independently — is currently switched off, so everyone nearby is listed.</>}
                      <div style={{ marginTop: '6px' }}>
                        People can also be missing because they are booked or on leave on the audit date (tick “Also show people who are busy that day”), because they are further away than the “Nearby only” limit, or because they lack a skill or certification the project requires — the latter is listed under the candidates.
                      </div>
                      <div style={{ marginTop: '6px', color: 'var(--text-muted)' }}>
                        Switch to <b>Advanced</b> at the top of the screen to change the minimum distance yourself.
                      </div>
                    </div>
                  </details>
                )}
                <datalist id="radius-presets">
                  {[0, 25, 50, 75, 100, 150, 200, 300, 500, 700].map(v => <option key={v} value={v} />)}
                </datalist>
              </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
              {renderCandidatesList(horizontal)}
            </div>
          </>
        )
      ) : (
        /*
          The empty state now offers the action instead of describing it. "Select a branch from
          the left queue" told a coordinator facing thirty-five controls what to do but gave them
          nothing to press; this opens the most urgent branch nobody is on and scrolls its best
          match into view. The old instruction stays underneath, because picking a specific
          branch by hand is still perfectly valid.
        */
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: '10px', padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>Ready to staff a branch</div>
          {onNextUnassigned && (
            <button
              type="button"
              onClick={onNextUnassigned}
              className="btn btn-primary"
              style={{ padding: '8px 16px', fontSize: '13px', fontWeight: 700 }}
              title={nextBranchName ? `Opens ${nextBranchName}` : undefined}
            >
              Start with the next branch
            </button>
          )}
          {nextBranchName && (
            <div style={{ fontSize: '11.5px' }}>Next up: <b style={{ color: 'var(--text-secondary)' }}>{nextBranchName}</b></div>
          )}
          <div style={{ fontSize: '11.5px', maxWidth: '300px', lineHeight: 1.5 }}>
            Or pick any branch from the queue on the left, or click a marker on the map.
          </div>
        </div>
      )}
    </div>
  );
};
