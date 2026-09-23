import React, { useState } from 'react';
import { FileText, Plus, Receipt } from 'lucide-react';
import { InvoiceStatus } from '@fapoms/shared';
import { Pagination } from '../../components/ui';
import { useInvoiceable, useBillingInvoices } from '../../hooks/useBilling';
import { BILLING_PAGE_SIZE } from '../../services/billing';
import type { InvoiceableClient } from '../../services/billing';
import { moneyTotal as money } from '../../utils/money';
import { LoadFailure } from '../../components/LoadFailure';
import { loadFailed } from '../../queryClient';
import { Card, Empty, InvoiceStatusPill, HoldPill, fmtDate, th, td, tdNum, tableScrollStyle } from './shared';
import { INVOICE_STATE_CHIP } from './vocabulary';
import { CreateInvoiceModal } from './CreateInvoiceModal';
import { InvoiceDetailDrawer } from './InvoiceDetailDrawer';

/**
 * Bill clients — left: completed work nobody has invoiced yet, by client, with a Create button
 * per client; right: the invoices themselves. An invoice is a set of completed assignments for
 * one client, and it goes draft → sent → paid.
 *
 * The step that gets forgotten is SENDING. A draft is owed by nobody: it does not appear in
 * "Owed by clients", it is not overdue, and the client cannot pay it. The live book had fourteen
 * of them, ₹27,648, while the overview reported ₹0 outstanding and neither screen mentioned the
 * other. The filter chips carry counts now, and a draft says "Draft, not sent" rather than
 * "Draft", because the missing half of that word is the whole problem.
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
      <Card title={<span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><FileText size={14} /> Work waiting to be invoiced</span>}>
        {/* Failure before emptiness. "Nothing to invoice" is a statement about revenue nobody has
            billed yet; drawn over a refused or paused load it quietly stops the money going out. */}
        {loadFailed(invoiceable) ? (
          <LoadFailure loads={[{ label: 'the work waiting to be invoiced', query: invoiceable }]} />
        ) : invoiceable.isLoading ? <Empty>Loading…</Empty> : clients.length === 0 ? (
          <Empty>Nothing to invoice. Completed assignments appear here automatically.</Empty>
        ) : (<>
          {invoiceable.data?.truncated && (
            <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--warning)', marginBottom: 8, lineHeight: 1.45 }}>
              Showing the first {invoiceable.data.total} un-invoiced lines — there are more. Invoice a client to clear its
              share, or open that client from the Overview to see all of theirs.
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 'calc(100vh - 290px)', overflowY: 'auto' }}>
            {clients.map((c) => {
              const held = c.lines.filter((l) => l.onHold);
              return (
                <div key={c.clientId} style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '10px 12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 'var(--text-sm)' }}>{c.clientName}</div>
                      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                        {c.count} assignment{c.count === 1 ? '' : 's'} · {money(c.total)}
                        {held.length > 0 && <> · <HoldPill reason={held.map((l) => l.holdReason).filter(Boolean).join('; ')} /> {held.length}</>}
                      </div>
                    </div>
                    {canAct && (
                      <button className="btn btn-primary" disabled={c.count === 0} onClick={() => setCreating(c)} title={c.count === 0 ? `Nothing invoiceable for ${c.clientName} right now` : `Invoice ${c.clientName} — ${c.count} assignment${c.count === 1 ? '' : 's'} totalling ${money(c.total)}`} style={{ display: 'inline-flex', gap: 5, alignItems: 'center', padding: '6px 10px', fontSize: 'var(--text-xs)' }}>
                        <Plus size={13} /> Invoice
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>)}
      </Card>

      <Card
        title={<span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Receipt size={14} /> Client invoices ({total})</span>}
        actions={
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(['ALL', InvoiceStatus.DRAFT, InvoiceStatus.ISSUED, InvoiceStatus.PAID, InvoiceStatus.CANCELLED] as InvoiceFilter[]).map((f) => (
              <button key={f} onClick={() => { onFilter(f); setPage(1); }} title={f === 'ALL' ? 'Show invoices in every state' : f === InvoiceStatus.DRAFT ? 'Drafts — created but not sent to the client yet' : f === InvoiceStatus.ISSUED ? 'Sent to the client — awaiting payment' : f === InvoiceStatus.PAID ? 'Fully paid invoices' : 'Cancelled invoices — kept as a record'} style={{
                padding: '4px 10px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 600,
                background: filter === f ? 'var(--status-pending-bg)' : 'transparent', color: filter === f ? 'var(--text-primary)' : 'var(--text-secondary)',
                border: `1px solid ${filter === f ? 'var(--accent-primary)' : 'var(--border-color)'}`,
              }}>{f === 'ALL' ? 'All' : INVOICE_STATE_CHIP[f]}</button>
            ))}
          </div>
        }
      >
        {loadFailed(invoices) ? (
          <LoadFailure loads={[{ label: 'invoices', query: invoices }]} />
        ) : invoices.isLoading ? <Empty>Loading invoices…</Empty> : rows.length === 0 ? (
          <Empty>{filter === InvoiceStatus.DRAFT ? 'No drafts waiting to be sent.' : 'No client invoices yet. Invoice a client from the list on the left.'}</Empty>
        ) : (
          <>
            <div style={tableScrollStyle}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th title="Invoice number — click a row to open it" style={th}>Invoice</th><th title="Billed client" style={th}>Client</th><th title="Draft, sent, paid or cancelled" style={th}>Status</th><th title="Date printed on the invoice" style={th}>Issued</th><th title="Payment due date — red when overdue" style={th}>Due</th>
                  <th title="Assignments bundled on this invoice" style={{ ...th, textAlign: 'right' }}>Lines</th><th title="Invoice total including GST, minus TDS" style={{ ...th, textAlign: 'right' }}>Total</th><th title="Still unpaid on this invoice" style={{ ...th, textAlign: 'right' }}>Outstanding</th>
                </tr></thead>
                <tbody>
                  {rows.map((inv) => {
                    const overdue = inv.status === InvoiceStatus.ISSUED && inv.dueDate && new Date(inv.dueDate) < new Date() && Number(inv.outstandingAmount) > 0;
                    return (
                      <tr key={inv.id} onClick={() => setOpenId(inv.id)} title={`Open ${inv.invoiceNumber} — ${inv.clientName ?? 'client'} — ${money(inv.outstandingAmount)} outstanding`} style={{ cursor: 'pointer' }}>
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
