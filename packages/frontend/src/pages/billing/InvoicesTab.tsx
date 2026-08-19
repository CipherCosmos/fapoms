import React, { useState } from 'react';
import { FileText, Plus } from 'lucide-react';
import { InvoiceStatus, invoiceStatusLabel } from '@fapoms/shared';
import { Pagination } from '../../components/ui';
import { useInvoiceable, useBillingInvoices } from '../../hooks/useBilling';
import { BILLING_PAGE_SIZE } from '../../services/billing';
import type { InvoiceableClient } from '../../services/billing';
import { moneyTotal as money } from '../../utils/money';
import { Card, Empty, InvoiceStatusPill, HoldPill, fmtDate, th, td, tdNum } from './shared';
import { CreateInvoiceModal } from './CreateInvoiceModal';
import { InvoiceDetailDrawer } from './InvoiceDetailDrawer';

/**
 * Invoices — left: completed work not yet invoiced, by client, with a Create button per client;
 * right: the invoice list. An invoice is a set of completed assignments for one client:
 * Draft → Sent → Paid.
 */
export type InvoiceFilter = 'ALL' | InvoiceStatus;

export const InvoicesTab: React.FC<{ filter: InvoiceFilter; onFilter: (f: InvoiceFilter) => void; canAct: boolean }> = ({ filter, onFilter, canAct }) => {
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState<InvoiceableClient | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const invoiceable = useInvoiceable();
  const invoices = useBillingInvoices({ status: filter === 'ALL' ? undefined : filter, page, limit: BILLING_PAGE_SIZE });
  const rows = invoices.data?.items ?? [];
  const total = invoices.data?.total ?? 0;
  const clients = invoiceable.data?.clients ?? [];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) minmax(0, 2fr)', gap: 14, alignItems: 'start' }}>
      <Card title={<span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><FileText size={14} /> Ready to invoice</span>}>
        {invoiceable.isLoading ? <Empty>Loading…</Empty> : clients.length === 0 ? (
          <Empty>Nothing to invoice. Completed assignments appear here automatically.</Empty>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {clients.map((c) => {
              const held = c.lines.filter((l) => l.onHold);
              return (
                <div key={c.clientId} style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '10px 12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 13 }}>{c.clientName}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                        {c.count} assignment{c.count === 1 ? '' : 's'} · {money(c.total)}
                        {held.length > 0 && <> · <HoldPill reason={held.map((l) => l.holdReason).filter(Boolean).join('; ')} /> {held.length}</>}
                      </div>
                    </div>
                    {canAct && (
                      <button className="btn btn-primary" disabled={c.count === 0} onClick={() => setCreating(c)} style={{ display: 'inline-flex', gap: 5, alignItems: 'center', padding: '6px 10px', fontSize: 12 }}>
                        <Plus size={13} /> Invoice
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card
        title="Invoices"
        actions={
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(['ALL', InvoiceStatus.DRAFT, InvoiceStatus.ISSUED, InvoiceStatus.PAID, InvoiceStatus.CANCELLED] as InvoiceFilter[]).map((f) => (
              <button key={f} onClick={() => { onFilter(f); setPage(1); }} style={{
                padding: '4px 10px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                background: filter === f ? 'var(--status-pending-bg)' : 'transparent', color: filter === f ? 'var(--text-primary)' : 'var(--text-secondary)',
                border: `1px solid ${filter === f ? 'var(--accent-primary)' : 'var(--border-color)'}`,
              }}>{f === 'ALL' ? 'All' : invoiceStatusLabel(f)}</button>
            ))}
          </div>
        }
      >
        {invoices.isLoading ? <Empty>Loading invoices…</Empty> : rows.length === 0 ? <Empty>No invoices yet.</Empty> : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={th}>Invoice</th><th style={th}>Client</th><th style={th}>Status</th><th style={th}>Issued</th><th style={th}>Due</th>
                  <th style={{ ...th, textAlign: 'right' }}>Lines</th><th style={{ ...th, textAlign: 'right' }}>Total</th><th style={{ ...th, textAlign: 'right' }}>Outstanding</th>
                </tr></thead>
                <tbody>
                  {rows.map((inv) => {
                    const overdue = inv.status === InvoiceStatus.ISSUED && inv.dueDate && new Date(inv.dueDate) < new Date() && Number(inv.outstandingAmount) > 0;
                    return (
                      <tr key={inv.id} onClick={() => setOpenId(inv.id)} style={{ cursor: 'pointer' }}>
                        <td style={{ ...td, fontWeight: 600, color: 'var(--text-primary)' }}>{inv.invoiceNumber}</td>
                        <td style={td}>{inv.clientName ?? '—'}</td>
                        <td style={td}><InvoiceStatusPill status={inv.status} partPaid={Number(inv.paidAmount) > 0 && Number(inv.outstandingAmount) > 0} /></td>
                        <td style={td}>{fmtDate(inv.issueDate)}</td>
                        <td style={{ ...td, color: overdue ? 'var(--danger)' : undefined, fontWeight: overdue ? 700 : undefined }}>{fmtDate(inv.dueDate)}</td>
                        <td style={tdNum}>{inv.entryCount}</td>
                        <td style={tdNum}>{money(inv.total)}</td>
                        <td style={{ ...tdNum, fontWeight: 700, color: Number(inv.outstandingAmount) > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>{money(inv.outstandingAmount)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 12 }}>
              <Pagination page={page} totalPages={Math.ceil(total / BILLING_PAGE_SIZE)} total={total} pageSize={BILLING_PAGE_SIZE} onPageChange={setPage} />
            </div>
          </>
        )}
      </Card>

      {creating && <CreateInvoiceModal client={creating} onClose={() => setCreating(null)} onCreated={(id) => { setCreating(null); setOpenId(id); }} />}
      {openId && <InvoiceDetailDrawer invoiceId={openId} onClose={() => setOpenId(null)} canAct={canAct} />}
    </div>
  );
};
