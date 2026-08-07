import React from 'react';
import { Users, AlertTriangle, Check, RefreshCw, X } from 'lucide-react';

interface ProjectBranchAssignment {
  id: string;
  status: string;
  proposedFee: number;
  agreedFee: number | null;
  scheduledDate: string | null;
  remarks?: string | null;
  negotiatedByName?: string | null;
  negotiationCount?: number;
  assayer?: { id: string; displayName: string; assayerCode?: string };
}

const MAX_NEGOTIATION_ROUNDS = 3;

/**
 * The active counter-offer banner — an assayer has proposed a different fee and ops needs to
 * accept, counter, or decline it.
 */
export const NegotiationBanner: React.FC<{
  assignment: ProjectBranchAssignment;
  onAccept: () => void;
  onCounter: () => void;
  onDecline: () => void;
}> = ({ assignment, onAccept, onCounter, onDecline }) => {
  const round = Math.max(1, assignment.negotiationCount ?? 1);
  const roundsLeft = Math.max(0, MAX_NEGOTIATION_ROUNDS - (assignment.negotiationCount ?? 0));

  return (
    <div style={{
      padding: '12px 14px',
      background: 'linear-gradient(135deg, var(--status-pending-bg), var(--status-pending-bg))',
      borderBottom: '1px solid var(--status-pending-bg)',
      borderLeft: '3px solid var(--warning)',
      display: 'flex', flexDirection: 'column', gap: '10px',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
        <div style={{ width: '30px', height: '30px', borderRadius: '50%', background: 'var(--status-pending-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '14px' }}>
          💬
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--warning)' }}>
              Counter offer from {assignment.assayer?.displayName || 'assayer'}
            </span>
            <span style={{ fontSize: '9.5px', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: 'var(--status-pending-bg)', color: 'var(--warning)', whiteSpace: 'nowrap' }}>
              Round {round} of {MAX_NEGOTIATION_ROUNDS}
            </span>
          </div>
          <div style={{ fontSize: '19px', fontWeight: 800, color: 'var(--text-primary)', marginTop: '3px' }}>
            ₹{assignment.proposedFee?.toLocaleString()}
          </div>
          {assignment.remarks && (
            <div style={{ fontSize: '11px', color: 'var(--warning)', marginTop: '3px', fontStyle: 'italic' }}>
              "{assignment.remarks}"
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '5px' }}>
            {assignment.negotiatedByName && (
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Users size={10} /> Handled by <b style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>{assignment.negotiatedByName}</b>
              </span>
            )}
            {roundsLeft <= 1 && (
              <span style={{ fontSize: '10px', color: 'var(--danger)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '3px' }}>
                <AlertTriangle size={10} />
                {roundsLeft === 0 ? 'Next counter auto-declines this offer' : 'Last round before auto-decline'}
              </span>
            )}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: '6px' }}>
        <button type="button" onClick={onAccept} className="btn btn-primary"
          style={{ flex: 1.3, padding: '7px 10px', fontSize: '11.5px', background: 'var(--success)', borderColor: 'var(--success)', color: 'var(--text-primary)', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
          <Check size={13} /> Accept
        </button>
        <button type="button" onClick={onCounter} className="btn btn-secondary"
          style={{ flex: 1, padding: '7px 10px', fontSize: '11.5px', color: 'var(--accent)', borderColor: 'rgba(216,174,71,0.4)', background: 'rgba(216,174,71,0.1)', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
          <RefreshCw size={12} /> Counter
        </button>
        <button type="button" onClick={onDecline} className="btn btn-secondary"
          style={{ flex: 1, padding: '7px 10px', fontSize: '11.5px', color: 'var(--danger)', borderColor: 'var(--status-cancelled-bg)', background: 'var(--status-cancelled-bg)', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
          <X size={13} /> Decline
        </button>
      </div>
    </div>
  );
};
