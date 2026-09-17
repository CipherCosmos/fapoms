import React, { useMemo, useState } from 'react';
import { CheckCircle2, Ban, Receipt, Send, GitBranch, AlertCircle, ChevronRight } from 'lucide-react';
import { AssayerInvoiceStatus, type AssayerInvoiceInvitation, type AssayerPayableStatus } from '@fapoms/shared';
import { DetailDrawer, Pagination, Select, useConfirm, useToast } from '../../components/ui';
import {
  useAssayerInvoices,
  useAssayerInvoice,
  useApproveAssayerInvoice,
  useCancelAssayerInvoice,
  useReviseAssayerInvoice,
  useInviteAllAssayerInvoices,
  useHoldPayout,
} from '../../hooks/useBilling';
import { BILLING_PAGE_SIZE } from '../../services/billing';
import { userMessage } from '../../services/errors';
import { LoadFailure } from '../../components/LoadFailure';
import { loadFailed } from '../../queryClient';
import { moneyTotal as money, moneyExact } from '../../utils/money';
import { Card, Empty, AssayerInvoiceStatusPill, PayoutStatusPill, assayerInvoiceStatusLabel, fmtDate, inputStyle, th, td, tdNum } from './shared';

/**
 * Assayer Invoices — the claim and approval loop, from the desk's side.
 *
 * An invoice here is not priced by anyone: it is the periodic statement of an assayer's unbilled
 * work, snapshotted at invite, that the assayer reviews and confirms in their app/email.
 *
 * Lifecycle:
 *   INVITED → Assayer reviews statement
 *   SUBMITTED → Assayer explicitly confirmed; awaits Ops approval
 *   APPROVED → Ops approves claim; payables move to Disbursement Queue
 *   PAID → All payouts disbursed via Bank UTR transfer
 *   SUPERSEDED → Corrected by newer revision (Rev N+1)
 *   CANCELLED → Voided before approval; lines return to unbilled pool
 */
export type AssayerInvoiceFilter = 'ALL' | AssayerInvoiceStatus;

const FILTERS: AssayerInvoiceFilter[] = [
  'ALL',
  AssayerInvoiceStatus.SUBMITTED,
  AssayerInvoiceStatus.INVITED,
  AssayerInvoiceStatus.APPROVED,
  AssayerInvoiceStatus.PAID,
  AssayerInvoiceStatus.SUPERSEDED,
  AssayerInvoiceStatus.CANCELLED,
];

