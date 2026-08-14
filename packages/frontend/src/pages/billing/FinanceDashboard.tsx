import React from 'react';
import { ArrowDownLeft, ArrowUpRight, AlertTriangle, FileText, CheckCircle2, Clock } from 'lucide-react';
import { useFinanceDashboard } from '../../hooks/useBilling';
import type { BillingAging } from '../../services/billing';

// Aggregates: a bucket with nothing in it is ₹0, not an unknown amount.
import { moneyTotal as money } from '../../utils/money';
// Paise-accurate variant for reconciliation figures, from the same shared formatter.
import { moneyExact } from '../../utils/money';

/**
 * The finance console, organised around the questions finance actually asks —
 * "what needs doing today", "are we healthy", "where is the money" — rather than
 * as an undifferentiated wall of totals.
 *
 * The figures reconcile because there is now one billing engine behind them; they
 * previously came from three modules that disagreed.
 */
export const FinanceDashboard: React.FC<{ onNavigate?: (tab: string) => void }> = ({ onNavigate }) => {
  const { data, isLoading, error } = useFinanceDashboard();

  if (isLoading) return <Panel>Loading finance position…</Panel>;
  if (error) return <Panel tone="error">Could not load the finance dashboard.</Panel>;
  if (!data) return null;

  const { receivable, payable, cashflow, profitability, taxPosition } = data;
  const overdue = receivable.aging.d1_30 + receivable.aging.d31_60 + receivable.aging.d61_90 + receivable.aging.d90_plus;

  // Everything sitting in a queue waiting on a person. This is the part of the
  // page that should change day to day.
  const actions = [
    {
      show: receivable.unbilled > 0,
      icon: <FileText size={15} />, tone: 'var(--accent)',
      title: 'Ready to invoice',
      amount: receivable.unbilled,
      detail: 'Work delivered but not yet on an invoice — cash stuck in the pipeline.',
      cta: 'Go to entries', tab: 'entries',
    },
    {
      show: payable.awaitingApproval > 0,
      icon: <Clock size={15} />, tone: 'var(--warning)',
      title: 'Payables awaiting approval',
      amount: payable.awaitingApproval,
      detail: 'Assayers have completed this work. Approve before it can be paid.',
      cta: 'Review payables', tab: 'payables',
    },
    {
      show: payable.approvedUnpaid > 0,
      icon: <ArrowUpRight size={15} />, tone: 'var(--accent)',
      title: 'Approved, ready to pay',
      amount: payable.approvedUnpaid,
      detail: 'Cleared for disbursement to assayers.',
      cta: 'Disburse', tab: 'payables',
    },
    {
      show: overdue > 0,
      icon: <AlertTriangle size={15} />, tone: 'var(--danger)',
      title: 'Overdue from clients',
      amount: overdue,
      detail: 'Past the due date set by the client’s payment terms — chase collection.',
      cta: 'View invoices', tab: 'invoices',
    },
    {
      show: data.openConflicts > 0,
      icon: <AlertTriangle size={15} />, tone: 'var(--danger)',
      title: `${data.openConflicts} unresolved conflict${data.openConflicts === 1 ? '' : 's'}`,
      amount: null,
      detail: 'Blocking conflicts stop their entries from being invoiced at all.',
      cta: 'Resolve', tab: 'conflicts',
    },
  ].filter((a) => a.show);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {/* ── 1. What needs doing ─────────────────────────────────────────── */}
      <div>
        <SectionLabel>Needs attention</SectionLabel>
        {actions.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '14px 16px', background: 'var(--status-active-bg)', border: '1px solid var(--success)', borderRadius: 'var(--radius-md)', color: 'var(--success)', fontSize: 13 }}>
            <CheckCircle2 size={16} /> Nothing waiting — everything billed, approved and collected.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(270px, 100%), 1fr))', gap: 12 }}>
            {actions.map((a) => (
              <div key={a.title} style={{ background: 'var(--bg-secondary)', border: `1px solid color-mix(in srgb, ${a.tone} 25%, transparent)`, borderLeft: `3px solid ${a.tone}`, borderRadius: 'var(--radius-md)', padding: '14px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: a.tone, fontSize: 12, fontWeight: 700 }}>
                  {a.icon}{a.title}
                </div>
                {a.amount !== null && (
                  <div style={{ fontSize: 23, fontWeight: 700, marginTop: 6, fontFamily: 'var(--font-display)' }}>{money(a.amount)}</div>
                )}
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.45 }}>{a.detail}</div>
                {onNavigate && (
                  <button onClick={() => onNavigate(a.tab)} style={{ marginTop: 9, background: 'transparent', border: 'none', color: a.tone, fontSize: 11.5, fontWeight: 700, cursor: 'pointer', padding: 0 }}>
                    {a.cta} →
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 2. Health ───────────────────────────────────────────────────── */}
      <div>
        <SectionLabel>Position</SectionLabel>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Big
            label="Working capital"
            value={money(data.workingCapital)}
            sub="Owed to us − owed by us"
            color={data.workingCapital < 0 ? 'var(--danger)' : 'var(--success)'}
          />
          <Big label="Owed to us" value={money(receivable.outstanding)} sub="Invoiced, uncollected" color="var(--accent)" />
          <Big label="We owe assayers" value={money(payable.approvedUnpaid + payable.awaitingApproval)} sub="Approved + pending approval" color="var(--warning)" />
          <Big
            label="Margin"
            value={profitability.marginPct != null ? `${profitability.marginPct}%` : '—'}
            sub={`${money(profitability.netRevenue)} revenue − ${money(profitability.assayerCost)} cost`}
            color={profitability.margin < 0 ? 'var(--danger)' : 'var(--success)'}
          />
        </div>
      </div>

      {/* ── 3. Where the money is ───────────────────────────────────────── */}
      <div>
        <SectionLabel>Where the money is</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(330px, 100%), 1fr))', gap: 14 }}>
          <Card title="Receivable — money coming in" accent="var(--accent)">
            {/* The order is the actual lifecycle a rupee travels through. */}
            <Pipeline
              steps={[
                { label: 'Unbilled', value: receivable.unbilled, color: 'var(--accent)' },
                { label: 'Invoiced', value: receivable.outstanding, color: 'var(--accent)' },
                { label: 'Collected', value: receivable.collected, color: 'var(--success)' },
              ]}
            />
            {receivable.disputed > 0 && <Line label="Disputed" value={moneyExact(receivable.disputed)} color="var(--danger)" />}
            <SubLabel>Ageing of what is outstanding</SubLabel>
            <Ageing aging={receivable.aging} />
          </Card>

          <Card title="Payable — money going out" accent="var(--warning)">
            <Pipeline
              steps={[
                { label: 'Awaiting approval', value: payable.awaitingApproval, color: 'var(--warning)' },
                { label: 'Approved', value: payable.approvedUnpaid, color: 'var(--accent)' },
                { label: 'Paid', value: payable.paid, color: 'var(--success)' },
              ]}
            />
            {payable.onHold > 0 && <Line label="On hold" value={moneyExact(payable.onHold)} />}
            {payable.disputed > 0 && <Line label="Disputed" value={moneyExact(payable.disputed)} color="var(--danger)" />}
          </Card>

          <Card title="Cash movement" accent="var(--success)">
            <Line
              label={<><ArrowDownLeft size={12} color="var(--success)" /> Received from clients</>}
              value={moneyExact(cashflow.in)} color="var(--success)" hint={`${cashflow.inboundCount} payment(s)`}
            />
            <Line
              label={<><ArrowUpRight size={12} color="var(--danger)" /> Paid to assayers</>}
              value={moneyExact(cashflow.out)} color="var(--danger)" hint={`${cashflow.outboundCount} disbursement(s)`}
            />
            <Line label="Net" value={moneyExact(cashflow.net)} color={cashflow.net < 0 ? 'var(--danger)' : 'var(--success)'} strong />
            {data.recentPayments.length > 0 && <SubLabel>Recent</SubLabel>}
            {data.recentPayments.slice(0, 6).map((p) => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', fontSize: 11.5 }}>
                <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.reference}</span>
                <span style={{ color: p.direction === 'INBOUND' ? 'var(--success)' : 'var(--danger)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  {p.direction === 'INBOUND' ? '+' : '−'}{money(p.amount)}
                </span>
              </div>
            ))}
          </Card>

          <Card title="Statutory position" accent="var(--accent)">
            <Line label="GST collected on sales" value={moneyExact(taxPosition.gstCollected)} hint="Payable to government" />
            <Line label="TDS withheld by clients" value={moneyExact(taxPosition.tdsWithheldByClients)} hint="Creditable against our liability" />
            <Line label="TDS withheld from assayers" value={moneyExact(taxPosition.tdsWithheldFromAssayers)} hint="We remit on their behalf" />
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 9, lineHeight: 1.5 }}>
              Rates come from each client’s contract, not a hardcoded default.
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};

