import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, X, Receipt, RefreshCw } from 'lucide-react';
import { formatRupees } from '@fapoms/shared';
import { DataTable, Column, Modal, useToast } from '../components/ui';
import {
  getPendingExpenses,
  reviewExpense,
  EXPENSE_CATEGORY_LABELS,
  ExpenseClaim,
} from '../services/expenses';

/**
 * Expense Review — the finance/ops queue for assayer reimbursement claims.
 *
 * Assayers raise claims from the mobile app; this is where they get approved or rejected. A
 * rejection requires a reason (the backend enforces it too), so the assayer always knows why.
 */
export const ExpenseReview: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const { toast } = useToast();
  const [claims, setClaims] = useState<ExpenseClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<ExpenseClaim | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setClaims(await getPendingExpenses());
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
    <div style={{ padding: embedded ? 0 : '20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        {embedded ? <div /> : (
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Expense Review</h1>
            <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 13 }}>
              Reimbursement claims raised by field assayers, awaiting a decision.
            </p>
          </div>
        )}
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
    </div>
  );
};

function btnStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', fontSize: 12.5, fontWeight: 600,
    color, background: 'transparent', border: `1px solid ${color}`, borderRadius: 8, cursor: 'pointer',
  };
}
