import React from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowDownLeft, ArrowUpRight, CheckCircle2, Clock, FileText, PauseCircle, Wallet, TrendingUp,
} from 'lucide-react';
import type { BillingAttentionItem } from '@fapoms/shared';
import { useBillingOverview } from '../../hooks/useBilling';
import { moneyTotal as money, moneyExact } from '../../utils/money';
import { Card, SectionLabel, Empty, fmtDate, th, td, tdNum } from './shared';

/**
 * The finance overview — three questions, in order: what needs doing, where the money is, and
 * how each client is doing. Every figure is one the server computed from the same rows the
 * Payouts and Invoices tabs show; nothing is added up here.
 */
export const OverviewTab: React.FC<{ onGo: (tab: 'payouts' | 'invoices', filter?: string) => void }> = ({ onGo }) => {
  const { data, isLoading, error } = useBillingOverview();

  if (isLoading) return <Empty>Loading the book…</Empty>;
  if (error || !data) return <Empty>Could not load the finance overview.</Empty>;

  const { payouts, receivables, margin, tax, cashflow, attention, byClient } = data;
  const overdue = receivables.aging.d1_30 + receivables.aging.d31_60 + receivables.aging.d61_90 + receivables.aging.d90_plus;

  const todo = [
    {
      show: payouts.due > 0, icon: <Clock size={15} />, tone: 'var(--warning)',
      title: `${payouts.dueCount} payout${payouts.dueCount === 1 ? '' : 's'} to approve`, amount: payouts.due,
      detail: 'Assayers have completed this work. One approval, then it can be paid.',
      cta: 'Approve', go: () => onGo('payouts', 'PENDING'),
    },
    {
      show: payouts.approved > 0, icon: <ArrowUpRight size={15} />, tone: 'var(--accent)',
      title: `${payouts.approvedCount} approved, ready to pay`, amount: payouts.approved,
      detail: 'Cleared for payment to assayers.',
      cta: 'Pay', go: () => onGo('payouts', 'APPROVED'),
    },
    {
      show: receivables.unbilled > 0, icon: <FileText size={15} />, tone: 'var(--accent)',
      title: 'Completed work to invoice', amount: receivables.unbilled,
      detail: 'Delivered but not yet on an invoice — cash stuck in the pipeline.',
      cta: 'Create invoices', go: () => onGo('invoices'),
    },
    {
      show: overdue > 0, icon: <AlertTriangle size={15} />, tone: 'var(--danger)',
      title: 'Overdue from clients', amount: overdue,
      detail: 'Past the due date set by the client’s payment terms — chase collection.',
      cta: 'View invoices', go: () => onGo('invoices', 'ISSUED'),
    },
    {
      show: payouts.held > 0 || receivables.held > 0, icon: <PauseCircle size={15} />, tone: 'var(--danger)',
      title: 'On hold', amount: payouts.held + receivables.held,
      detail: `${payouts.heldCount} payout${payouts.heldCount === 1 ? '' : 's'} and ${money(receivables.held)} of client lines are held. Release or resolve.`,
      cta: 'Review', go: () => onGo('payouts', 'HELD'),
    },
  ].filter((a) => a.show);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <SectionLabel>Needs doing</SectionLabel>
        {todo.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '14px 16px', background: 'var(--status-active-bg)', border: '1px solid var(--success)', borderRadius: 'var(--radius-md)', color: 'var(--success)', fontSize: 13 }}>
            <CheckCircle2 size={16} /> Nothing waiting — everything booked, approved, paid and invoiced.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 12 }}>
            {todo.map((a) => (
              <div key={a.title} style={{ background: 'var(--bg-secondary)', border: `1px solid color-mix(in srgb, ${a.tone} 25%, transparent)`, borderLeft: `3px solid ${a.tone}`, borderRadius: 'var(--radius-md)', padding: '14px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: a.tone, fontSize: 12, fontWeight: 700 }}>{a.icon}{a.title}</div>
                <div style={{ fontSize: 23, fontWeight: 700, marginTop: 6, fontFamily: 'var(--font-display)' }}>{money(a.amount)}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.45 }}>{a.detail}</div>
                <button onClick={a.go} style={{ marginTop: 9, background: 'transparent', border: 'none', color: a.tone, fontSize: 11.5, fontWeight: 700, cursor: 'pointer', padding: 0 }}>{a.cta} →</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {attention.length > 0 && (
        <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><AlertTriangle size={14} style={{ color: 'var(--warning)' }} /> Worth a look ({attention.length})</span>}>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10 }}>
            Derived from the live rows on every load. Fix the cause and the item disappears — there is nothing to "resolve" here.
          </div>
          <AttentionList items={attention} />
        </Card>
      )}

      <div>
        <SectionLabel>Position</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: 12 }}>
          <Big icon={<ArrowDownLeft size={16} />} tone="var(--accent)" label="Owed by clients" value={money(receivables.outstanding)} sub={`${money(receivables.invoiced)} invoiced · ${money(receivables.collected)} collected`} />
          <Big icon={<Wallet size={16} />} tone="var(--warning)" label="Owed to assayers" value={money(payouts.due + payouts.approved)} sub={`${money(payouts.paid)} paid out`} />
          <Big icon={<TrendingUp size={16} />} tone={margin.margin >= 0 ? 'var(--success)' : 'var(--danger)'} label="Margin" value={money(margin.margin)} sub={margin.marginPct === null ? `${money(margin.revenue)} revenue` : `${margin.marginPct}% of ${money(margin.revenue)} revenue`} />
          <Big icon={<ArrowUpRight size={16} />} tone="var(--text-secondary)" label="Cash" value={money(cashflow.net)} sub={`${money(cashflow.in)} in · ${money(cashflow.out)} out`} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 12 }}>
        <Card title="Receivables ageing">
          <Rows rows={[
            ['Not yet due', money(receivables.aging.current)],
            ['1–30 days overdue', money(receivables.aging.d1_30)],
            ['31–60 days', money(receivables.aging.d31_60)],
            ['61–90 days', money(receivables.aging.d61_90)],
            ['Over 90 days', money(receivables.aging.d90_plus)],
          ]} />
        </Card>
        <Card title="Tax position">
          <Rows rows={[
            ['GST charged to clients', moneyExact(tax.gstCollected)],
            ['TDS withheld by clients', moneyExact(tax.tdsWithheldByClients)],
            ['TDS withheld from assayers', moneyExact(tax.tdsWithheldFromAssayers)],
          ]} />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>Revenue and cost above are ex-GST and pre-TDS: what the work earned and what it cost.</div>
        </Card>
      </div>

      <Card title="By client">
        {byClient.length === 0 ? <Empty>No client has been billed yet.</Empty> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>Client</th><th style={{ ...th, textAlign: 'right' }}>Rate</th><th style={{ ...th, textAlign: 'right' }}>Audits</th>
                <th style={{ ...th, textAlign: 'right' }}>To invoice</th><th style={{ ...th, textAlign: 'right' }}>Invoiced</th><th style={{ ...th, textAlign: 'right' }}>Outstanding</th>
                <th style={{ ...th, textAlign: 'right' }}>Revenue</th><th style={{ ...th, textAlign: 'right' }}>Cost</th><th style={{ ...th, textAlign: 'right' }}>Margin</th>
              </tr></thead>
              <tbody>
                {byClient.map((c) => (
                  <tr key={c.clientId}>
                    <td style={td}><Link to={`/clients?client=${c.clientId}&tab=billing`} style={{ color: 'var(--text-primary)', fontWeight: 600, textDecoration: 'none' }}>{c.clientName}</Link></td>
                    <td style={tdNum}>{c.clientRate ? money(c.clientRate) : <span style={{ color: 'var(--warning)' }} title="No rate set — billed at the assayer fee, zero margin">at cost</span>}</td>
                    <td style={tdNum}>{c.assignmentCount}</td>
                    <td style={tdNum}>{money(c.unbilled)}</td>
                    <td style={tdNum}>{money(c.invoiced)}</td>
                    <td style={tdNum}>{money(c.outstanding)}</td>
                    <td style={tdNum}>{money(c.revenue)}</td>
                    <td style={tdNum}>{money(c.cost)}</td>
                    <td style={{ ...tdNum, color: c.margin >= 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 600 }}>{money(c.margin)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {data.recentActivity.length > 0 && (
        <Card title="Recent activity">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.recentActivity.map((h) => (
              <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, padding: '6px 0', borderBottom: '1px solid var(--border-hair, var(--border-color))' }}>
                <span style={{ color: 'var(--text-secondary)' }}>
                  <strong style={{ color: 'var(--text-primary)' }}>{describeAction(h.action)}</strong>
                  {h.fromState && h.toState ? ` · ${h.fromState} → ${h.toState}` : ''}
                  {h.reason ? ` — ${h.reason}` : ''}
                </span>
                <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{h.userName ?? ''} · {fmtDate(h.occurredAt)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
};

const ATTENTION_TONE: Record<BillingAttentionItem['kind'], string> = {
  UNBOOKED: 'var(--warning)',
  UNSETTLED_FEE: 'var(--danger)',
  FEE_CHANGED: 'var(--warning)',
  HELD: 'var(--danger)',
  OVERDUE_INVOICE: 'var(--danger)',
};
const ATTENTION_LABEL: Record<BillingAttentionItem['kind'], string> = {
  UNBOOKED: 'Not booked',
  UNSETTLED_FEE: 'Fee never agreed',
  FEE_CHANGED: 'Fee changed',
  HELD: 'On hold',
  OVERDUE_INVOICE: 'Overdue',
};

export const AttentionList: React.FC<{ items: BillingAttentionItem[] }> = ({ items }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    {items.map((it, i) => {
      const tone = ATTENTION_TONE[it.kind];
      const who = [it.assignmentNumber, it.invoiceNumber, it.clientName, it.assayerName].filter(Boolean).join(' · ');
      return (
        <div key={`${it.kind}-${it.payableId ?? it.entryId ?? it.invoiceId ?? it.assignmentId ?? i}`} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 12.5, padding: '6px 8px', borderLeft: `3px solid ${tone}`, background: `color-mix(in srgb, ${tone} 6%, transparent)`, borderRadius: 'var(--radius-sm)' }}>
          <span style={{ color: tone, fontWeight: 700, whiteSpace: 'nowrap', fontSize: 11 }}>{ATTENTION_LABEL[it.kind]}</span>
          <span style={{ color: 'var(--text-primary)', fontWeight: 600, whiteSpace: 'nowrap' }}>{who || '—'}</span>
          <span style={{ color: 'var(--text-secondary)', flex: 1 }}>{it.detail}</span>
          {it.amount != null && <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{money(it.amount)}</span>}
        </div>
      );
    })}
  </div>
);

const Big: React.FC<{ icon: React.ReactNode; tone: string; label: string; value: string; sub?: string }> = ({ icon, tone, label, value, sub }) => (
  <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '14px 16px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: tone, fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{icon}{label}</div>
    <div style={{ fontSize: 24, fontWeight: 700, marginTop: 6, fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}>{value}</div>
    {sub && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{sub}</div>}
  </div>
);

const Rows: React.FC<{ rows: Array<[string, string]> }> = ({ rows }) => (
  <div>
    {rows.map(([k, v]) => (
      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px dashed var(--border-color)', fontSize: 12.5 }}>
        <span style={{ color: 'var(--text-muted)' }}>{k}</span>
        <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
      </div>
    ))}
  </div>
);

const ACTION_WORDS: Record<string, string> = {
  PAYABLE_CREATED: 'Payout booked',
  ENTRY_CREATED: 'Client line booked',
  PAYABLE_STATUS_CHANGED: 'Payout approved',
  DISBURSEMENT_PAID: 'Payout paid',
  PAYABLE_HOLD_CHANGED: 'Payout hold changed',
  PAYABLE_REPRICED: 'Payout re-priced',
  ENTRY_REPRICED: 'Client line re-priced',
  ENTRY_ADJUSTED: 'Client line adjusted',
  ENTRY_HOLD_CHANGED: 'Client line hold changed',
  ENTRY_INVOICED: 'Line invoiced',
  ENTRY_UNINVOICED: 'Line returned to unbilled',
  INVOICE_CREATED: 'Invoice created',
  INVOICE_STATUS_CHANGED: 'Invoice status changed',
  PAYMENT_RECEIVED: 'Client payment received',
  PAYMENT_REVERSED: 'Payment reversed',
};
export const describeAction = (action: string) => ACTION_WORDS[action] ?? action.replace(/_/g, ' ').toLowerCase();