/** Left-to-right stages of a rupee, sized by amount so bottlenecks are visible. */
const Pipeline: React.FC<{ steps: Array<{ label: string; value: number; color: string }> }> = ({ steps }) => {
  const total = steps.reduce((s, x) => s + Math.max(x.value, 0), 0);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', height: 7, borderRadius: 4, overflow: 'hidden', background: 'var(--bg-tertiary)', marginBottom: 9 }}>
        {total > 0 && steps.map((s) => s.value > 0 && (
          <div key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label}: ${moneyExact(s.value)}`} />
        ))}
      </div>
      {steps.map((s) => (
        <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 0' }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: s.color, marginRight: 7 }} />
            {s.label}
          </span>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: s.value > 0 ? s.color : 'var(--text-muted)' }}>{moneyExact(s.value)}</span>
        </div>
      ))}
    </div>
  );
};

const Ageing: React.FC<{ aging: BillingAging }> = ({ aging }) => {
  const buckets: Array<{ k: keyof BillingAging; label: string; color: string }> = [
    { k: 'current', label: 'Not yet due', color: 'var(--success)' },
    { k: 'd1_30', label: '1–30d late', color: 'var(--warning)' },
    { k: 'd31_60', label: '31–60d late', color: 'var(--warning)' },
    { k: 'd61_90', label: '61–90d late', color: 'var(--warning)' },
    { k: 'd90_plus', label: '90d+ late', color: 'var(--danger)' },
  ];
  const total = buckets.reduce((s, b) => s + (aging[b.k] ?? 0), 0);
  if (total === 0) return <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Nothing outstanding.</div>;
  return (
    <>
      <div style={{ display: 'flex', height: 7, borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
        {buckets.map((b) => (aging[b.k] ?? 0) > 0 && (
          <div key={b.k} style={{ width: `${((aging[b.k] ?? 0) / total) * 100}%`, background: b.color }} title={`${b.label}: ${moneyExact(aging[b.k])}`} />
        ))}
      </div>
      {buckets.filter((b) => (aging[b.k] ?? 0) > 0).map((b) => (
        <div key={b.k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, padding: '3px 0' }}>
          <span style={{ color: 'var(--text-secondary)' }}>
            <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 2, background: b.color, marginRight: 6 }} />{b.label}
          </span>
          <span style={{ fontWeight: 600, color: b.color }}>{moneyExact(aging[b.k])}</span>
        </div>
      ))}
    </>
  );
};

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.9px', color: 'var(--text-muted)', marginBottom: 10 }}>{children}</div>
);

const SubLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', margin: '13px 0 7px' }}>{children}</div>
);

const Card: React.FC<{ title: string; accent: string; children: React.ReactNode }> = ({ title, accent, children }) => (
  <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: 17 }}>
    <h3 style={{ fontSize: 12.5, fontWeight: 700, margin: '0 0 13px', color: accent }}>{title}</h3>
    {children}
  </div>
);

const Line: React.FC<{ label: React.ReactNode; value: string; color?: string; hint?: string; strong?: boolean }> = ({ label, value, color, hint, strong }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '5px 0', borderBottom: '1px solid var(--border-color)' }}>
    <span style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      {label}
      {hint && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>· {hint}</span>}
    </span>
    <span style={{ fontSize: strong ? 14.5 : 13, fontWeight: strong ? 700 : 600, color: color ?? 'var(--text-primary)', whiteSpace: 'nowrap' }}>{value}</span>
  </div>
);

const Big: React.FC<{ label: string; value: string; sub?: string; color?: string }> = ({ label, value, sub, color }) => (
  <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '15px 17px', flex: 1, minWidth: 185 }}>
    <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', fontWeight: 600 }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 700, color: color ?? 'var(--text-primary)', marginTop: 5, fontFamily: 'var(--font-display)' }}>{value}</div>
    {sub && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>{sub}</div>}
  </div>
);

const Panel: React.FC<{ children: React.ReactNode; tone?: 'error' }> = ({ children, tone }) => (
  <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: 20, fontSize: 13, color: tone === 'error' ? 'var(--danger)' : 'var(--text-muted)' }}>{children}</div>
);
