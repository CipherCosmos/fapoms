import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, Building2, TrendingUp, Wallet } from 'lucide-react';
import { activityEventLabel, type BillingAttentionItem, type BillingOverview } from '@fapoms/shared';
import { moneyTotal as money, moneyExact } from '../../utils/money';
import { Card, Empty, fmtDate, th, td, tdNum, tableScrollStyle } from './shared';

/**
 * Where the money stands — the read-only half of the old Overview tab.
 *
 * The Overview used to do two jobs at once: tell a clerk what to do, and tell a manager where
 * the book is. They are different questions asked by different people at different times, and
 * mixing them is why the page opened on four large totals that nobody could act on, with the
 * day's actual work in a card below the fold. The work is now the `TodoTab` queue above this;
 * what is left here is the position, and it is allowed to be a wall of numbers because looking
 * is all it is for.
 *
 * Every figure is the server's, computed from the same rows the other tabs list. Nothing on this
 * screen adds anything up.
 */
export const MoneyPosition: React.FC<{ data: BillingOverview }> = ({ data }) => {
  const { payouts, receivables, margin, tax, cashflow, byClient } = data;

  /**
   * "Owed to assayers" was one number — due + approved — and it hid the distinction the whole
   * pay screen now turns on. Of the ₹64,200 it reported on the live book, ₹30,450 was sitting
   * with assayers for confirmation and could not be approved by anyone at the desk, ₹25,650 had
   * no bill yet, and only ₹8,100 was actually ready to pay. One number, three different jobs.
   *
   * The server has reported them apart since `unbilled`/`inClaimReview` were added; they are
   * optional on the type because an older backend does not send them, and when they are absent
   * the subtitle says what it knows instead of inventing a split.
   */
  const owedToAssayers = payouts.due + payouts.approved;
  const splitKnown = payouts.unbilled !== undefined && payouts.inClaimReview !== undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: 12 }}>
        <Big
          icon={<ArrowDownLeft size={16} />} tone="var(--accent)" label="Owed by clients"
          value={money(receivables.outstanding)}
          sub={receivables.outstanding === 0 && receivables.unbilled > 0
            // "₹0 invoiced · ₹0 collected" next to a tab listing fourteen invoices is a screen
            // arguing with itself. Nothing is owed until an invoice is SENT, and that is what
            // the reader needs told — not three zeroes.
            ? `Nothing sent yet · ${money(receivables.unbilled)} of work still to invoice`
            : `${money(receivables.invoiced)} sent · ${money(receivables.collected)} collected`}
        />
        <Big
          icon={<Wallet size={16} />} tone="var(--warning)" label="Owed to assayers"
          value={money(owedToAssayers)}
          sub={splitKnown
            ? `${money(payouts.approved)} ready to pay · ${money(payouts.inClaimReview!)} with assayers · ${money(payouts.unbilled!)} not billed`
            : `${money(payouts.approved)} ready to pay · ${money(payouts.paid)} paid out`}
        />
        <Big
          icon={<TrendingUp size={16} />} tone={margin.margin >= 0 ? 'var(--success)' : 'var(--danger)'} label="Margin"
          value={money(margin.margin)}
          sub={margin.marginPct === null ? `${money(margin.revenue)} revenue` : `${margin.marginPct}% of ${money(margin.revenue)} revenue`}
        />
        <Big icon={<ArrowUpRight size={16} />} tone="var(--text-secondary)" label="Cash" value={money(cashflow.net)} sub={`${money(cashflow.in)} in · ${money(cashflow.out)} out`} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: 14, alignItems: 'start' }}>
        <Card title="How overdue the client money is">
          <Rows rows={[
            ['Not yet due', money(receivables.aging.current)],
            ['1–30 days overdue', money(receivables.aging.d1_30)],
            ['31–60 days', money(receivables.aging.d31_60)],
            ['61–90 days', money(receivables.aging.d61_90)],
            ['Over 90 days', money(receivables.aging.d90_plus)],
          ]} />
        </Card>
        <Card title="Tax">
          <Rows rows={[
            ['GST charged to clients', moneyExact(tax.gstCollected)],
            ['TDS withheld by clients', moneyExact(tax.tdsWithheldByClients)],
            ['TDS withheld from assayers', moneyExact(tax.tdsWithheldFromAssayers)],
          ]} />
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: 8 }}>Revenue and cost are ex-GST and pre-TDS.</div>
        </Card>
      </div>

      <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Building2 size={14} /> Each client</span>}>
        {byClient.length === 0 ? <Empty>No client has been billed yet.</Empty> : (
          <div style={tableScrollStyle}>
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
        <Card title="What happened recently">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.recentActivity.map((h) => (
              <div key={h.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 'var(--text-xs)', padding: '6px 0', borderBottom: '1px solid var(--border-hair, var(--border-color))' }}>
                <span style={{ color: 'var(--text-secondary)' }}>
                  <strong style={{ color: 'var(--text-primary)' }}>{describeAction(h.action)}</strong>
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
  UNSETTLED_FEE: 'var(--warning)',
  FEE_CHANGED: 'var(--warning)',
  HELD: 'var(--danger)',
  OVERDUE_INVOICE: 'var(--danger)',
};
const ATTENTION_LABEL: Record<BillingAttentionItem['kind'], string> = {
  UNBOOKED: 'Not booked',
  UNSETTLED_FEE: 'No recorded fee',
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
        <div key={`${it.kind}-${it.payableId ?? it.entryId ?? it.invoiceId ?? it.assignmentId ?? i}`} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 'var(--text-xs)', padding: '6px 8px', borderLeft: `3px solid ${tone}`, background: `color-mix(in srgb, ${tone} 6%, transparent)`, borderRadius: 'var(--radius-sm)' }}>
          <span style={{ color: tone, fontWeight: 700, whiteSpace: 'nowrap', fontSize: 'var(--text-2xs)' }}>{ATTENTION_LABEL[it.kind]}</span>
          <span style={{ color: 'var(--text-primary)', fontWeight: 600, whiteSpace: 'nowrap' }}>{who || '—'}</span>
          <span style={{ color: 'var(--text-secondary)', flex: 1 }}>{it.detail}</span>
          {it.amount != null && <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{money(it.amount)}</span>}
        </div>
      );
    })}
  </div>
);

const Big: React.FC<{ icon: React.ReactNode; tone: string; label: string; value: string; sub?: string; title?: string }> = ({ icon, tone, label, value, sub, title }) => (
  <div title={title || `${label}: ${value}${sub ? ` (${sub})` : ''}`} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '14px 16px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: tone, fontSize: 'var(--text-2xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{icon}{label}</div>
    <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, marginTop: 6, fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}>{value}</div>
    {sub && <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: 4 }}>{sub}</div>}
  </div>
);

const Rows: React.FC<{ rows: Array<[string, string]> }> = ({ rows }) => (
  <div>
    {rows.map(([k, v]) => (
      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px dashed var(--border-color)', fontSize: 'var(--text-xs)' }}>
        <span style={{ color: 'var(--text-muted)' }}>{k}</span>
        <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
      </div>
    ))}
  </div>
);

/**
 * Billing-history verbs, in the finance desk's own words.
 *
 * These stay local because they are billing's vocabulary, not the generic activity feed's:
 * `PAYABLE_STATUS_CHANGED` means one specific thing on this ledger ("Payout approved") that a
 * shared map cannot know. Unrecognised actions borrow `activityEventLabel`, which already knows
 * how to phrase an unknown event type as a sentence, rather than de-casing a database constant.
 */
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
export const describeAction = (action: string) => ACTION_WORDS[action] ?? activityEventLabel(action);
