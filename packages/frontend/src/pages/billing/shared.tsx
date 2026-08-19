import React from 'react';
import { PauseCircle } from 'lucide-react';
import {
  BillingState, InvoiceStatus, AssayerPayableStatus,
  billingStateLabel, payableStatusLabel, invoiceStatusLabel,
} from '@fapoms/shared';

/**
 * The few presentational pieces every billing tab shares: the three status pills (one per state
 * machine, words from the shared labels so the phone says the same thing), the hold marker, a
 * card, a section label and a date. Nothing here touches money.
 */

const STATE_TONE: Record<BillingState, string> = {
  UNBILLED: 'var(--accent)',
  INVOICED: 'var(--warning)',
  PAID: 'var(--success)',
  CANCELLED: 'var(--text-muted)',
};
const PAYABLE_TONE: Record<AssayerPayableStatus, string> = {
  PENDING: 'var(--warning)',
  APPROVED: 'var(--accent)',
  PAID: 'var(--success)',
};
const INVOICE_TONE: Record<InvoiceStatus, string> = {
  DRAFT: 'var(--text-secondary)',
  ISSUED: 'var(--accent)',
  PAID: 'var(--success)',
  CANCELLED: 'var(--text-muted)',
};

export const Pill: React.FC<{ tone: string; children: React.ReactNode; title?: string }> = ({ tone, children, title }) => (
  <span title={title} style={{
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 'var(--radius-sm)',
    background: `color-mix(in srgb, ${tone} 13%, transparent)`, color: tone, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
  }}>{children}</span>
);

export const LineStatePill: React.FC<{ state: BillingState; onHold?: boolean; holdReason?: string | null }> = ({ state, onHold, holdReason }) => (
  <span style={{ display: 'inline-flex', gap: 4 }}>
    <Pill tone={STATE_TONE[state] ?? 'var(--text-muted)'}>{billingStateLabel(state)}</Pill>
    {onHold && <HoldPill reason={holdReason} />}
  </span>
);

export const PayoutStatusPill: React.FC<{ status: AssayerPayableStatus; onHold?: boolean; holdReason?: string | null }> = ({ status, onHold, holdReason }) => (
  <span style={{ display: 'inline-flex', gap: 4 }}>
    <Pill tone={PAYABLE_TONE[status] ?? 'var(--text-muted)'}>{payableStatusLabel(status)}</Pill>
    {onHold && <HoldPill reason={holdReason} />}
  </span>
);

export const InvoiceStatusPill: React.FC<{ status: InvoiceStatus; partPaid?: boolean }> = ({ status, partPaid }) => (
  <Pill tone={INVOICE_TONE[status] ?? 'var(--text-muted)'}>
    {invoiceStatusLabel(status)}{partPaid && status === 'ISSUED' ? ' · part-paid' : ''}
  </Pill>
);

export const HoldPill: React.FC<{ reason?: string | null }> = ({ reason }) => (
  <Pill tone="var(--danger)" title={reason ?? undefined}><PauseCircle size={11} /> On hold</Pill>
);

export const Card: React.FC<{ title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties }> = ({ title, actions, children, style }) => (
  <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: 16, ...style }}>
    {(title || actions) && (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        {title && <h3 style={{ fontSize: 13.5, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>{title}</h3>}
        {actions}
      </div>
    )}
    {children}
  </div>
);

export const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 700, marginBottom: 8 }}>{children}</div>
);

export const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)' }}>{children}</div>
);

export const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export const inputStyle: React.CSSProperties = {
  padding: '7px 10px', fontSize: 13, background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none',
};

export const th: React.CSSProperties = {
  textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)',
  fontWeight: 700, padding: '8px 10px', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap',
};
export const td: React.CSSProperties = {
  padding: '9px 10px', fontSize: 12.5, color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-hair, var(--border-color))',
  verticalAlign: 'middle',
};
export const tdNum: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
