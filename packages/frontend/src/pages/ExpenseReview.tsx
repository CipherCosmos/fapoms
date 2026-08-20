import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, X, Receipt, RefreshCw, MapPin, CheckCircle2 } from 'lucide-react';
import { formatRupees } from '@fapoms/shared';
import { DataTable, Column, Modal, useConfirm, useToast } from '../components/ui';
import {
  getPendingExpenses,
  reviewExpense,
  EXPENSE_CATEGORY_LABELS,
  ExpenseClaim,
} from '../services/expenses';
import { TravelEvidence } from '../components/TravelEvidence';
import { userMessage } from '../services/errors';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../hooks/queryKeys';
import { visibleSelection, hiddenSelectionNote } from '../utils/selection';

/**
 * Expense Review — the finance/ops queue for assayer reimbursement claims.
 *
 * Assayers raise claims from the mobile app; this is where they get approved or rejected. A
 * rejection requires a reason (the backend enforces it too), so the assayer always knows why.
 *
 * Approving can be done to several claims at once; rejecting cannot, and that asymmetry is
 * deliberate. Approving is one decision repeated — "yes, these are all payable" — and the
 * reviewer has the amounts in front of them. Rejecting is a different decision each time,
 * because the reason belongs to the individual claim and is the only thing the assayer is
 * told; a reason written once and applied to a batch would be a form letter attached to
 * people's own money, and would be worse than the extra clicks it saved.
 */
