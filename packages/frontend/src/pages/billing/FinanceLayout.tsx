import React from 'react';
import { NavLink, Outlet, useOutletContext, useSearchParams } from 'react-router-dom';
import { LayoutDashboard, FileText, Receipt, Banknote, AlertTriangle, BookOpen, BarChart3 } from 'lucide-react';
import { useBillingClients } from '../../hooks/useBilling';

/**
 * The shell every finance page sits in.
 *
 * Finance used to be one page carrying eight tabs, so receivables, payables, disputes and the
 * ledger all competed for one screen. Each is now its own page with its own URL.
 *
 * The client scope lives in the URL (?client=…), not in component state, for a reason specific
 * to this domain: almost every finance question is asked about one client ("what does this bank
 * owe us?"), and an operator moving from the invoice list to that client's payments expects the
 * scope to hold. A query param carries it across pages and into a bookmark; component state
 * would reset on every navigation.
 */

export interface FinanceContext {
  clientId: string;
  setClientId: (id: string) => void;
}

export function useFinance(): FinanceContext {
  return useOutletContext<FinanceContext>();
}

const PAGES = [
  { to: '/billing', end: true, label: 'Overview', icon: LayoutDashboard },
  { to: '/billing/receivables', label: 'Receivables', icon: FileText },
  { to: '/billing/invoices', label: 'Invoices', icon: Receipt },
  { to: '/billing/payables', label: 'Payables', icon: Banknote },
  { to: '/billing/conflicts', label: 'Disputes', icon: AlertTriangle },
  { to: '/billing/ledger', label: 'Ledger', icon: BookOpen },
  { to: '/billing/reports', label: 'Reports', icon: BarChart3 },
] as const;

export const FinanceLayout: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const clientId = params.get('client') ?? '';
  const clients = useBillingClients();

  const setClientId = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set('client', id);
    else next.delete('client');
    setParams(next, { replace: true });
  };

  // Preserve the client scope when moving between finance pages.
  const withScope = (to: string) => (clientId ? `${to}?client=${clientId}` : to);

  return (
    <div style={{ padding: '20px 24px', maxWidth: '1500px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, margin: 0 }}>Finance</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginTop: '4px' }}>
            Receivables, payables and the ledger behind them.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>Client:</label>
          <select
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            style={{ padding: '7px 11px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 13, minWidth: 240 }}
          >
            <option value="">All clients</option>
            {clients.data?.map((c) => (
              <option key={c.clientId} value={c.clientId}>
                {c.clientName}{Number(c.entryCount) > 0 ? ` (${c.entryCount} lines)` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      <nav style={{ display: 'flex', gap: '4px', margin: '18px 0', flexWrap: 'wrap', borderBottom: '1px solid var(--border-color)' }}>
        {PAGES.map((p) => {
          const Icon = p.icon;
          return (
            <NavLink
              key={p.to}
              to={withScope(p.to)}
              end={'end' in p ? p.end : false}
              style={({ isActive }) => ({
                display: 'flex', alignItems: 'center', gap: '6px',
                padding: '9px 14px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', textDecoration: 'none',
                borderBottom: `2px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
                color: isActive ? 'var(--accent)' : 'var(--text-muted)',
              })}
            >
              <Icon size={14} /> {p.label}
            </NavLink>
          );
        })}
      </nav>

      <Outlet context={{ clientId, setClientId } satisfies FinanceContext} />
    </div>
  );
};