export const AssayerInvoicesTab: React.FC<{ filter: AssayerInvoiceFilter; onFilter: (f: AssayerInvoiceFilter) => void; canAct: boolean }> = ({ filter, onFilter, canAct }) => {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const invoices = useAssayerInvoices({ status: filter === 'ALL' ? undefined : filter, page, limit: BILLING_PAGE_SIZE });
  const inviteAll = useInviteAllAssayerInvoices();
  const total = invoices.data?.total ?? 0;

  /**
   * SUBMITTED first: a submitted invoice is the one thing on this list waiting on OPS (the
   * assayer has confirmed and can do nothing more), so it outranks the newest invite.
   */
  const rows = useMemo(() => {
    const items = invoices.data?.items ?? [];
    const rank = (s: AssayerInvoiceStatus) => (s === AssayerInvoiceStatus.SUBMITTED ? 0 : 1);
    return [...items].sort((a, b) => rank(a.status) - rank(b.status));
  }, [invoices.data?.items]);

  const changeFilter = (f: AssayerInvoiceFilter) => { onFilter(f); setPage(1); };

  const handleGenerateCycle = async () => {
    const ok = await confirm({
      title: 'Send Monthly Bills to All Assayers?',
      message: (
        <>
          This creates monthly bill statements for <strong>every assayer</strong> with completed audit work and sends them to their mobile app and email for review.
          <br /><br />
          Assayers can review and confirm their earnings before payouts are approved.
        </>
      ),
      confirmLabel: 'Send Bills to Assayers',
      reversible: true,
      reversibleNote: 'Bills can be reviewed, edited, or cancelled before payment.',
      tone: 'normal',
    });
    if (!ok) return;
    try {
      const res = await inviteAll.mutateAsync();
      const parts = [`${res.invited} assayer(s) received monthly bills`];
      if (res.skipped) parts.push(`${res.skipped} skipped (already billed or no new work)`);
      toast({ type: 'success', title: 'Monthly bills sent', message: parts.join(' · ') });
      void invoices.refetch();
    } catch (e) {
      toast({ type: 'error', title: 'Could not send monthly bills', message: userMessage(e) });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Clean Status Filter Toolbar */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {FILTERS.map((f) => {
            const count = f === 'ALL'
              ? total
              : rows.filter((r) => r.status === f).length;
            const isSelected = filter === f;
            const isActionRequired = f === AssayerInvoiceStatus.SUBMITTED && count > 0;
            return (
              <button
                key={f}
                onClick={() => changeFilter(f)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  fontSize: 'var(--text-xs)',
                  fontWeight: isSelected ? 700 : 500,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: isSelected ? 'var(--status-pending-bg)' : 'transparent',
                  color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                  border: `1px solid ${isSelected ? 'var(--accent-primary)' : isActionRequired ? 'var(--warning)' : 'var(--border-color)'}`,
                  transition: 'all 0.15s ease',
                }}
              >
                <span>{f === 'ALL' ? 'All' : assayerInvoiceStatusLabel(f)}</span>
                <span style={{
                  fontSize: '10px',
                  padding: '1px 6px',
                  borderRadius: 10,
                  background: isSelected ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                  color: isSelected ? '#fff' : 'var(--text-muted)',
                  fontWeight: 600,
                }}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{total} bill{total === 1 ? '' : 's'}</span>
          {canAct && (
            <button
              onClick={handleGenerateCycle}
              disabled={inviteAll.isPending}
              className="btn btn-primary"
              style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 'var(--text-xs)', padding: '6px 14px' }}
            >
              <Send size={13} /> {inviteAll.isPending ? 'Sending…' : 'Send Monthly Bills'}
            </button>
          )}
        </div>
      </div>

      {loadFailed(invoices) ? (
        <LoadFailure loads={[{ label: 'assayer invoices', query: invoices }]} />
      ) : invoices.isLoading ? <Empty>Loading assayer bills…</Empty> : rows.length === 0 ? (
        <Empty>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '16px 0' }}>
            <Receipt size={28} style={{ color: 'var(--text-muted)', opacity: 0.6 }} />
            <div style={{ textAlign: 'center', maxWidth: 460 }}>
              {filter === 'ALL'
                ? 'No assayer invoices yet. Invite assayers from Payouts; submitted invoices appear here for approval.'
                : filter === AssayerInvoiceStatus.SUBMITTED
                  ? 'Nothing waiting for approval. Invite assayers from Payouts; submitted invoices appear here for approval.'
                  : 'No bills found under this filter.'}
            </div>
            {canAct && filter === 'ALL' && (
              <button
                onClick={handleGenerateCycle}
                disabled={inviteAll.isPending}
                className="btn btn-secondary"
                style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 'var(--text-xs)', marginTop: 6 }}
              >
                <Send size={13} /> Send Monthly Bills
              </button>
            )}
          </div>
        </Empty>
      ) : (
        <Card title={<span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><Receipt size={14} /> Assayer Bills</span>}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>Bill #</th>
                <th style={th}>Assayer</th>
                <th style={th}>Status</th>
                <th style={th}>Sent</th>
                <th style={th}>Confirmed</th>
                <th style={{ ...th, textAlign: 'right' }}>Audits</th>
                <th style={{ ...th, textAlign: 'right' }}>Amount (₹)</th>
              </tr></thead>
              <tbody>
                {rows.map((inv) => (
                  <tr key={inv.id} onClick={() => setOpenId(inv.id)} style={{ cursor: 'pointer', opacity: (inv.status === AssayerInvoiceStatus.CANCELLED || inv.status === AssayerInvoiceStatus.SUPERSEDED) ? 0.7 : 1 }}>
                    <td style={{ ...td, fontWeight: 600, color: 'var(--text-primary)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>{inv.invoiceNumber}</span>
                        {inv.revision && inv.revision > 1 && (
                          <span style={{ fontSize: 'var(--text-2xs)', padding: '1px 5px', borderRadius: 4, background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                            R{inv.revision}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={td}>
                      {inv.assayerName ?? '—'}
                      {inv.assayerCode && <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{inv.assayerCode}</span>}
                    </td>
                    <td style={td}><AssayerInvoiceStatusPill status={inv.status} /></td>
                    <td style={td}>{fmtDate(inv.invitedAt)}</td>
                    <td style={td}>{fmtDate(inv.submittedAt)}</td>
                    <td style={tdNum}>{inv.lineCount}</td>
                    <td style={{ ...tdNum, fontWeight: 700, color: 'var(--text-primary)' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {money(inv.totalAmount)}
                        <ChevronRight size={13} style={{ color: 'var(--text-muted)' }} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 12 }}>
            <Pagination page={page} totalPages={Math.ceil(total / BILLING_PAGE_SIZE)} total={total} pageSize={BILLING_PAGE_SIZE} onPageChange={setPage} />
          </div>
        </Card>
      )}

      {openId && <AssayerInvoiceDrawer invoiceId={openId} onClose={() => setOpenId(null)} canAct={canAct} />}
      {confirmDialog}
    </div>
  );
};

const CANCEL_ASSAYER_INVOICE_REASONS = [
  'A payout on it needs correcting first',
  'Assayer reported a problem with the figures',
  'Wrong or missing lines — will re-invite',
  'Invited by mistake',
];

const ClaimLifecycleStepper: React.FC<{ invoice: AssayerInvoiceInvitation }> = ({ invoice }) => {
  const isInvited = true;
  const isSubmitted = !!invoice.submittedAt || invoice.status === AssayerInvoiceStatus.SUBMITTED || invoice.status === AssayerInvoiceStatus.APPROVED || invoice.status === AssayerInvoiceStatus.PAID;
  const isApproved = !!invoice.approvedAt || invoice.status === AssayerInvoiceStatus.APPROVED || invoice.status === AssayerInvoiceStatus.PAID;
  const isPaid = invoice.status === AssayerInvoiceStatus.PAID;
  const isCancelled = invoice.status === AssayerInvoiceStatus.CANCELLED;
  const isSuperseded = invoice.status === AssayerInvoiceStatus.SUPERSEDED;

  if (isCancelled || isSuperseded) {
    return (
      <div style={{ padding: '10px 14px', borderRadius: 'var(--radius-sm)', background: isSuperseded ? 'var(--status-pending-bg)' : 'var(--bg-tertiary)', border: `1px solid ${isSuperseded ? 'var(--warning)' : 'var(--border-color)'}`, display: 'flex', alignItems: 'center', gap: 10 }}>
        <AlertCircle size={16} style={{ color: isSuperseded ? 'var(--warning)' : 'var(--text-muted)' }} />
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
          {isSuperseded ? (
            <>This claim statement was <strong>SUPERSEDED</strong> by a newer revision. All unheld lines have moved forward to the active revision.</>
          ) : (
            <>This claim statement was <strong>CANCELLED</strong>: <em>{invoice.cancelReason || 'Lines released back to unbilled pool.'}</em></>
          )}
        </div>
      </div>
    );
  }

  const steps = [
    { label: 'Bill Sent', date: invoice.invitedAt, done: isInvited, active: invoice.status === AssayerInvoiceStatus.INVITED },
    { label: 'Assayer Agreed', date: invoice.submittedAt, done: isSubmitted, active: invoice.status === AssayerInvoiceStatus.SUBMITTED, badge: invoice.confirmedVersion ? `v${invoice.confirmedVersion}` : undefined },
    { label: 'Office Approved', date: invoice.approvedAt, done: isApproved, active: invoice.status === AssayerInvoiceStatus.APPROVED },
    { label: 'Bank Paid', date: invoice.paidAt, done: isPaid, active: isPaid },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, padding: '10px 12px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)' }}>
      {steps.map((s, idx) => (
        <div key={s.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{
              width: 18, height: 18, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 700,
              background: s.done ? (s.active ? 'var(--accent-primary)' : 'var(--status-active-bg)') : 'var(--bg-secondary)',
              color: s.done ? (s.active ? '#fff' : 'var(--success)') : 'var(--text-muted)',
              border: `1px solid ${s.done ? (s.active ? 'var(--accent-primary)' : 'var(--success)') : 'var(--border-color)'}`,
            }}>
              {s.done && !s.active ? '✓' : idx + 1}
            </div>
            <span style={{ fontSize: 'var(--text-2xs)', fontWeight: s.active ? 700 : 600, color: s.active ? 'var(--text-primary)' : s.done ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
              {s.label}
            </span>
          </div>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', paddingLeft: 24 }}>
            {fmtDate(s.date)}
            {s.badge && <span style={{ marginLeft: 4, background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3, fontSize: '9px' }}>{s.badge}</span>}
          </div>
        </div>
      ))}
    </div>
  );
};

export const AssayerInvoiceDrawer: React.FC<{ invoiceId: string; onClose: () => void; canAct: boolean }> = ({ invoiceId, onClose, canAct }) => {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const { data: invoice, refetch } = useAssayerInvoice(invoiceId);
  const approve = useApproveAssayerInvoice();
  const cancel = useCancelAssayerInvoice();
  const revise = useReviseAssayerInvoice();
  const hold = useHoldPayout();

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelPreset, setCancelPreset] = useState('');
  const [cancelReason, setCancelReason] = useState('');

  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseReason, setReviseReason] = useState('');

  const isCancelOther = cancelPreset === '__other__';
  const effectiveCancelReason = isCancelOther ? cancelReason.trim() : cancelPreset;

  if (!invoice) return <DetailDrawer open onClose={onClose} title="Loading…" width={760}><div /></DetailDrawer>;

  const heldLines = invoice.lines.filter((l) => l.onHold);

  const doApprove = async () => {
    const amountText = money(invoice.totalAmount);
    const amountPhrase = String(Math.round(Number(invoice.totalAmount)));
    const ok = await confirm({
      title: `Approve ${invoice.invoiceNumber}?`,
      message: (
        <>
          This accepts what {invoice.assayerName ?? 'the assayer'} confirmed: <strong>{invoice.lineCount} line{invoice.lineCount === 1 ? '' : 's'}</strong> totalling{' '}
          <strong>{amountText}</strong>. Every pending payout on it is approved in the same step, and these
          amounts then appear as the assayer&rsquo;s earnings.
        </>
      ),
      confirmLabel: `Approve ${amountText}`,
      reversible: false,
      reversibleNote: 'Approving cannot be undone here. To stop a payout afterwards, put it on hold before disbursement.',
      tone: 'danger',
      confirmPhrase: amountPhrase,
    });
    if (!ok) return;
    try {
      await approve.mutateAsync(invoice.id);
      toast('success', `${invoice.invoiceNumber} approved — ready for disbursement in Payouts tab`);
      void refetch();
    } catch (e) {
      toast({ type: 'error', title: 'Could not approve', message: userMessage(e) });
    }
  };

  const doCancel = async () => {
    if (!effectiveCancelReason) return;
    try {
      await cancel.mutateAsync({ id: invoice.id, reason: effectiveCancelReason });
      toast('success', `${invoice.invoiceNumber} cancelled — lines returned to unbilled pool`);
      setCancelOpen(false);
      onClose();
    } catch (e) {
      toast({ type: 'error', title: 'Could not cancel', message: userMessage(e) });
    }
  };

  const doRevise = async () => {
    if (!reviseReason.trim()) return;
    try {
      const res = await revise.mutateAsync({ id: invoice.id, reason: reviseReason.trim() });
      toast('success', `Created Revision ${res.revision}: ${res.invoiceNumber}`);
      setReviseOpen(false);
      setReviseReason('');
      void refetch();
    } catch (e) {
      toast({ type: 'error', title: 'Could not create revision', message: userMessage(e) });
    }
  };

  const handleToggleHold = async (payableId: string, willHold: boolean) => {
    try {
      await hold.mutateAsync({
        id: payableId,
        onHold: willHold,
        reason: willHold ? 'Disputed during claim review' : undefined,
      });
      toast('success', willHold ? 'Line put on hold' : 'Hold released');
      void refetch();
    } catch (e) {
      toast({ type: 'error', title: 'Could not update hold state', message: userMessage(e) });
    }
  };

  const canApprove = canAct && invoice.status === AssayerInvoiceStatus.SUBMITTED;
  const canCancel = canAct && (invoice.status === AssayerInvoiceStatus.INVITED || invoice.status === AssayerInvoiceStatus.SUBMITTED);
  const canRevise = canAct && (invoice.status === AssayerInvoiceStatus.INVITED || invoice.status === AssayerInvoiceStatus.SUBMITTED);

  return (
    <DetailDrawer
      open onClose={onClose} width={760}
      title={
        <span>
          <strong style={{ fontSize: 'var(--text-md)' }}>{invoice.invoiceNumber}</strong>
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', marginLeft: 6 }}>
            {[invoice.assayerName, invoice.assayerCode].filter(Boolean).join(' · ')}
          </span>
        </span>
      }
      subtitle={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
          <AssayerInvoiceStatusPill status={invoice.status} />
          <span style={{
            fontSize: 'var(--text-2xs)', fontWeight: 600, padding: '2px 8px', borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)',
          }}>
            Revision {invoice.revision ?? 1}
          </span>
          {invoice.supersedesInvoiceId && (
            <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--accent-primary)', fontWeight: 600 }}>
              (Supersedes earlier claim)
            </span>
          )}
          {invoice.status === AssayerInvoiceStatus.SUPERSEDED && (
            <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--warning)', fontWeight: 600 }}>
              (Superseded by newer revision)
            </span>
          )}
          {invoice.status === AssayerInvoiceStatus.PAID && (
            <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--success)', fontWeight: 600 }}>
              ✓ Fully Disbursed
            </span>
          )}
        </div>
      }
      footer={(canApprove || canCancel || canRevise) ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, width: '100%', justifyContent: 'flex-end' }}>
          {canCancel && (
            <button onClick={() => setCancelOpen((o) => !o)} className="btn btn-secondary" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Ban size={14} /> Cancel invoice
            </button>
          )}
          {canRevise && (
            <button onClick={() => setReviseOpen((o) => !o)} className="btn btn-secondary" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <GitBranch size={14} /> Issue Corrected Revision
            </button>
          )}
          {canApprove && (
            <button onClick={doApprove} disabled={approve.isPending} className="btn btn-primary" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <CheckCircle2 size={14} /> Approve ({invoice.lineCount} · {money(invoice.totalAmount)})
            </button>
          )}
        </div>
      ) : undefined}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ClaimLifecycleStepper invoice={invoice} />

        {/* 4 Financial Stat Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
          <div style={{ padding: '10px 12px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600 }}>Audit Fees</div>
            <div style={{ fontSize: 'var(--text-md)', fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>{moneyExact(invoice.subtotalBase)}</div>
          </div>
          <div style={{ padding: '10px 12px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600 }}>Travel & Expenses</div>
            <div style={{ fontSize: 'var(--text-md)', fontWeight: 700, color: 'var(--text-primary)', marginTop: 2 }}>{moneyExact(invoice.subtotalTravel)}</div>
          </div>
          <div style={{ padding: '10px 12px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600 }}>TDS Deduction</div>
            <div style={{ fontSize: 'var(--text-md)', fontWeight: 700, color: 'var(--danger)', marginTop: 2 }}>−{moneyExact(invoice.tdsAmount)}</div>
          </div>
          <div style={{ padding: '10px 12px', background: 'var(--status-pending-bg)', border: '1px solid var(--accent-primary)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--accent-primary)', fontWeight: 700 }}>Amount to Pay</div>
            <div style={{ fontSize: 'var(--text-md)', fontWeight: 800, color: 'var(--text-primary)', marginTop: 2 }}>{moneyExact(invoice.totalAmount)}</div>
          </div>
        </div>

        {invoice.status === AssayerInvoiceStatus.INVITED && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', background: 'var(--bg-tertiary)', padding: '8px 12px', borderRadius: 'var(--radius-sm)' }}>
            Waiting on the assayer — statement has been dispatched to their mobile app and email. Approval opens once they review and confirm.
          </div>
        )}
        {invoice.status === AssayerInvoiceStatus.SUBMITTED && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--accent-primary)', fontWeight: 500, background: 'var(--status-pending-bg)', padding: '8px 12px', borderRadius: 'var(--radius-sm)' }}>
            ✓ Assayer confirmed this statement (Revision {invoice.revision ?? 1}). Ready for Ops review and disbursement approval.
          </div>
        )}
        {invoice.status === AssayerInvoiceStatus.CANCELLED && invoice.cancelReason && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>Cancelled: <em>{invoice.cancelReason}</em></div>
        )}
        {heldLines.length > 0 && invoice.status !== AssayerInvoiceStatus.CANCELLED && invoice.status !== AssayerInvoiceStatus.SUPERSEDED && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--warning)', background: 'var(--status-pending-bg)', padding: '8px 12px', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertCircle size={14} />
            <span>{heldLines.map((l) => l.payableNumber).join(', ')} on hold — resolve dispute by releasing the hold or issuing a corrected revision to exclude held lines.</span>
          </div>
        )}
      </div>

      {reviseOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--bg-tertiary)', padding: 12, borderRadius: 'var(--radius-sm)', border: '1px solid var(--accent-primary)' }}>
          <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)' }}>
            Issue Corrected Revision (Revision {(invoice.revision ?? 1) + 1})
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
            This will mark current claim {invoice.invoiceNumber} as <strong>SUPERSEDED</strong>. A new revision with active, unheld lines will be generated and sent to {invoice.assayerName ?? 'the assayer'} for fresh confirmation before approval.
          </div>
          <textarea
            value={reviseReason}
            onChange={(e) => setReviseReason(e.target.value)}
            rows={2}
            placeholder="Reason for revision (e.g. Disputed travel expense removed, rate adjustment, redo audit) *"
            style={{ ...inputStyle, width: '100%', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setReviseOpen(false); setReviseReason(''); }} className="btn btn-secondary">Keep Original</button>
            <button onClick={doRevise} disabled={revise.isPending || !reviseReason.trim()} className="btn btn-primary">
              Generate Revision {(invoice.revision ?? 1) + 1}
            </button>
          </div>
        </div>
      )}

      {cancelOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--bg-tertiary)', padding: 12, borderRadius: 'var(--radius-sm)' }}>
          <div style={{ fontSize: 'var(--text-xs)' }}>
            Cancelling releases every line back to the unbilled pool, so the work can be invited again once fixed. Say why:
          </div>
          <Select
            value={cancelPreset}
            onChange={setCancelPreset}
            options={[
              { value: '', label: 'Reason *' },
              ...CANCEL_ASSAYER_INVOICE_REASONS.map((r) => ({ value: r, label: r })),
              { value: '__other__', label: 'Other…' },
            ]}
            style={{ width: '100%' }}
          />
          {isCancelOther && (
            <textarea value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={2} placeholder="Reason *" style={{ ...inputStyle, width: '100%', resize: 'vertical' }} />
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setCancelOpen(false); setCancelPreset(''); setCancelReason(''); }} className="btn btn-secondary">Keep</button>
            <button onClick={doCancel} disabled={cancel.isPending || !effectiveCancelReason} className="btn btn-primary">Cancel invoice</button>
          </div>
        </div>
      )}

      <div>
        <h4 style={{ fontSize: 'var(--text-sm)', fontWeight: 700, margin: '0 0 6px', color: 'var(--text-primary)' }}>Included Audits & Expenses ({invoice.lines.length})</h4>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Audit / Payout</th>
              <th style={th}>Bank / Client</th>
              <th style={th}>Branch</th>
              <th style={th}>Completed</th>
              <th style={th}>Status</th>
              <th style={{ ...th, textAlign: 'right' }}>Base</th>
              <th style={{ ...th, textAlign: 'right' }}>Travel</th>
              <th style={{ ...th, textAlign: 'right' }}>TDS</th>
              <th style={{ ...th, textAlign: 'right' }}>Net</th>
              {canAct && invoice.status !== AssayerInvoiceStatus.APPROVED && invoice.status !== AssayerInvoiceStatus.PAID && <th style={th}>Hold</th>}
            </tr></thead>
            <tbody>
              {invoice.lines.map((l) => (
                <tr key={l.payableId}>
                  <td style={td}>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      {l.kind === 'EXPENSE' && <Receipt size={12} style={{ color: 'var(--text-muted)' }} />}{l.assignmentNumber ?? l.payableNumber}
                    </div>
                    <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                      {l.kind === 'EXPENSE' ? `Expense reimbursement${l.expenseCategory ? ` · ${l.expenseCategory}` : ''}` : 'Audit fee'}
                    </div>
                  </td>
                  <td style={td}>{l.clientName ?? '—'}</td>
                  <td style={td}>{l.branchName ?? '—'}</td>
                  <td style={td}>{fmtDate(l.serviceDate)}</td>
                  <td style={td}><PayoutStatusPill status={l.payableStatus as AssayerPayableStatus} onHold={l.onHold} /></td>
                  <td style={tdNum}>{moneyExact(l.baseAmount)}</td>
                  <td style={tdNum}>{Number(l.travelAmount) ? moneyExact(l.travelAmount) : '—'}</td>
                  <td style={tdNum}>{Number(l.tdsAmount) ? `−${moneyExact(l.tdsAmount)}` : '—'}</td>
                  <td style={{ ...tdNum, fontWeight: 700, color: 'var(--text-primary)' }}>{moneyExact(l.totalAmount)}</td>
                  {canAct && invoice.status !== AssayerInvoiceStatus.APPROVED && invoice.status !== AssayerInvoiceStatus.PAID && (
                    <td style={td}>
                      <button
                        onClick={() => handleToggleHold(l.payableId, !l.onHold)}
                        disabled={hold.isPending}
                        className="btn btn-secondary"
                        style={{ fontSize: 'var(--text-2xs)', padding: '2px 6px' }}
                        title={l.onHold ? 'Release hold' : 'Put on hold'}
                      >
                        {l.onHold ? 'Release' : 'Hold'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {invoice.notes && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{invoice.notes}</div>}

      {confirmDialog}
    </DetailDrawer>
  );
};
