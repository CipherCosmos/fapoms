import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Building } from 'lucide-react';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import type { Assayer } from '../assayer-shared';
import { maskedIdentifier } from '../assayer-shared';

export interface BankProfileCardProps {
  assayer: Assayer;
  canManage: boolean;
  canReveal?: boolean;
  onEditBank?: () => void;
}

export const BankProfileCard: React.FC<BankProfileCardProps> = ({
  assayer,
  canManage,
  canReveal = canManage,
  onEditBank,
}) => {
  const [revealedAccount, setRevealedAccount] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDeparted =
    assayer.lifecycleStatus === 'RESIGNED' ||
    assayer.lifecycleStatus === 'TERMINATED' ||
    assayer.lifecycleStatus === 'ARCHIVED';

  const hasPan = Boolean(assayer.panNumber?.trim());

  const blockers: string[] = [];
  if (!isDeparted) {
    if (!assayer.bankAccountNumber?.trim()) blockers.push('Missing bank account number');
    if (!assayer.ifscCode?.trim()) blockers.push('Missing IFSC code');
    if (!hasPan) blockers.push('Missing PAN number (mandatory for Indian statutory TDS compliance)');
  }

  const handleReveal = async () => {
    if (revealedAccount) {
      setRevealedAccount(null);
      return;
    }
    if (!canReveal) {
      setError('You lack permission to uncover raw banking identifiers.');
      return;
    }
    setRevealing(true);
    setError(null);
    try {
      const res = await api.request<{ value?: string; [key: string]: any }>(
        `/assayers/${assayer.id}/sensitive/bankAccountNumber`,
      );
      const val = res?.value ?? (typeof res === 'string' ? res : null);
      if (val) {
        setRevealedAccount(val);
      } else {
        setError('No unmasked value returned.');
      }
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setRevealing(false);
    }
  };

  return (
    <div
      data-testid="bank-profile-card"
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
          <Building size={16} style={{ color: 'var(--accent)' }} />
          <div>
            <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
              CURRENT BANK PROFILE
            </span>
            <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)' }}>
              Live profile destination for future payables
            </span>
          </div>
        </div>
        {canManage && onEditBank && (
          <button
            type="button"
            onClick={onEditBank}
            className="btn btn-secondary"
            style={{ fontSize: '11px', padding: '4px 8px' }}
          >
            Edit Profile Bank
          </button>
        )}
      </div>

      {/* Profile Banking Fields */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: '10px',
          background: 'var(--bg-surface-2)',
          padding: '12px',
          borderRadius: '8px',
          fontSize: '12.5px',
        }}
      >
        <div>
          <span style={{ color: 'var(--text-muted)', fontSize: '11px', display: 'block' }}>Bank Name</span>
          <strong style={{ color: 'var(--text-primary)' }}>{assayer.bankName || 'Not recorded'}</strong>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)', fontSize: '11px', display: 'block' }}>Account Number</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>
              {revealedAccount || maskedIdentifier(assayer.bankAccountNumber)}
            </strong>
            {canReveal && assayer.bankAccountNumber && (
              <button
                type="button"
                onClick={handleReveal}
                disabled={revealing}
                title={revealedAccount ? 'Hide account' : 'Reveal full account (Audited)'}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text-secondary)',
                  padding: '2px',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                {revealedAccount ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            )}
          </div>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)', fontSize: '11px', display: 'block' }}>IFSC Code</span>
          <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>
            {assayer.ifscCode || 'Not recorded'}
          </strong>
        </div>
      </div>

      {error && (
        <div style={{ fontSize: '11.5px', color: 'var(--danger)', fontWeight: 600 }}>{error}</div>
      )}

      {isDeparted ? (
        <div
          data-testid="departed-payout-notice"
          style={{ fontSize: '12px', color: 'var(--text-muted)' }}
        >
          No active payout blockers: assayer is departed ({assayer.lifecycleStatus}). Profile is inactive and not queued for active payout.
        </div>
      ) : blockers.length > 0 ? (
        <div
          data-testid="payout-blockers-alert"
          style={{
            padding: '10px 12px',
            borderRadius: '6px',
            background: 'var(--status-pending-bg)',
            border: '1px solid var(--warning)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: 'var(--warning)' }}>
            <AlertTriangle size={14} />
            Payout Readiness Blocked:
          </div>
          <ul style={{ margin: '4px 0 0 16px', padding: 0, fontSize: '12px', color: 'var(--text-primary)' }}>
            {blockers.map((b, i) => (
              <li key={i} style={{ marginBottom: '2px' }}>{b}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--success)' }}>
          <CheckCircle2 size={13} />
          <span>Profile bank details and PAN are complete for new payout creation.</span>
        </div>
      )}
    </div>
  );
};
