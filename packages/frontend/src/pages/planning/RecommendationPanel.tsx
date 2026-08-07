import React from 'react';
import { RefreshCw } from 'lucide-react';
import { NegotiationBanner } from './NegotiationBanner';
import { ProjectBranch } from './BranchListPanel';

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
  onRefresh: () => void;
  onAccept: (assignmentId: string, proposedFee: number) => void;
  onCounter: (assignment: NonNullable<ProjectBranch['assignment']>) => void;
  onDecline: (assignmentId: string) => void;
  onViewHistory: (projectBranchId: string) => void;
}> = ({
  selectedPb, renderCandidatesList, width = 380, flex = false, horizontal = false,
  showAllCandidates, onToggleShowAll, slaEnabled, onToggleSla, slaRadius, onSlaRadiusChange,
  onRefresh, onAccept, onCounter, onDecline, onViewHistory,
}) => {
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
                    <div style={{ fontSize: '13px', color: 'var(--success)', fontWeight: 700 }}>₹{selectedPb.assignment.agreedFee ?? selectedPb.assignment.proposedFee ?? '—'}</div>
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

              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox" checked={showAllCandidates} onChange={(e) => onToggleShowAll(e.target.checked)} />
                  Show Distant (&gt;700km)
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: slaEnabled ? 'var(--warning)' : 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox" checked={slaEnabled} onChange={(e) => onToggleSla(e.target.checked)} />
                  Min Radius Filter
                </label>
                {slaEnabled && (
                  <select value={slaRadius} onChange={e => onSlaRadiusChange(Number(e.target.value))}
                    style={{ fontSize: '10px', padding: '2px 5px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--warning)', outline: 'none', cursor: 'pointer' }}>
                    {[25, 50, 100, 150, 200, 300, 500].map(v => <option key={v} value={v}>{v}km</option>)}
                  </select>
                )}
              </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
              {renderCandidatesList(horizontal)}
            </div>
          </>
        )
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
          👈 Select a branch from the left queue or click a map marker to inspect candidate matches.
        </div>
      )}
    </div>
  );
};