// Always rendered inside <Billing/>'s Expenses tab, never routed standalone — the
// `embedded=false` branch this used to carry (its own page title) was unreachable and has
// been removed.
export const ExpenseReview: React.FC = () => {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const qc = useQueryClient();
  const [claims, setClaims] = useState<ExpenseClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<ExpenseClaim | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  // A travel claim whose movement trail the reviewer has opened.
  const [inspecting, setInspecting] = useState<ExpenseClaim | null>(null);
  // Ticked claim ids, and the progress line shown while a batch is being worked through.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setClaims(await getPendingExpenses());
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not load claims', message: `Check your connection and refresh the page. ${userMessage(err)}` });
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
      setSelected((s) => { const n = new Set(s); n.delete(claim.id); return n; });
      // Approval books the reimbursement as a payout in the same transaction; the Payouts tab
      // and the overview read it from the server.
      void qc.invalidateQueries({ queryKey: queryKeys.billing.all });
      toast({ type: 'success', title: 'Claim approved', message: `${formatRupees(Number(claim.amount))} is now a payout due to the assayer.` });
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not approve', message: `The claim has not been approved. Try again in a moment. ${userMessage(err)}` });
    } finally {
      setBusyId(null);
    }
  };

  /**
   * The rows the bulk button will actually change: the ticked ids narrowed to the claims on
   * screen right now, via the one shared rule (`visibleSelection`). Ticks survive a refresh
   * that drops a claim — someone else may have reviewed it meanwhile — but a claim that is no
   * longer listed is not approved behind the reviewer's back, and the count below says so.
   */
  const picked = useMemo(
    () => visibleSelection(selected, claims, (c) => c.id),
    [selected, claims],
  );
  const pickedTotal = useMemo(
    () => picked.rows.reduce((sum, c) => sum + Number(c.amount || 0), 0),
    [picked],
  );
  const hiddenNote = hiddenSelectionNote(picked.hiddenCount, 'claim');

  const toggleSelect = (id: string) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectAll = (checked: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      claims.forEach((c) => (checked ? n.add(c.id) : n.delete(c.id)));
      return n;
    });

  /**
   * Approve every ticked claim.
   *
   * Approving a claim authorises a reimbursement — it books a payout due to the assayer in the
   * same transaction — so the batch version carries more friction than the single-row button,
   * not less. The dialog names the count *and* the rupee total being authorised, and asks for
   * that total to be typed, exactly as PayoutsTab does before approving payouts: a second click
   * is the same reflex as the first, but a number that has to be read off the dialog and typed
   * cannot be produced without looking at it. The phrase is plain digits rather than the
   * formatted "₹12,340" because the rupee sign and the Indian grouping are awkward to type, and
   * a phrase people cannot type is a phrase they find a way around.
   *
   * There is no bulk-approve endpoint, so this walks the claims one at a time on the same
   * per-claim call the single button uses. That is on purpose rather than a compromise: each
   * claim succeeds or fails on its own, a failure part-way through does not roll back or skip
   * the rest, and the reviewer is told which ones did not go through. Approved rows leave the
   * list and lose their tick; the ones that failed keep theirs, so the retry is the same button
   * on exactly the claims that still need it. The selection is never blanket-cleared, because
   * clearing it after a partial failure would hide the very rows that still need attention.
   */
  const runBulkApprove = async () => {
    const rows = picked.rows;
    if (!rows.length) return;
    const amountText = formatRupees(pickedTotal);
    const ok = await confirm({
      title: `Approve ${rows.length} expense claim${rows.length === 1 ? '' : 's'}?`,
      message: (
        <>
          This authorises <strong>{amountText}</strong> of reimbursements across {rows.length} claim
          {rows.length === 1 ? '' : 's'} from {new Set(rows.map((c) => c.assayerId)).size} assayer
          {new Set(rows.map((c) => c.assayerId)).size === 1 ? '' : 's'}. Each approved claim becomes a payout
          due to that assayer.
          {hiddenNote ? <><br />{hiddenNote}</> : null}
        </>
      ),
      confirmLabel: `Approve ${amountText}`,
      reversible: false,
      reversibleNote: 'Approving cannot be undone here. Once a claim is approved it becomes a payout, and stopping it means putting that payout on hold before it is paid.',
      tone: 'danger',
      confirmPhrase: String(Math.round(pickedTotal)),
    });
    if (!ok) return;

    const done: string[] = [];
    const failed: { claim: ExpenseClaim; message: string }[] = [];
    setBulkProgress(`Approving 1 of ${rows.length}…`);
    try {
      for (let i = 0; i < rows.length; i++) {
        const claim = rows[i];
        setBulkProgress(`Approving ${i + 1} of ${rows.length}…`);
        try {
          await reviewExpense(claim.id, true);
          done.push(claim.id);
        } catch (err: any) {
          failed.push({ claim, message: userMessage(err) });
        }
      }
    } finally {
      setBulkProgress(null);
    }

    // Only the claims that actually went through leave the list and lose their tick.
    if (done.length) {
      const approvedIds = new Set(done);
      setClaims((prev) => prev.filter((c) => !approvedIds.has(c.id)));
      setSelected((s) => { const n = new Set(s); approvedIds.forEach((id) => n.delete(id)); return n; });
      void qc.invalidateQueries({ queryKey: queryKeys.billing.all });
    }

    if (!failed.length) {
      toast({ type: 'success', title: `${done.length} claim${done.length === 1 ? '' : 's'} approved`, message: `${amountText} is now payable to the assayers.` });
    } else {
      const names = failed
        .slice(0, 3)
        .map((f) => `${f.claim.assayer?.displayName ?? 'Assayer'} (${formatRupees(Number(f.claim.amount || 0))}) — ${f.message}`)
        .join(' · ');
      toast({
        type: 'warning',
        title: `${done.length} approved, ${failed.length} not approved`,
        message: `Still selected, so you can try again: ${names}${failed.length > 3 ? ` · and ${failed.length - 3} more` : ''}`,
      });
    }
  };

  const confirmReject = async () => {
    if (!rejecting || !rejectReason.trim()) return;
    const claim = rejecting;
    setBusyId(claim.id);
    try {
      await reviewExpense(claim.id, false, rejectReason.trim());
      setClaims((prev) => prev.filter((c) => c.id !== claim.id));
      setSelected((s) => { const n = new Set(s); n.delete(claim.id); return n; });
      toast({ type: 'success', title: 'Claim rejected', message: 'The assayer will see the reason you gave.' });
      setRejecting(null);
      setRejectReason('');
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not reject', message: `The claim has not been rejected. Try again in a moment. ${userMessage(err)}` });
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
            disabled={busyId === c.id || !!bulkProgress}
            title="Approve"
            style={btnStyle('var(--success, #16a34a)')}
          >
            <Check size={15} /> Approve
          </button>
          <button
            type="button"
            onClick={() => { setRejecting(c); setRejectReason(''); }}
            disabled={busyId === c.id || !!bulkProgress}
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

      {picked.rows.length > 0 && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', marginBottom: 12, background: 'var(--bg-tertiary)', border: '1px solid var(--accent, #2563eb)', borderRadius: 8 }}>
          {/* The number on the button is the number that will change — the ticked claims that
              are on screen — and anything ticked but not shown is named rather than silently
              included or silently dropped. */}
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {picked.rows.length} selected · {formatRupees(pickedTotal)}
          </span>
          <button
            type="button"
            onClick={() => void runBulkApprove()}
            disabled={!!bulkProgress || !!busyId}
            style={btnStyle('var(--success, #16a34a)')}
          >
            <CheckCircle2 size={15} /> {bulkProgress ?? `Approve ${picked.rows.length} (${formatRupees(pickedTotal)})`}
          </button>
          <button type="button" onClick={() => setSelected(new Set())} disabled={!!bulkProgress} style={btnStyle('var(--text-muted)')}>
            Clear selection
          </button>
          {/* Rejecting is per claim on purpose: the reason is written for that assayer. */}
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            Rejecting stays one claim at a time, so each assayer gets a reason written for their claim.
          </span>
          {hiddenNote && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{hiddenNote}</span>}
        </div>
      )}

      <DataTable<ExpenseClaim>
        columns={columns}
        rows={claims}
        rowKey={(c) => c.id}
        selectable
        selected={selected}
        onToggleSelect={toggleSelect}
        onSelectAll={selectAll}
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

      {confirmDialog}
    </div>
  );
};

function btnStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', fontSize: 12.5, fontWeight: 600,
    color, background: 'transparent', border: `1px solid ${color}`, borderRadius: 8, cursor: 'pointer',
  };
}
