import React, { useState } from 'react';
import { BookOpen, TrendingUp, Search } from 'lucide-react';
import { formatRupees as money } from '@fapoms/shared';
import { useSearchParams, Link } from 'react-router-dom';
import { useEntityLedger, useBillingClients } from '../../hooks/useBilling';
import type { EntityLedger } from '../../services/billing';

/**
 * The ledger — the complete money picture for any one client, project, branch, assayer or
 * assignment: revenue, cost, margin, collected, outstanding, a monthly margin trend, and the
 * entries, payables, payments and history behind them.
 *
 * The backend computed all of this and no screen rendered it — the single richest per-entity
 * finance view in the product had no UI at all. This is that view.
 */

type EntityType = EntityLedger['entityType'];

const ENTITY_TYPES: EntityType[] = ['client', 'project', 'branch', 'assayer', 'assignment'];

export const LedgerPage: React.FC = () => {
  const [params] = useSearchParams();
  const clients = useBillingClients();

  // Opens on whatever entity the URL points at (?type=client&id=…), which is how the finance
  // pages link into it; otherwise the operator picks one.
  const [entityType, setEntityType] = useState<EntityType>((params.get('type') as EntityType) || 'client');
  const [entityId, setEntityId] = useState<string>(params.get('id') || params.get('client') || '');

  const ledger = useEntityLedger(entityType, entityId || null);

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1300, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Ledger</h1>
        <Link to="/billing" style={{ fontSize: 12.5, color: 'var(--accent)', textDecoration: 'none' }}>← Back to Finance</Link>
      </div>
      <div style={{ ...card, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <BookOpen size={16} style={{ color: 'var(--accent)' }} />
        <select value={entityType} onChange={(e) => setEntityType(e.target.value as EntityType)} style={selectStyle}>
          {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
        </select>
        {entityType === 'client' ? (
          <select value={entityId} onChange={(e) => setEntityId(e.target.value)} style={{ ...selectStyle, minWidth: 240 }}>
            <option value="">Choose a client…</option>
            {clients.data?.map((c) => <option key={c.clientId} value={c.clientId}>{c.clientName}</option>)}
          </select>
        ) : (
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder={`${entityType} id`}
              style={{ ...selectStyle, paddingLeft: 28, minWidth: 300, fontFamily: 'monospace' }} />
          </div>
        )}
      </div>

      {!entityId && <div style={{ ...card, color: 'var(--text-muted)', fontSize: 13 }}>Pick an entity to see its ledger.</div>}
      {entityId && ledger.isLoading && <div style={{ ...card, color: 'var(--text-muted)' }}>Loading ledger…</div>}
      {entityId && ledger.error && <div style={{ ...card, color: 'var(--danger)' }}>{(ledger.error as Error).message}</div>}

      {ledger.data && <LedgerBody data={ledger.data} />}
    </div>
  );
};

const LedgerBody: React.FC<{ data: EntityLedger }> = ({ data }) => {
  const t = data.totals;
  const marginTone = t.margin > 0 ? 'var(--success)' : t.margin < 0 ? 'var(--danger)' : 'var(--text-muted)';

  return (
    <>
      <div style={card}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{data.subject.label ?? data.entityId}</div>
        {data.subject.ref && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{data.subject.ref}</div>}
      </div>

      {/* The two sides and the spread between them. */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Stat label="Revenue (billed)" value={money(t.billedToClient)} tone="var(--accent)" />
        <Stat label="Assayer cost" value={money(t.assayerCost)} tone="var(--text-secondary)" />
        <Stat label="Margin" value={money(t.margin)} tone={marginTone}
          sub={t.marginPct != null ? `${t.marginPct.toFixed(1)}%` : undefined} />
        <Stat label="Collected" value={money(t.collected)} tone="var(--success)" />
        <Stat label="Outstanding" value={money(t.outstanding)} tone={t.outstanding > 0 ? 'var(--warning)' : 'var(--text-muted)'} />
        <Stat label="Assayer still owed" value={money(t.assayerOwed)} tone={t.assayerOwed > 0 ? 'var(--warning)' : 'var(--text-muted)'} />
      </div>

      {data.monthly.length > 0 && (
        <div style={card}>
          <div style={{ ...label, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <TrendingUp size={13} /> Monthly revenue, cost and margin
          </div>
          <MarginTrend rows={data.monthly} />
        </div>
      )}

      {data.entries.length > 0 && (
        <div style={card}>
          <div style={{ ...label, marginBottom: 10 }}>Billing entries ({data.entries.length})</div>
          <SimpleTable
            head={['Entry', 'State', 'Taxable', 'GST', 'TDS', 'Total', 'Outstanding']}
            rows={data.entries.map((e) => [
              e.entryNumber, e.state, money(e.taxableAmount), money(e.taxAmount),
              money(e.tdsAmount), money(e.totalAmount), money(e.outstandingAmount),
            ])}
          />
        </div>
      )}

      {data.payables.length > 0 && (
        <div style={card}>
          <div style={{ ...label, marginBottom: 10 }}>Assayer payables ({data.payables.length})</div>
          <SimpleTable
            head={['Payable', 'Status', 'Base', 'Travel', 'TDS', 'Total', 'Outstanding']}
            rows={data.payables.map((p) => [
              p.payableNumber, p.status, money(p.baseAmount), money(p.travelAmount),
              money(p.tdsAmount), money(p.totalAmount), money(p.outstanding),
            ])}
          />
        </div>
      )}

      {data.history.length > 0 && (
        <div style={card}>
          <div style={{ ...label, marginBottom: 10 }}>Financial history ({data.history.length})</div>
          <SimpleTable
            head={['When', 'Action', 'From', 'To', 'By', 'Reason']}
            rows={data.history.map((h) => [
              new Date(h.occurredAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
              h.action, h.fromState ?? '—', h.toState ?? '—', h.userName ?? 'System', h.reason ?? '',
            ])}
          />
        </div>
      )}
    </>
  );
};

const MarginTrend: React.FC<{ rows: EntityLedger['monthly'] }> = ({ rows }) => {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.revenue, r.cost)));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map((r) => (
        <div key={r.month} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
          <span style={{ width: 64, color: 'var(--text-muted)' }}>{r.month}</span>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--accent)', width: `${(r.revenue / max) * 100}%`, minWidth: 2 }} title={`Revenue ${money(r.revenue)}`} />
            <div style={{ height: 6, borderRadius: 3, background: 'var(--text-muted)', width: `${(r.cost / max) * 100}%`, minWidth: 2 }} title={`Cost ${money(r.cost)}`} />
          </div>
          <span style={{ width: 90, textAlign: 'right', fontWeight: 600, color: r.margin >= 0 ? 'var(--success)' : 'var(--danger)' }}>
            {money(r.margin)}
          </span>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 14, marginTop: 4, fontSize: 10.5, color: 'var(--text-muted)' }}>
        <Legend color="var(--accent)" text="Revenue" />
        <Legend color="var(--text-muted)" text="Cost" />
        <span>Right: margin</span>
      </div>
    </div>
  );
};

const Legend: React.FC<{ color: string; text: string }> = ({ color, text }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
    <span style={{ width: 10, height: 6, borderRadius: 3, background: color, display: 'inline-block' }} /> {text}
  </span>
);

const Stat: React.FC<{ label: string; value: string; tone?: string; sub?: string }> = ({ label, value, tone, sub }) => (
  <div style={{ ...card, flex: '1 1 150px', minWidth: 0 }}>
    <div style={{ fontSize: 22, fontWeight: 700, color: tone ?? 'var(--text-primary)', lineHeight: 1.1 }}>
      {value}{sub && <span style={{ fontSize: 13, marginLeft: 6, color: 'var(--text-muted)' }}>{sub}</span>}
    </div>
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
const selectStyle: React.CSSProperties = {
  padding: '7px 11px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 13,
};
