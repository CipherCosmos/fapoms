import React, { useMemo, useState } from 'react';
import { CheckCircle2, CornerUpLeft, ShieldCheck } from 'lucide-react';
import {
  FINAL_APPROVAL_KINDS, FINAL_APPROVAL_KIND_LABELS, HOD_REJECT_REASON_MAX, hodRejectReasonProblem,
  type FinalApprovalItem, type FinalApprovalKind, type FinalApprovalRef,
} from '@fapoms/shared';
import { Modal, useConfirm, useToast } from '../../components/ui';
import { useFinalApprovalQueue, useFinalApprove, useFinalApproveMany, useFinalReject } from '../../hooks/useBilling';
import { billingApi, type FinalApprovalBulkResult } from '../../services/billing';
import { userMessage } from '../../services/errors';
import { QueuedJobTimeout } from '../../services/queued-job';
import { LoadFailure } from '../../components/LoadFailure';
import { loadFailed } from '../../queryClient';
import { moneyTotal as money } from '../../utils/money';
import { Card, Empty, fmtDate, inputStyle, tableScrollStyle, td, tdNum, th } from './shared';
import { DestinationWarnings } from './DestinationWarnings';

/**
 * FINAL APPROVAL — the HOD's queue (owner, 2026-09-24).
 *
 * Everything the office has approved that still needs the HOD before money can move: assayer
 * bills, payouts approved without a bill, expense reimbursements, and client invoices before they
 * are sent. One list, because it is one job — look at what the office approved, and either sign it
 * off or send it back with a reason. Only whoever holds the final billing approval sees this tab.
 *
 * Approving is one button per row, or a bulk approve of the ticked rows (run on the server's queue,
 * like the pay run). Sending back is always one at a time: it needs a reason, written for the
 * person at the office who will read it. The server refuses what the HOD may not approve — their own
 * office approval, something already paid — and that refusal is shown in its own words.
 */
type KindFilter = 'ALL' | FinalApprovalKind;

const keyOf = (r: FinalApprovalRef) => `${r.kind}:${r.id}`;

