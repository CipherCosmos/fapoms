import React, { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Banknote, Search } from 'lucide-react';
import { formatRupees as money } from '@fapoms/shared';
import { useAssayerStatement } from '../../hooks/useBilling';
import { fetchWholeAssayerRoster } from '../../services/assayer-roster';
import { userMessage } from '../../services/errors';
import type { AssayerStatement } from '../../services/billing';
import { Select } from '../../components/ui';
import { payableStatusLabel } from '@fapoms/shared';

/**
 * Assayer statement — what an assayer has earned, been paid, and is still owed.
 *
 * Assayers are the party the business pays, yet the finance app had no per-assayer view: the
 * payables tab is a flat cross-assayer list, so "what have we paid this assayer, what do we
 * still owe, show the payment history" could not be answered from the UI. The endpoint existed
 * and only the mobile app (the assayer's own view) consumed it. The finance manager who signs
 * disbursements now has a statement to sign against.
 */

interface AssayerLite {
  id: string;
  assayerCode: string;
  displayName: string;
  district: string | null;
}

export const AssayerStatementPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const assayerId = params.get('assayer') ?? '';

  const [roster, setRoster] = useState<AssayerLite[]>([]);
  const [search, setSearch] = useState('');
  /** Why the dropdown is not showing everyone: a failed load, or a roster too big to load whole. */
  const [rosterProblem, setRosterProblem] = useState<string | null>(null);
  const statement = useAssayerStatement(assayerId || null);

  /**
   * Every page of the roster, and a sentence when that could not be managed.
   *
   * This asked for `?limit=1000` and swallowed any failure. On the customer's roster of 1,155
   * appraisers, the 155 oldest records were missing from the only control on this page — so their
   * statement could not be opened at all, and the dropdown looked like a complete list of the
   * people who have one. The empty-on-failure case was worse still: a caught-and-discarded error
   * left an empty picker that reads as "nobody is on the roster".
   */
  useEffect(() => {
    let cancelled = false;
    fetchWholeAssayerRoster<AssayerLite>()
      .then(({ people, total, missing }) => {
        if (cancelled) return;
        setRoster(people);
        setRosterProblem(
          missing > 0
            ? `Only ${people.length} of the ${total} people on the roster could be loaded, so ${missing} are not in this list. Reload the page to try again.`
            : null,
        );
      })
      .catch((e) => {
        if (!cancelled) setRosterProblem(`The list of assayers could not be loaded. ${userMessage(e)}`);
      });
    return () => { cancelled = true; };
  }, []);

  const setAssayer = (id: string) => setParams(id ? { assayer: id } : {}, { replace: true });

  const q = search.trim().toLowerCase();
  const filtered = q
    ? roster.filter((a) => a.displayName.toLowerCase().includes(q) || a.assayerCode.toLowerCase().includes(q))
    : roster;

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1200, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Assayer statement</h1>
        <Link to="/billing?tab=payouts" style={{ fontSize: 12.5, color: 'var(--accent)', textDecoration: 'none' }}>← Back to Billing</Link>
      </div>

      <div style={{ ...card, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Banknote size={16} style={{ color: 'var(--accent)' }} />
        <div style={{ position: 'relative' }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find an assayer…"
            style={{ padding: '7px 10px 7px 28px', fontSize: 12.5, background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', minWidth: 220 }} />
        </div>
        <Select
          value={assayerId}
          onChange={setAssayer}
          placeholder="Choose an assayer…"
          options={filtered.map((a) => ({ value: a.id, label: `${a.displayName} · ${a.assayerCode}` }))}
          compact
          style={{ minWidth: 240 }}
        />
        {/* A picker that is quietly short of names is indistinguishable from one whose names have
            all been shown, so the difference is stated rather than left to be discovered. */}
        {rosterProblem && (
          <div style={{ flexBasis: '100%', fontSize: 11.5, color: 'var(--warning)', lineHeight: 1.5 }}>
            {rosterProblem}
          </div>
        )}
      </div>

      {!assayerId && <div style={{ ...card, color: 'var(--text-muted)', fontSize: 13 }}>Pick an assayer to see their statement.</div>}
      {assayerId && statement.isLoading && <div style={{ ...card, color: 'var(--text-muted)' }}>Loading statement…</div>}
      {assayerId && statement.error && <div style={{ ...card, color: 'var(--danger)' }}>{(statement.error as Error).message}</div>}
      {statement.data && <StatementBody data={statement.data} />}
    </div>
  );
};

const StatementBody: React.FC<{ data: AssayerStatement }> = ({ data }) => {
  const t = data.totals;
  return (
    <>
      <div style={card}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{data.assayerName ?? data.assayerId}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {data.assayerCode && <span>{data.assayerCode}</span>}
          {/* PAN and the TDS section, for the finance manager reconciling withholding against the
              payouts below. PAN is decrypted server-side; shown here only to billing staff. */}
          <span>PAN: <strong style={{ color: data.pan ? 'var(--text-secondary)' : 'var(--danger)' }}>{data.pan ?? 'not on file'}</strong></span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Stat label="Earned" value={money(t.earned)} tone="var(--accent)" />
        <Stat label="Paid" value={money(t.paid)} tone="var(--success)" />
        <Stat label="Outstanding" value={money(t.outstanding)} tone={t.outstanding > 0 ? 'var(--warning)' : 'var(--text-muted)'} />
        <Stat label="Awaiting approval" value={money(t.awaitingApproval)} tone="var(--text-secondary)" />
        <Stat label="On hold" value={money(t.onHoldOrDisputed)} tone={t.onHoldOrDisputed > 0 ? 'var(--danger)' : 'var(--text-muted)'} />
        <Stat label={`TDS withheld (u/s ${data.tdsSection})`} value={money(t.tdsWithheld)} tone={t.tdsWithheld > 0 ? 'var(--warning)' : 'var(--text-muted)'} />
      </div>

      {data.payables.length > 0 && (
        <div style={card}>
          <div style={{ ...label, marginBottom: 10 }}>Payouts ({data.payables.length})</div>
          <SimpleTable
            head={['Payout', 'Status', 'Base', 'Travel', 'TDS', 'Total', 'Paid', 'Outstanding']}
            rows={data.payables.map((p) => [
              p.expenseId ? `${p.payableNumber} · reimbursement` : p.payableNumber,
              p.onHold ? `${payableStatusLabel(p.status)} · on hold${p.holdReason ? ` (${p.holdReason})` : ''}` : payableStatusLabel(p.status),
              money(p.baseAmount), money(p.travelAmount),
              `−${money(p.tdsAmount)}`, money(p.totalAmount), money(p.paidAmount), money(p.outstanding),
            ])}
          />
        </div>
      )}

      {data.payments.length > 0 && (
        <div style={card}>
          <div style={{ ...label, marginBottom: 10 }}>Payments made ({data.payments.length})</div>
          <SimpleTable
            head={['Reference', 'Method', 'Amount', 'Paid on', 'Balance after', 'Note']}
            rows={data.payments.map((p) => [
              p.paymentReference, p.method, money(p.amount),
              p.paidDate ? new Date(p.paidDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—',
              p.balanceAfter != null ? money(p.balanceAfter) : '—', p.notes ?? '',
            ])}
          />
        </div>
      )}

      {data.payables.length === 0 && data.payments.length === 0 && (
        <div style={{ ...card, color: 'var(--text-muted)', fontSize: 13 }}>No payouts or payments recorded for this assayer yet.</div>
      )}
    </>
  );
};

const Stat: React.FC<{ label: string; value: string; tone?: string }> = ({ label, value, tone }) => (
  <div style={{ ...card, flex: '1 1 150px', minWidth: 0 }}>
    <div style={{ fontSize: 22, fontWeight: 700, color: tone ?? 'var(--text-primary)', lineHeight: 1.1 }}>{value}</div>
    <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 700, marginTop: 6 }}>{label}</div>
  </div>
);

const SimpleTable: React.FC<{ head: string[]; rows: React.ReactNode[][] }> = ({ head, rows }) => (
  <div style={{ overflowX: 'auto' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
      <thead>
        <tr>{head.map((h, i) => <th key={h} style={{ ...label, textAlign: i === 0 ? 'left' : 'right', padding: '8px 10px', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' }}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ borderBottom: '1px solid var(--border-hair)' }}>
            {r.map((c, j) => <td key={j} style={{ padding: '8px 10px', textAlign: j === 0 ? 'left' : 'right', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md, 10px)', padding: 16,
};
const label: React.CSSProperties = {
  fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 700,
};
