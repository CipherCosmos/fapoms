import React from 'react';
import { PauseCircle } from 'lucide-react';
import {
  BillingState, InvoiceStatus, AssayerPayableStatus, AssayerInvoiceStatus,
  billingStateLabel, payableStatusLabel, invoiceStatusLabel,
} from '@fapoms/shared';
import { BILL_STATE_CHIP } from './vocabulary';

/**
 * The few presentational pieces every billing tab shares: the status pills (one per state
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
  VOIDED: 'var(--text-muted)',
};
const INVOICE_TONE: Record<InvoiceStatus, string> = {
  DRAFT: 'var(--text-secondary)',
  ISSUED: 'var(--accent)',
  PAID: 'var(--success)',
  CANCELLED: 'var(--text-muted)',
};
// INVITED is waiting on the assayer (their queue, warning-toned like a pending payout);
// SUBMITTED is waiting on ops — the action lane, accent-toned so it reads as "yours to do".
const ASSAYER_INVOICE_TONE: Record<AssayerInvoiceStatus, string> = {
  INVITED: 'var(--text-secondary)',
  SUBMITTED: 'var(--warning)',
  APPROVED: 'var(--accent)',
  PAID: 'var(--success)',
  CANCELLED: 'var(--text-muted)',
  SUPERSEDED: 'var(--text-muted)',
};

/**
 * Words for the assayer-bill states, from `vocabulary.ts` rather than from a second list here.
 *
 * There were two: this one said "Waiting for Assayer" / "Needs Approval" in title case, and the
 * filter chips beside it in the same toolbar said "Invited" / "Submitted" — the enum's own
 * spelling — for exactly the same rows. Two vocabularies for one state machine, six inches
 * apart. One list now, and it is not in this file, because this file is presentation and the
 * words are the product's.
 */
export const assayerInvoiceStatusLabel = (s: AssayerInvoiceStatus): string => BILL_STATE_CHIP[s] ?? s;

export const Pill: React.FC<{ tone: string; children: React.ReactNode; title?: string }> = ({ tone, children, title }) => (
  <span title={title} style={{
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 'var(--radius-sm)',
    background: `color-mix(in srgb, ${tone} 13%, transparent)`, color: tone, fontSize: 'var(--text-2xs)', fontWeight: 600, whiteSpace: 'nowrap',
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

export const AssayerInvoiceStatusPill: React.FC<{ status: AssayerInvoiceStatus; title?: string }> = ({ status, title }) => {
  const tone = ASSAYER_INVOICE_TONE[status] ?? 'var(--text-muted)';
  return (
    <Pill tone={tone} title={title}>
      {status === AssayerInvoiceStatus.SUBMITTED && (
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-primary)', display: 'inline-block' }} />
      )}
      {status === AssayerInvoiceStatus.PAID && (
        <span style={{ color: 'var(--success)', fontWeight: 700 }}>✓</span>
      )}
      {assayerInvoiceStatusLabel(status)}
    </Pill>
  );
};

export const MetricCard: React.FC<{
  label: string;
  value: string;
  sub?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: string;
  highlight?: boolean;
  onClick?: () => void;
}> = ({ label, value, sub, icon, tone, highlight, onClick }) => (
  <div
    onClick={onClick}
    style={{
      background: highlight ? 'var(--status-pending-bg)' : 'var(--bg-secondary)',
      border: `1px solid ${highlight ? 'var(--accent-primary)' : 'var(--border-color)'}`,
      borderRadius: 'var(--radius-md)',
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      cursor: onClick ? 'pointer' : 'default',
      transition: 'all 0.15s ease',
    }}
  >
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: tone ?? 'var(--text-muted)' }}>
      <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      {icon && <span style={{ opacity: 0.85 }}>{icon}</span>}
    </div>
    <div style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-display, inherit)' }}>
      {value}
    </div>
    {sub && <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)' }}>{sub}</div>}
  </div>
);

export const HoldPill: React.FC<{ reason?: string | null }> = ({ reason }) => (
  <Pill tone="var(--danger)" title={reason ?? undefined}><PauseCircle size={11} /> On hold</Pill>
);

export const Card: React.FC<{ title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties }> = ({ title, actions, children, style }) => (
  <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: 16, ...style }}>
    {(title || actions) && (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        {title && <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>{title}</h3>}
        {actions}
      </div>
    )}
    {children}
  </div>
);

export const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 'var(--text-2xs)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 700, marginBottom: 8 }}>{children}</div>
);

export const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)' }}>{children}</div>
);

export const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export const inputStyle: React.CSSProperties = {
  padding: '7px 10px', fontSize: 'var(--text-sm)', background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none',
};

export const th: React.CSSProperties = {
  textAlign: 'left', fontSize: 'var(--text-2xs)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)',
  fontWeight: 700, padding: '8px 10px', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg-secondary)',
};
export const td: React.CSSProperties = {
  padding: '9px 10px', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-hair, var(--border-color))',
  verticalAlign: 'middle',
};
export const tdNum: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

export const tableScrollStyle: React.CSSProperties = {
  overflowX: 'auto',
  maxHeight: 'calc(100vh - 290px)',
  overflowY: 'auto',
};
