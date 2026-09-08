import React from 'react';
import { Lock, Info } from 'lucide-react';
import { fmtDate } from '../../../utils/dates';
import { money } from '../assayer-shared';
import type { FrozenPayableItem } from './record-types';

export interface FrozenPayoutDestinationCardProps {
  frozenPayable?: FrozenPayableItem | null;
  payables?: any[];
  hasActivePayables?: boolean;
}

export const FrozenPayoutDestinationCard: React.FC<FrozenPayoutDestinationCardProps> = ({
  frozenPayable: propFrozenPayable,
  payables,
  hasActivePayables = false,
}) => {
  void hasActivePayables;
  const activePayable = propFrozenPayable ?? (payables && payables.length > 0 ? payables[0] : null);

  return (
    <div
      data-testid="frozen-payout-card"
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
          <Lock size={16} style={{ color: 'var(--text-secondary)' }} />
          <div>
            <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
              FROZEN DISBURSEMENT DESTINATION
            </span>
            <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)' }}>
              Frozen snapshot captured at payable approval
            </span>
          </div>
        </div>
        <span
          style={{
            fontSize: '11px',
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: '999px',
            background: 'var(--bg-surface-2)',
            color: 'var(--text-muted)',
            border: '1px solid var(--border-color)',
          }}
        >
          IMMUTABLE
        </span>
      </div>

      {activePayable ? (
        <div
          data-testid="frozen-payable-details"
          style={{
            background: 'var(--bg-surface-2)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            padding: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' }}>
            <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
              {activePayable.payableNumber}
            </span>
            <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
              {money(activePayable.totalAmount ?? activePayable.amount ?? 0)}
            </span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: '8px',
              fontSize: '12px',
            }}
          >
            <div>
              <span style={{ color: 'var(--text-muted)', fontSize: '11px', display: 'block' }}>Destination Bank</span>
              <strong style={{ color: 'var(--text-primary)' }}>
                {activePayable.destinationBankName || '—'}
              </strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)', fontSize: '11px', display: 'block' }}>Account Number</span>
              <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                {activePayable.destinationBankAccountNumber
                  ? `••••${activePayable.destinationBankAccountNumber.slice(-4)}`
                  : '—'}
              </strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)', fontSize: '11px', display: 'block' }}>Destination IFSC</span>
              <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                {activePayable.destinationIfsc || '—'}
              </strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)', fontSize: '11px', display: 'block' }}>Beneficiary</span>
              <strong style={{ color: 'var(--text-primary)' }}>
                {activePayable.destinationAccountHolderName || '—'}
              </strong>
            </div>
          </div>

          {activePayable.approvedAt && (
            <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', borderTop: '1px dashed var(--border-hair)', paddingTop: '6px' }}>
              Frozen upon approval on {fmtDate(activePayable.approvedAt)}
              {activePayable.payoutEvidenceVersionId && ' (bound to verified KYC passbook)'}
            </div>
          )}
        </div>
      ) : (
        <div style={{ padding: '14px', background: 'var(--bg-surface-2)', borderRadius: '8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
          No approved payables currently on file. When an assayer payable is approved for disbursement, its destination bank account will be frozen here and become immutable.
        </div>
      )}

      {/* Safety Notice: Mutating Live Profile does NOT change Frozen Payables */}
      <div
        style={{
          fontSize: '11.5px',
          color: 'var(--text-muted)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '6px',
          lineHeight: 1.4,
        }}
      >
        <Info size={14} style={{ flexShrink: 0, marginTop: '2px', color: 'var(--text-secondary)' }} />
        <span>
          <strong>Operational boundary:</strong> Modifying the Current Bank Profile above will <em>never</em> redirect or mutate an already-approved payable destination snapshot.
        </span>
      </div>
    </div>
  );
};
