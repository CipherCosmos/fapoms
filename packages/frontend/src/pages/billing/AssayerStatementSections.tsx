import React from 'react';
import { formatRupees as money } from '@fapoms/shared';
import { useAssayerInvoices } from '../../hooks/useBilling';
import { LoadFailure } from '../../components/LoadFailure';
import { loadFailed } from '../../queryClient';
import type { AssayerStatement } from '../../services/billing';
import { BILLING_PAGE_SIZE } from '../../services/billing';
import { fmtDate } from '../../utils/dates';
import { AssayerInvoiceStatusPill, PayoutStatusPill } from './shared';
import { PAY_WORDS } from './vocabulary';

/**
 * One assayer's statement, as parts.
 *
 * Two screens show it: the finance desk's statement page (`AssayerStatementPage`) and the
 * "Work & pay" tab on the assayer's own record. They draw the same figures from the same
 * endpoint, so they draw them with the same components — a second copy is how the two would
 * come to disagree about what "still owed" includes. The page composes all of it as
 * `StatementBody`; the record takes the totals, the payments and the bills, and itemises the
 * payouts against each assignment itself.
 */

export const StatementBody: React.FC<{ data: AssayerStatement }> = ({ data }) => (
  <>
    <div style={card}>
      <div style={{ fontSize: 'var(--text-md)', fontWeight: 700 }}>{data.assayerName ?? data.assayerId}</div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {data.assayerCode && <span>{data.assayerCode}</span>}
        {/* Whether a PAN is on file, for the finance manager reconciling withholding against the
            payouts below. Never the whole number: the server sends the last four (nothing to an
            auditor); the full PAN is revealed on the assayer's record, where the reveal is audited. */}
        <span>PAN: <strong style={{ color: data.pan || data.panOnFile ? 'var(--text-secondary)' : 'var(--danger)' }}>
          {data.pan ? `${data.pan} (last 4 only)` : data.panOnFile ? 'on file' : 'not on file'}
        </strong></span>
      </div>
    </div>

    <StatementTotals data={data} />
    <StatementPayouts data={data} />
    <AssayerInvoicesSection assayerId={data.assayerId} />
    <StatementPayments data={data} />

    {data.payables.length === 0 && data.payments.length === 0 && (
      <div style={{ ...card, color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>No payouts or payments recorded for this assayer yet.</div>
    )}
  </>
);

export const StatementTotals: React.FC<{ data: AssayerStatement }> = ({ data }) => {
  const t = data.totals;
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <Stat label={PAY_WORDS.earned} value={money(t.earned)} tone="var(--accent)" />
      <Stat label={PAY_WORDS.paid} value={money(t.paid)} tone="var(--success)" />
      <Stat label={PAY_WORDS.owed} value={money(t.outstanding)} tone={t.outstanding > 0 ? 'var(--warning)' : 'var(--text-muted)'} />
      <Stat label="Awaiting approval" value={money(t.awaitingApproval)} tone="var(--text-secondary)" />
      <Stat label="On hold" value={money(t.onHoldOrDisputed)} tone={t.onHoldOrDisputed > 0 ? 'var(--danger)' : 'var(--text-muted)'} />
      <Stat label={`TDS withheld (u/s ${data.tdsSection})`} value={money(t.tdsWithheld)} tone={t.tdsWithheld > 0 ? 'var(--warning)' : 'var(--text-muted)'} />
    </div>
  );
};

export const StatementPayouts: React.FC<{ data: AssayerStatement }> = ({ data }) => {
  if (data.payables.length === 0) return null;
  return (
    <div style={card}>
      <div style={{ ...label, marginBottom: 10 }}>Payouts ({data.payables.length})</div>
      <SimpleTable
        head={['Payout', 'Status', 'Invoice', 'Base', 'Travel', 'TDS', 'Total', PAY_WORDS.paid, PAY_WORDS.owed]}
        rows={data.payables.map((p) => [
          p.expenseId ? `${p.payableNumber} · reimbursement` : p.payableNumber,
          // An office-approved payout is not payable until the HOD approves it; say so, as the pay
          // screen does, instead of a bare "Approved".
          <PayoutStatusPill status={p.status} onHold={p.onHold} holdReason={p.holdReason} hodApproved={p.hodApproved} />,
          // Which assayer invoice this row rides — labels the statement attaches itself
          // (the staff shape), so no lookup is needed here. Blank means never invited.
          p.invoiceNumber ? (
            <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
              {p.invoiceNumber}{p.invoiceStatus && <AssayerInvoiceStatusPill status={p.invoiceStatus} />}
            </span>
          ) : '—',
          money(p.baseAmount), money(p.travelAmount),
          `−${money(p.tdsAmount)}`, money(p.totalAmount), money(p.paidAmount), money(p.outstanding),
        ])}
      />
    </div>
  );
};

export const StatementPayments: React.FC<{ data: AssayerStatement }> = ({ data }) => {
  if (data.payments.length === 0) return null;
  return (
    <div style={card}>
      <div style={{ ...label, marginBottom: 10 }}>Payments made ({data.payments.length})</div>
      <SimpleTable
        head={['Reference', 'Method', 'Amount', 'Paid on', 'Balance after', 'Note']}
        rows={data.payments.map((p) => [
          p.paymentReference, p.method, money(p.amount),
          fmtDate(p.paidDate),
          p.balanceAfter != null ? money(p.balanceAfter) : '—', p.notes ?? '',
        ])}
      />
    </div>
  );
};

/**
 * The assayer's invoices — the consent loop this statement's rows ride through. Shown from the
 * finance side so "why is this payout not approved yet?" answers itself: it is waiting on an
 * invitation the assayer has not confirmed, or a submission nobody has approved. Renders
 * nothing when the assayer has never been invited (most of the roster, pre-rollout).
 */
export const AssayerInvoicesSection: React.FC<{ assayerId: string; title?: string }> = ({ assayerId, title = 'Assayer invoices' }) => {
  const invoices = useAssayerInvoices({ assayerId, limit: BILLING_PAGE_SIZE });
  const items = invoices.data?.items ?? [];
  /**
   * This section hides itself when the assayer has never been invited to invoice, which is the
   * right thing for most of the roster — and the wrong thing for a refused load, which arrived at
   * `items.length === 0` by the same route and disappeared the section entirely. "Why is this
   * payout not approved yet?" then has no answer on screen at all, not even a wrong one.
   */
  if (loadFailed(invoices)) {
    return (
      <div style={card}>
        <div style={{ ...label, marginBottom: 10 }}>{title}</div>
        <LoadFailure loads={[{ label: "this assayer's invoices", query: invoices }]} />
      </div>
    );
  }
  if (items.length === 0) return null;
  const dates = (inv: (typeof items)[number]) =>
    [
      inv.invitedAt && `invited ${fmtDate(inv.invitedAt)}`,
      inv.submittedAt && `submitted ${fmtDate(inv.submittedAt)}`,
      inv.approvedAt && `approved ${fmtDate(inv.approvedAt)}`,
      inv.cancelledAt && `cancelled ${fmtDate(inv.cancelledAt)}`,
    ].filter(Boolean).join(' · ');
  return (
    <div style={card}>
      <div style={{ ...label, marginBottom: 10 }}>{title} ({items.length})</div>
      <SimpleTable
        head={['Invoice', 'Status', 'Lines', 'Total', 'Dates']}
        rows={items.map((inv) => [
          inv.invoiceNumber,
          <AssayerInvoiceStatusPill key={inv.id} status={inv.status} />,
          inv.lineCount,
          money(inv.totalAmount),
          dates(inv) || '—',
        ])}
      />
    </div>
  );
};

export const Stat: React.FC<{ label: string; value: string; tone?: string }> = ({ label: text, value, tone }) => (
  <div style={{ ...card, flex: '1 1 150px', minWidth: 0 }}>
    <div style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: tone ?? 'var(--text-primary)', lineHeight: 1.1 }}>{value}</div>
    <div style={{ ...label, marginTop: 6 }}>{text}</div>
  </div>
);

/**
 * A plain table: the first `leftColumns` columns read left-aligned (words), the rest right-aligned
 * (figures).
 */
export const SimpleTable: React.FC<{ head: string[]; rows: React.ReactNode[][]; leftColumns?: number }> = ({ head, rows, leftColumns = 1 }) => (
  <div style={{ overflowX: 'auto' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-xs)' }}>
      <thead>
        <tr>{head.map((h, i) => <th key={h} style={{ ...label, textAlign: i < leftColumns ? 'left' : 'right', padding: '8px 10px', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' }}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ borderBottom: '1px solid var(--border-hair)' }}>
            {r.map((c, j) => <td key={j} style={{ padding: '8px 10px', textAlign: j < leftColumns ? 'left' : 'right', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md, 10px)', padding: 16,
};
export const label: React.CSSProperties = {
  fontSize: 'var(--text-2xs)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 700,
};
