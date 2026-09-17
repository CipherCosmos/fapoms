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
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)' }}>
              Account for approved payments
            </span>
            <span style={{ display: 'block', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
              Saved at the moment the payment was approved
            </span>
          </div>
        </div>
        <span
          style={{
            fontSize: 'var(--text-2xs)',
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: '999px',
            background: 'var(--bg-surface-2)',
            color: 'var(--text-muted)',
            border: '1px solid var(--border-color)',
          }}
        >
          Locked
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 'var(--text-xs)' }}>
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
              fontSize: 'var(--text-xs)',
            }}
          >
            <div>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-2xs)', display: 'block' }}>Bank</span>
              <strong style={{ color: 'var(--text-primary)' }}>
                {activePayable.destinationBankName || '—'}
              </strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-2xs)', display: 'block' }}>Account number</span>
              <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                {activePayable.destinationBankAccountNumber
                  ? `••••${activePayable.destinationBankAccountNumber.slice(-4)}`
                  : '—'}
              </strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-2xs)', display: 'block' }}>IFSC</span>
              <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                {activePayable.destinationIfsc || '—'}
              </strong>
            </div>
            <div>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-2xs)', display: 'block' }}>Account holder</span>
              <strong style={{ color: 'var(--text-primary)' }}>
                {activePayable.destinationAccountHolderName || '—'}
              </strong>
            </div>
          </div>

          {activePayable.approvedAt && (
            <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', borderTop: '1px dashed var(--border-hair)', paddingTop: '6px' }}>
              Locked when approved on {fmtDate(activePayable.approvedAt)}
              {activePayable.payoutEvidenceVersionId && ', from the checked copy of their passbook'}
            </div>
          )}
        </div>
      ) : (
        <div style={{ padding: '14px', background: 'var(--bg-surface-2)', borderRadius: '8px', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
          No approved payments yet. When a payment is approved, the bank account it will be paid into is saved here and locked.
        </div>
      )}

      {/* Safety Notice: Mutating Live Profile does NOT change Frozen Payables */}
      <div
        style={{
          fontSize: 'var(--text-2xs)',
          color: 'var(--text-muted)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '6px',
          lineHeight: 1.4,
        }}
      >
        <Info size={14} style={{ flexShrink: 0, marginTop: '2px', color: 'var(--text-secondary)' }} />
        <span>
          If they change their bank details later, payments that are already approved still go to the account shown here.
        </span>
      </div>
    </div>
  );
};