export const FinalApprovalTab: React.FC = () => {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const queue = useFinalApprovalQueue();
  const approveOne = useFinalApprove();
  const approveMany = useFinalApproveMany();
  const reject = useFinalReject();

  const [kind, setKind] = useState<KindFilter>('ALL');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState<FinalApprovalItem | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const all = useMemo(() => queue.data?.items ?? [], [queue.data?.items]);
  const rows = useMemo(() => (kind === 'ALL' ? all : all.filter((i) => i.kind === kind)), [all, kind]);
  const picked = rows.filter((r) => selected.has(keyOf(r)));
  const pickedTotal = picked.reduce((s, r) => s + Number(r.amount), 0);
  const busy = progress !== null || approveMany.isPending;

  const toggle = (r: FinalApprovalItem) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(keyOf(r))) n.delete(keyOf(r)); else n.add(keyOf(r));
    return n;
  });
  const allTicked = rows.length > 0 && rows.every((r) => selected.has(keyOf(r)));
  const toggleAll = () => setSelected(allTicked ? new Set() : new Set(rows.map(keyOf)));

  const runApproveOne = async (item: FinalApprovalItem) => {
    const ok = await confirm({
      title: `Give ${item.number} the final approval?`,
      message: (
        <>
          {FINAL_APPROVAL_KIND_LABELS[item.kind]} for <strong>{item.payeeName ?? '—'}</strong>,{' '}
          <strong>{money(item.amount)}</strong>, approved by {item.officeApprovedByName ?? 'the office'}.{' '}
          {item.kind === 'CLIENT_INVOICE'
            ? 'The office can then mark it sent to the client.'
            : 'It can then be paid.'}
        </>
      ),
      confirmLabel: `Approve ${money(item.amount)}`,
      reversible: false,
      reversibleNote: item.kind === 'CLIENT_INVOICE'
        ? 'To stop it afterwards, the office cancels the invoice.'
        : 'To stop a payment afterwards, put the payout on hold before it is paid.',
      tone: 'normal',
    });
    if (!ok) return;
    try {
      await approveOne.mutateAsync({ kind: item.kind, id: item.id });
      toast('success', `${item.number} approved`);
      setSelected((s) => { const n = new Set(s); n.delete(keyOf(item)); return n; });
    } catch (e) {
      toast({ type: 'error', title: `Could not approve ${item.number}`, message: userMessage(e) });
    }
  };

  const runApproveMany = async () => {
    if (!picked.length) return;
    const ok = await confirm({
      title: `Give ${picked.length} item${picked.length === 1 ? '' : 's'} the final approval?`,
      message: <>Totalling <strong>{money(pickedTotal)}</strong>. Each is approved on its own; anything the server refuses is listed afterwards and stays in this queue.</>,
      confirmLabel: `Approve ${picked.length} · ${money(pickedTotal)}`,
      reversible: false,
      reversibleNote: 'To stop a payment afterwards, put the payout on hold before it is paid.',
      tone: 'normal',
    });
    if (!ok) return;
    setProgress(`Approving ${picked.length} item${picked.length === 1 ? '' : 's'}…`);
    try {
      const started = await approveMany.mutateAsync(picked.map((r) => ({ kind: r.kind, id: r.id })));
      const r = await billingApi.followBulkJob<FinalApprovalBulkResult>(started, { onProgress: (p) => setProgress(`${p.stage}…`) });
      if (r.refused.length) {
        toast({ type: 'warning', title: `${r.done.length} approved, ${r.refused.length} refused`, message: r.refused.map((x) => x.reason).join(' · ') });
      } else {
        toast('success', `${r.done.length} item${r.done.length === 1 ? '' : 's'} approved`);
      }
      setSelected(new Set());
      void queue.refetch();
    } catch (e) {
      if (e instanceof QueuedJobTimeout) toast({ type: 'info', title: 'Still running on the server', message: e.message });
      else toast({ type: 'error', title: 'Final approval failed', message: userMessage(e) });
    } finally {
      setProgress(null);
    }
  };

  const counts = queue.data?.counts;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} role="group" aria-label="What to show">
        {(['ALL', ...FINAL_APPROVAL_KINDS] as KindFilter[]).map((k) => {
          const active = kind === k;
          const n = k === 'ALL' ? queue.data?.total : counts?.[k];
          return (
            <button key={k} onClick={() => { setKind(k); setSelected(new Set()); }} aria-pressed={active}
              title={k === 'ALL' ? 'Everything waiting for your final approval' : `${FINAL_APPROVAL_KIND_LABELS[k]}s waiting for your final approval`}
              style={{
                padding: '6px 12px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: active ? 700 : 600,
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: active ? 'var(--status-pending-bg)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-color)'}`,
              }}>
              {k === 'ALL' ? 'All' : FINAL_APPROVAL_KIND_LABELS[k]}
              {n !== undefined && n > 0 && (
                <span style={{ fontSize: 'var(--text-3xs, var(--text-2xs))', padding: '1px 6px', borderRadius: 10, background: active ? 'var(--accent-primary)' : 'var(--bg-tertiary)', color: active ? '#fff' : 'var(--text-muted)', fontWeight: 700 }}>{n}</span>
              )}
            </button>
          );
        })}
      </div>

      {progress && (
        <div role="status" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', padding: '8px 12px', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)' }}>
          {progress}
        </div>
      )}

      {picked.length > 0 && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', background: 'var(--bg-tertiary)', border: '1px solid var(--accent)', borderRadius: 'var(--radius-md)' }}>
          <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{picked.length} selected</span>
          <button className="btn btn-primary" disabled={busy} onClick={runApproveMany} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}
            title="Give every ticked item the final approval">
            <CheckCircle2 size={14} /> Approve {picked.length} · {money(pickedTotal)}
          </button>
          <button className="btn btn-secondary" onClick={() => setSelected(new Set())} title="Untick everything">Clear</button>
        </div>
      )}

      {loadFailed(queue) ? (
        <LoadFailure loads={[{ label: 'the final approval queue', query: queue }]} />
      ) : queue.isLoading ? <Empty>Loading…</Empty> : rows.length === 0 ? (
        <Empty>Nothing is waiting for your final approval.</Empty>
      ) : (
        <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><ShieldCheck size={14} /> Waiting for your final approval ({kind === 'ALL' ? queue.data?.total : counts?.[kind]})</span>}>
          {queue.data?.truncated && (
            <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginBottom: 8 }}>
              Showing the oldest first; approve these and the rest appear.
            </div>
          )}
          <div style={tableScrollStyle}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={{ ...th, width: 28 }}>
                  <input type="checkbox" checked={allTicked} onChange={toggleAll} aria-label="Tick every row" />
                </th>
                <th style={th}>What</th><th style={th}>Number</th><th style={th}>Payee</th>
                <th style={{ ...th, textAlign: 'right' }}>Amount</th>
                <th style={th}>Office approval</th><th style={th}>Note</th><th style={th} />
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={keyOf(r)}>
                    <td style={td}><input type="checkbox" checked={selected.has(keyOf(r))} onChange={() => toggle(r)} aria-label={`Tick ${r.number}`} /></td>
                    <td style={td}>{FINAL_APPROVAL_KIND_LABELS[r.kind]}</td>
                    <td style={{ ...td, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {r.number}
                      {r.assignmentNumber && <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', fontWeight: 400 }}>{r.assignmentNumber}</div>}
                      {r.lineCount > 1 && <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', fontWeight: 400 }}>{r.lineCount} lines</div>}
                    </td>
                    <td style={td}>
                      {r.payeeName ?? '—'}
                      {r.payeeCode && <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{r.payeeCode}</span>}
                    </td>
                    <td style={{ ...tdNum, fontWeight: 700, color: 'var(--text-primary)' }}>{money(r.amount)}</td>
                    <td style={td}>
                      {r.officeApprovedByName ?? '—'}
                      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{fmtDate(r.officeApprovedAt)}</div>
                    </td>
                    <td style={{ ...td, maxWidth: 260 }}>
                      {r.officeNote && <div title="Why the office approved it without a bill">{r.officeNote}</div>}
                      {r.lastRejectReason && <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--warning)' }}>Sent back before: {r.lastRejectReason}</div>}
                      {/* Where the money goes (audit F2/F3): not verified, changed since the office
                          approved, or on another assayer's record — the last one the approval refuses. */}
                      {!!r.warnings?.length && <div style={{ marginTop: 4 }}><DestinationWarnings checks={undefined} warnings={r.warnings} compact /></div>}
                      {!r.officeNote && !r.lastRejectReason && !r.warnings?.length && '—'}
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <button className="btn btn-primary" disabled={busy || approveOne.isPending} onClick={() => runApproveOne(r)}
                        style={{ fontSize: 'var(--text-2xs)', padding: '4px 10px', display: 'inline-flex', gap: 4, alignItems: 'center' }}
                        title={`Give ${r.number} the final approval`}>
                        <CheckCircle2 size={12} /> Approve
                      </button>
                      <button className="btn btn-secondary" disabled={busy} onClick={() => setRejecting(r)}
                        style={{ fontSize: 'var(--text-2xs)', padding: '4px 10px', marginLeft: 6, display: 'inline-flex', gap: 4, alignItems: 'center' }}
                        title={`Send ${r.number} back to the office with a reason`}>
                        <CornerUpLeft size={12} /> Send back
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {rejecting && (
        <SendBackModal
          item={rejecting}
          busy={reject.isPending}
          onClose={() => setRejecting(null)}
          onSubmit={async (reason) => {
            try {
              await reject.mutateAsync({ ref: { kind: rejecting.kind, id: rejecting.id }, reason });
              toast('success', `${rejecting.number} sent back to the office`);
              setSelected((s) => { const n = new Set(s); n.delete(keyOf(rejecting)); return n; });
              setRejecting(null);
            } catch (e) {
              toast({ type: 'error', title: `Could not send ${rejecting.number} back`, message: userMessage(e) });
            }
          }}
        />
      )}

      {confirmDialog}
    </div>
  );
};

/** Sending back needs a reason the office can act on — the same rule the server applies. */
export const SendBackModal: React.FC<{
  item: FinalApprovalItem; busy: boolean; onClose: () => void; onSubmit: (reason: string) => void;
}> = ({ item, busy, onClose, onSubmit }) => {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const problem = hodRejectReasonProblem(reason);
  const where = item.kind === 'CLIENT_INVOICE'
    ? 'It goes back to draft; the office fixes it and sends it up again.'
    : item.kind === 'ASSAYER_BILL'
      ? "It goes back to confirmed-by-the-assayer, and its payouts back to Due; the office approves it again, revises it, or cancels it."
      : 'It goes back to Due; the office fixes and approves it again, or voids it.';
  return (
    <Modal open onClose={onClose} width="520px" asForm
      title={<><CornerUpLeft size={18} /> Send {item.number} back to the office</>}
      onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!problem) onSubmit(reason.trim()); }}
      footer={<>
        <button type="button" onClick={onClose} className="btn btn-secondary">Keep it</button>
        <button type="submit" disabled={busy || !!problem} className="btn btn-primary">{busy ? 'Sending back…' : 'Send back'}</button>
      </>}>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        {FINAL_APPROVAL_KIND_LABELS[item.kind]} for <strong>{item.payeeName ?? '—'}</strong>, {money(item.amount)}. {where}{' '}
        {item.officeApprovedByName ? `${item.officeApprovedByName} is told, with your reason.` : 'The office is told, with your reason.'}
      </div>
      <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        Why it is going back *
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} onBlur={() => setTouched(true)} rows={3}
          maxLength={HOD_REJECT_REASON_MAX} aria-label="Reason for sending it back"
          style={{ ...inputStyle, width: '100%', resize: 'vertical' }} />
      </label>
      {touched && problem && <div role="alert" style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)' }}>{problem}</div>}
    </Modal>
  );
};
