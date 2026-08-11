import React, { useState } from 'react';
import { ChevronRight, ChevronDown, TrendingDown, TrendingUp, AlertCircle } from 'lucide-react';
import { useClientBillingReport } from '../../hooks/useBilling';
import type { BillingProjectRollup, BillingAssignmentRollup } from '../../services/billing';
import { formatRupees } from '@fapoms/shared';

// Paise matter on the client billing hierarchy; every other surface rounds to whole rupees.
const money = (n?: number | null) => formatRupees(n, { decimals: 2 });

/**
 * Client → Projects → Assignments, with the revenue and the assayer cost booked
 * against the same job so margin is visible at every level.
 *
 * This is the view the billing screens never had: entries were listed flat with
 * only foreign keys, so there was no way to ask "which project is unbilled" or
 * "is this job profitable" without leaving the page.
 */
export const ClientHierarchyPanel: React.FC<{ clientId: string | null }> = ({ clientId }) => {
  const { data, isLoading, error } = useClientBillingReport(clientId);
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});

  if (!clientId) {
    return <Empty>Select a client above to see its projects, assignments and margin.</Empty>;
  }
  if (isLoading) return <Empty>Loading client billing…</Empty>;
  if (error) return <Empty tone="error">Could not load this client's billing report.</Empty>;
  if (!data) return null;

  const t = data.totals;
  // Projects with no billing lines add nothing but noise.
  const projects = data.projects.filter((p) => p.entryCount > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Stat label="Net Revenue" value={money(t.revenue)} hint="Taxable value, excludes GST" />
        <Stat label="Assayer Cost" value={money(t.assayerCost)} hint="Fee + travel owed to assayers" color="var(--warning)" />
        <Stat
          label="Margin"
          value={`${money(t.margin)}${t.marginPct !== null ? `  (${t.marginPct}%)` : ''}`}
          color={t.margin < 0 ? 'var(--danger)' : 'var(--success)'}
          hint={t.margin < 0 ? 'Costs exceed billed revenue' : undefined}
        />
        <Stat label="Unbilled" value={money(t.pending)} hint="Earned but not yet invoiced" color="var(--accent)" />
        <Stat label="Outstanding" value={money(t.outstanding)} hint="Invoiced, awaiting payment" color="var(--accent)" />
      </div>

      <AgingBar aging={data.aging} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {projects.length === 0 && <Empty>No billing lines recorded for this client yet.</Empty>}
        {projects.map((p) => {
          const key = p.projectId ?? 'unassigned';
          const open = openProjects[key] ?? true;
          return (
            <ProjectRow
              key={key}
              project={p}
              open={open}
              onToggle={() => setOpenProjects((s) => ({ ...s, [key]: !open }))}
            />
          );
        })}
      </div>
    </div>
  );
};

const ProjectRow: React.FC<{ project: BillingProjectRollup; open: boolean; onToggle: () => void }> = ({ project: p, open, onToggle }) => (
  <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
    <button
      onClick={onToggle}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px',
        background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--text-primary)',
      }}
    >
      {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{p.projectName}</div>
        {p.projectNumber && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{p.projectNumber}</div>}
      </div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12, alignItems: 'center' }}>
        <Metric label="Revenue" value={money(p.revenue)} />
        <Metric label="Cost" value={money(p.cost)} />
        <Metric
          label="Margin"
          value={`${money(p.margin)}${p.marginPct !== null ? ` (${p.marginPct}%)` : ''}`}
          color={p.margin < 0 ? 'var(--danger)' : 'var(--success)'}
        />
        <Metric label="Lines" value={String(p.entryCount)} />
      </div>
    </button>

    {open && (
      <div style={{ borderTop: '1px solid var(--border-color)', padding: '4px 0' }}>
        {p.assignments.length === 0 && (
          <div style={{ padding: '12px 46px', fontSize: 12, color: 'var(--text-muted)' }}>
            No assignment-level lines — billed at project or client level.
          </div>
        )}
        {p.assignments.map((a) => <AssignmentRow key={a.assignmentId} a={a} />)}
      </div>
    )}
  </div>
);

const AssignmentRow: React.FC<{ a: BillingAssignmentRollup }> = ({ a }) => {
  const loss = a.margin < 0;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px 10px 46px',
      borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap',
    }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>
          {a.branchName ?? 'Unknown branch'}
          {loss && (
            <span title="This job costs more than it earns" style={{ marginLeft: 8, color: 'var(--danger)', display: 'inline-flex', verticalAlign: 'middle' }}>
              <AlertCircle size={13} />
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {a.assignmentNumber ?? '—'}{a.assayerName ? ` · ${a.assayerName}` : ''}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <Metric label="Revenue" value={money(a.revenue)} />
        <Metric label="Cost" value={a.cost > 0 ? money(a.cost) : '—'} />
        <Metric
          label="Margin"
          value={`${money(a.margin)}${a.marginPct !== null ? ` (${a.marginPct}%)` : ''}`}
          color={loss ? 'var(--danger)' : 'var(--success)'}
          icon={loss ? <TrendingDown size={12} /> : <TrendingUp size={12} />}
        />
        <span style={{
          fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 'var(--radius-sm)',
          background: 'var(--status-draft-bg)', color: 'var(--text-secondary)', whiteSpace: 'nowrap',
        }}>{a.state}</span>
      </div>
    </div>
  );
};

/** Receivables ageing — collections work is driven off these buckets. */
const AgingBar: React.FC<{ aging: import('../../services/billing').BillingAging }> = ({ aging }) => {
  const buckets = [
    { label: 'Current', value: aging.current, color: 'var(--success)' },
    { label: '1–30d', value: aging.d1_30, color: 'var(--warning)' },
    { label: '31–60d', value: aging.d31_60, color: 'var(--warning)' },
    { label: '61–90d', value: aging.d61_90, color: 'var(--warning)' },
    { label: '90d+', value: aging.d90_plus, color: 'var(--danger)' },
  ];
  const total = buckets.reduce((s, b) => s + b.value, 0);
  return (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 10 }}>
        Receivables Ageing {total === 0 && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>— nothing outstanding</span>}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {buckets.map((b) => (
          <div key={b.label} style={{ minWidth: 92 }}>
            <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', fontWeight: 600 }}>{b.label}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: b.value > 0 ? b.color : 'var(--text-muted)' }}>{money(b.value)}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

const Metric: React.FC<{ label: string; value: string; color?: string; icon?: React.ReactNode }> = ({ label, value, color, icon }) => (
  <div style={{ minWidth: 84 }}>
    <div style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', fontWeight: 600 }}>{label}</div>
    <div style={{ fontSize: 12.5, fontWeight: 600, color: color ?? 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 4 }}>
      {icon}{value}
    </div>
  </div>
);

const Stat: React.FC<{ label: string; value: string; color?: string; hint?: string }> = ({ label, value, color, hint }) => (
  <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '14px 16px', flex: 1, minWidth: 165 }}>
    <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', fontWeight: 600 }}>{label}</div>
    <div style={{ fontSize: 19, fontWeight: 700, color: color ?? 'var(--text-primary)', marginTop: 5, fontFamily: 'var(--font-display)' }}>{value}</div>
    {hint && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>{hint}</div>}
  </div>
);

const Empty: React.FC<{ children: React.ReactNode; tone?: 'error' }> = ({ children, tone }) => (
  <div style={{
    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
    padding: 20, fontSize: 13, color: tone === 'error' ? 'var(--danger)' : 'var(--text-muted)',
  }}>{children}</div>
);
