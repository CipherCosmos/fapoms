import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, X, Receipt, RefreshCw, MapPin, AlertTriangle } from 'lucide-react';
import { formatRupees } from '@fapoms/shared';
import { DataTable, Column, Modal, useToast } from '../components/ui';
import {
  getPendingExpenses,
  reviewExpense,
  EXPENSE_CATEGORY_LABELS,
  ExpenseClaim,
  getUnpaidApprovals,
  retryUnpaidApprovals,
} from '../services/expenses';
import { TravelEvidence } from '../components/TravelEvidence';

/**
 * Expense Review — the finance/ops queue for assayer reimbursement claims.
 *
 * Assayers raise claims from the mobile app; this is where they get approved or rejected. A
 * rejection requires a reason (the backend enforces it too), so the assayer always knows why.
 */
// Always rendered inside <Billing/>'s Expenses tab, never routed standalone — the
// `embedded=false` branch this used to carry (its own page title) was unreachable and has
// been removed.
export const ExpenseReview: React.FC = () => {
  const { toast } = useToast();
  const [claims, setClaims] = useState<ExpenseClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<ExpenseClaim | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  // A travel claim whose movement trail the reviewer has opened.
  const [inspecting, setInspecting] = useState<ExpenseClaim | null>(null);
  /**
   * Approved claims whose reimbursement payable never got raised.
   *
   * Normally empty. When it is not, an assayer has been told their claim was approved and
   * nothing anywhere owes them the money — the one failure in this flow that is invisible from
   * both ends unless it is put on the reviewer's screen.
   */
  const [unpaid, setUnpaid] = useState<ExpenseClaim[]>([]);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pending, stuck] = await Promise.all([
        getPendingExpenses(),
        // A failure here must not hide the queue the reviewer came for.
        getUnpaidApprovals().catch(() => [] as ExpenseClaim[]),
      ]);
      setClaims(pending);
      setUnpaid(stuck);
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not load claims', message: err?.message ?? 'Please try again.' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPending = useMemo(
    () => claims.reduce((sum, c) => sum + Number(c.amount || 0), 0),
    [claims],
  );

  const approve = async (claim: ExpenseClaim) => {
    setBusyId(claim.id);
    try {
      await reviewExpense(claim.id, true);
      setClaims((prev) => prev.filter((c) => c.id !== claim.id));
      toast({ type: 'success', title: 'Claim approved', message: `${formatRupees(Number(claim.amount))} approved for reimbursement.` });
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not approve', message: err?.message ?? 'Please try again.' });
    } finally {
      setBusyId(null);
    }
  };

  const confirmReject = async () => {
    if (!rejecting || !rejectReason.trim()) return;
    const claim = rejecting;
    setBusyId(claim.id);
    try {
      await reviewExpense(claim.id, false, rejectReason.trim());
      setClaims((prev) => prev.filter((c) => c.id !== claim.id));
      toast({ type: 'success', title: 'Claim rejected', message: 'The assayer will see the reason you gave.' });
      setRejecting(null);
      setRejectReason('');
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not reject', message: err?.message ?? 'Please try again.' });
    } finally {
      setBusyId(null);
    }
  };

  const columns: Column<ExpenseClaim>[] = [
    {
      key: 'assayer',
      header: 'Assayer',
      render: (c) => (
        <div>
          <div style={{ fontWeight: 600 }}>{c.assayer?.displayName ?? '—'}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.assayer?.assayerCode ?? ''}</div>
        </div>
      ),
    },
    {
      key: 'assignment',
      header: 'Assignment',
      render: (c) => c.assignment?.assignmentNumber ?? '—',
    },
    {
      key: 'category',
      header: 'Category',
      render: (c) => EXPENSE_CATEGORY_LABELS[c.category] ?? c.category,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      sortValue: (c) => Number(c.amount || 0),
      render: (c) => <span style={{ fontWeight: 600 }}>{formatRupees(Number(c.amount || 0))}</span>,
    },
    {
      key: 'description',
      header: 'Description',
      render: (c) => (
        <span style={{ color: c.description ? 'inherit' : 'var(--text-muted)' }}>
          {c.description || 'No description'}
        </span>
      ),
    },
    {
      key: 'receipt',
      header: 'Receipt',
      render: (c) =>
        c.receiptUrl ? (
          <a href={c.receiptUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--accent)' }}>
            <Receipt size={14} /> View
          </a>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>—</span>
        ),
    },
    {
      key: 'submitted',
      header: 'Submitted',
      sortValue: (c) => c.createdAt,
      render: (c) => new Date(c.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (c) => (
        <div style={{ display: 'inline-flex', gap: 8 }}>
          {/* Only travel claims have a journey a trail can speak to; showing this on a food
              receipt would imply the platform can verify something it cannot. */}
          {c.category === 'TRAVEL_KM' && c.assignmentId && (
            <button
              type="button"
              onClick={() => setInspecting(c)}
              title="Check the recorded movement trail"
              style={btnStyle('var(--accent, #2563eb)')}
            >
              <MapPin size={15} /> Trail
            </button>
          )}
          <button
            type="button"
            onClick={() => approve(c)}
            disabled={busyId === c.id}
            title="Approve"
            style={btnStyle('var(--success, #16a34a)')}
          >
            <Check size={15} /> Approve
          </button>
          <button
            type="button"
            onClick={() => { setRejecting(c); setRejectReason(''); }}
            disabled={busyId === c.id}
            title="Reject"
            style={btnStyle('var(--danger, #dc2626)')}
          >
            <X size={15} /> Reject
          </button>
        </div>
      ),
    },
  ];

  return (
    <div style={{ padding: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div />
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{claims.length} pending</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{formatRupees(totalPending)}</div>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading} title="Refresh" style={btnStyle('var(--text-muted)')}>
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
      </div>

      {unpaid.length > 0 && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            padding: '12px 14px', marginBottom: 14,
            background: 'var(--status-warning-bg, rgba(217,119,6,0.08))',
            border: '1px solid var(--warning, #d97706)',
            borderRadius: 'var(--radius-sm, 6px)',
          }}
        >
          <AlertTriangle size={18} style={{ color: 'var(--warning, #d97706)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>
              {unpaid.length} approved {unpaid.length === 1 ? 'claim has' : 'claims have'} no reimbursement raised
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {formatRupees(unpaid.reduce((sum, c) => sum + Number(c.amount || 0), 0))} was approved but never
              became a payable, so nothing is due to be paid. Retrying is safe — a claim that already has one is skipped.
            </div>
          </div>
          <button
            type="button"
            onClick={async () => {
              setRetrying(true);
              try {
                const r = await retryUnpaidApprovals();
                toast({
                  type: r.raised === r.attempted ? 'success' : 'warning',
                  title: `${r.raised} of ${r.attempted} reimbursed`,
                  message: r.raised === r.attempted
                    ? 'Every approved claim now has a payable behind it.'
                    : 'Some could not be raised — they stay listed here.',
                });
                await load();
              } catch (err: any) {
                toast({ type: 'error', title: 'Retry failed', message: err?.message ?? 'Please try again.' });
              } finally {
                setRetrying(false);
              }
            }}
            disabled={retrying}
            style={btnStyle('var(--warning, #d97706)')}
          >
            <RefreshCw size={15} /> {retrying ? 'Raising…' : 'Raise them now'}
          </button>
        </div>
      )}

      <DataTable<ExpenseClaim>
        columns={columns}
        rows={claims}
        rowKey={(c) => c.id}
        loading={loading}
        emptyMessage="No expense claims are awaiting review."
      />

      <Modal
        open={!!rejecting}
        onClose={() => { setRejecting(null); setRejectReason(''); }}
        title="Reject expense claim"
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" onClick={() => { setRejecting(null); setRejectReason(''); }} style={btnStyle('var(--text-muted)')}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmReject()}
              disabled={!rejectReason.trim() || busyId === rejecting?.id}
              style={btnStyle('var(--danger, #dc2626)')}
            >
              <X size={15} /> Reject claim
            </button>
          </div>
        }
      >
        <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text-muted)' }}>
          {rejecting ? `${rejecting.assayer?.displayName ?? 'Assayer'} — ${formatRupees(Number(rejecting.amount || 0))} (${EXPENSE_CATEGORY_LABELS[rejecting.category] ?? rejecting.category})` : ''}
        </p>
        {rejecting?.category === 'TRAVEL_KM' && rejecting.assignmentId && (
          <div style={{ marginBottom: 12 }}>
            <TravelEvidence assignmentId={rejecting.assignmentId} />
          </div>
        )}
        <label style={{ fontSize: 13, fontWeight: 600 }}>Reason (required)</label>
        <textarea
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          rows={3}
          placeholder="Explain why this claim is being rejected — the assayer will see this."
          style={{
            width: '100%', marginTop: 6, padding: 10, borderRadius: 8, resize: 'vertical',
            border: '1px solid var(--border, #d1d5db)', background: 'var(--bg-surface, #fff)', color: 'inherit', fontSize: 13,
          }}
        />
      </Modal>

      <Modal
        open={!!inspecting}
        onClose={() => setInspecting(null)}
        title="Recorded movement trail"
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" onClick={() => setInspecting(null)} style={btnStyle('var(--text-muted)')}>
              Close
            </button>
          </div>
        }
      >
        <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-muted)' }}>
          {inspecting
            ? `${inspecting.assayer?.displayName ?? 'Assayer'} — ${formatRupees(Number(inspecting.amount || 0))} claimed on ${inspecting.assignment?.assignmentNumber ?? 'this assignment'}`
            : ''}
        </p>
        {inspecting?.assignmentId && <TravelEvidence assignmentId={inspecting.assignmentId} />}
      </Modal>
    </div>
  );
};

function btnStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', fontSize: 12.5, fontWeight: 600,
    color, background: 'transparent', border: `1px solid ${color}`, borderRadius: 8, cursor: 'pointer',
  };
}
