import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useScope, withScope } from '../context/ScopeContext';
import { useNavigate } from 'react-router-dom';
import {
  Phone, PhoneOff, CheckCircle, XCircle, RefreshCw, AlertTriangle, IndianRupee,
  CalendarClock, UserX, Inbox as InboxIcon, X, MapPin,
} from 'lucide-react';
import { api } from '../services/api';
import { queryClient } from '../queryClient';
import { queryKeys } from '../hooks/queryKeys';
import { useSocketConnection } from '../hooks/useSocketConnection';
import { getRecommendations } from '../services/planning';
import { AlertBanner } from '../components/ui';

import { usePlatformLimits } from '../hooks/usePlatformLimits';
/**
 * The Operations Inbox — every assignment waiting on a DESK decision, one queue, actions inline.
 *
 * Built for the real operation: not every assayer uses a smartphone, so offers to phone-channel
 * assayers arrive here as CALL TASKS, and the desk records the call's outcome on their behalf
 * (accept at the verbally-agreed fee / counter / decline / no answer) — every outcome writes a
 * call log, which is the evidentiary record behind manual workover. The system proposes;
 * the desk disposes. An empty inbox is a healthy operation.
 */

interface InboxItem {
  id: string;
  assignmentNumber: string;
  projectBranchId: string | null;
  branchName: string | null;
  branchCity: string | null;
  branchId: string | null;
  projectName: string | null;
  assayerId: string;
  assayerName: string | null;
  assayerPhone: string | null;
  channel: 'APP' | 'PHONE';
  proposedFee: number | null;
  agreedFee: number | null;
  clientBaseFee: number | null;
  /** Backend sanity guard: proposed fee exceeds 1.5× the client's reference rate. */
  feeFlagged: boolean;
  negotiationCount: number;
  scheduledDate: string | null;
  ageHours: number;
  callAttempts: number;
  lastCallOutcome: string | null;
  rejectReason?: string | null;
}

interface FieldIssueItem {
  id: string; assignmentId: string; branchName: string | null; assayerName: string | null;
  categoryLabel: string | null; category: string | null; note: string; reportedAt: string;
}

interface InboxData {
  callTasks: InboxItem[];
  negotiations: InboxItem[];
  replacements: InboxItem[];
  unscheduled: InboxItem[];
  overdue: InboxItem[];
  waitingOnApp: number;
  fieldIssues: FieldIssueItem[];
  suggestNextAfterAttempts: number;
}

interface Candidate {
  id: string; displayName: string; distanceKm: number | null; score: number | null;
  baseFee: number | null; phone?: string;
}

import { money as inr } from '../utils/money';
const age = (h: number) => (h < 1 ? 'just now' : h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`);

export const OperationsInbox: React.FC = () => {
  const { maxNegotiationRounds } = usePlatformLimits();
  const navigate = useNavigate();
  const { scopeParams, scopeKey } = useScope();
  const scopeQuery = withScope(scopeParams);
  // The Layout's socket invalidation (via the desk.inbox key) refreshes this queue on every
  // assignment event, so the poll is only a fallback for when the realtime channel is down.
  const live = useSocketConnection();

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    // From the registry, so `useSocketInvalidation` refreshes this queue on every assignment
    // event. As a bare literal it matched nothing in the socket map, and a counter-offer took up
    // to the 60-second poll below to reach the desk.
    //
    // The key alone was not enough: the hook it depends on was mounted per page, and never on
    // this one — while the poll below is switched off whenever the socket is up. So the
    // negotiation queue had neither channel and only moved when the operator reloaded. The hook
    // now lives in the Layout, which every route renders inside.
    queryKey: [...queryKeys.desk.inbox, scopeKey],
    queryFn: () => api.request<InboxData>(`/assignments/inbox?${scopeQuery}`),
    staleTime: 20_000,
    refetchInterval: live ? false : 60_000,
  });

  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Per-card expanded input: which card has which mini-form open ('agree' | 'counter' | 'decline').
  const [openForm, setOpenForm] = useState<{ id: string; kind: 'agree' | 'counter' | 'decline' } | null>(null);
  const [feeInput, setFeeInput] = useState('');
  const [reasonInput, setReasonInput] = useState('');
  // Reassign drawer target.
  const [reassignFor, setReassignFor] = useState<InboxItem | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.desk.inbox });
    queryClient.invalidateQueries({ queryKey: ['assignments'] });
  };

  /** Every desk action pairs the assignment transition with a call-log write — the evidence. */
  const logCall = (item: InboxItem, outcome: string, fee?: number, notes?: string) => {
    if (!item.projectBranchId) return Promise.resolve();
    return api
      .request('/call-logs', {
        method: 'POST',
        body: JSON.stringify({
          projectBranchId: item.projectBranchId,
          assayerId: item.assayerId,
          outcome,
          negotiatedFee: fee,
          notes: notes || 'Recorded from the Operations Inbox',
        }),
      })
      .catch(() => {}); // The log supports the action; losing it must never undo the action.
  };

  const act = async (item: InboxItem, fn: () => Promise<unknown>, successText: string) => {
    if (busyId) return;
    setBusyId(item.id);
    setMessage(null);
    try {
      await fn();
      setMessage({ type: 'success', text: successText });
      setOpenForm(null);
      refresh();
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Action failed.' });
    } finally {
      setBusyId(null);
    }
  };

  const agree = (item: InboxItem) => {
    const fee = Number(feeInput || item.proposedFee || 0);
    if (!fee) { setMessage({ type: 'error', text: 'Enter the agreed fee.' }); return; }
    void act(item, async () => {
      await api.request(`/assignments/${item.id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus: 'ACCEPTED', fee, reason: 'Verbal acceptance recorded by the desk' }),
      });
      await logCall(item, 'AGREED', fee, 'Agreed on call — accepted on their behalf');
    }, `${item.assayerName} accepted ${item.branchName} at ${inr(fee)} (call logged).`);
  };

  const counter = (item: InboxItem) => {
    const fee = Number(feeInput);
    if (!fee) { setMessage({ type: 'error', text: 'Enter the fee they asked for.' }); return; }
    void act(item, async () => {
      await api.request(`/assignments/${item.id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus: 'NEGOTIATION', counterFee: fee, remarks: 'Fee requested on call, recorded by the desk' }),
      });
      await logCall(item, 'NEGOTIATING', fee, 'Asked for a different fee on call');
    }, `Recorded: ${item.assayerName} wants ${inr(fee)}. Decide when ready.`);
  };

  const decline = (item: InboxItem) => {
    void act(item, async () => {
      await api.request(`/assignments/${item.id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus: 'REJECTED', reason: reasonInput.trim() || 'Declined on call' }),
      });
      await logCall(item, 'DECLINED', undefined, reasonInput.trim() || undefined);
    }, `${item.branchName} marked declined — it will appear in Replacements.`);
  };

  const noAnswer = (item: InboxItem) => {
    void act(item, async () => {
      await logCall(item, 'NO_ANSWER');
    }, `No-answer logged for ${item.assayerName} (${item.callAttempts + 1} attempt${item.callAttempts ? 's' : ''}).`);
  };

  const lane = (title: string, icon: React.ReactNode, count: number, tone: string, children: React.ReactNode) =>
    count === 0 ? null : (
      <section style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 800, color: tone, margin: 0, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {icon} {title} <span style={{ background: `${tone}20`, padding: '1px 9px', borderRadius: '10px' }}>{count}</span>
        </h2>
        {children}
      </section>
    );

  const CardShell: React.FC<{ item: InboxItem; chip?: React.ReactNode; children?: React.ReactNode }> = ({ item, chip, children }) => (
    <div className="glass-card" style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>
            {item.branchName || item.assignmentNumber}
            {item.branchCity && <span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}> · {item.branchCity}</span>}
            {chip}
          </div>
          <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '2px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <span>{item.assignmentNumber}</span>
            {item.projectName && <span>{item.projectName}</span>}
            <span>offered {age(item.ageHours)}</span>
            {item.callAttempts > 0 && (
              <span style={{ color: 'var(--warning)', fontWeight: 700 }}>
                {item.callAttempts} call{item.callAttempts > 1 ? 's' : ''}{item.lastCallOutcome ? ` · last: ${item.lastCallOutcome.replace(/_/g, ' ').toLowerCase()}` : ''}
              </span>
            )}
          </div>
          <div style={{ fontSize: '12.5px', color: 'var(--text-primary)', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <b>{item.assayerName || 'Assayer'}</b>
            {item.assayerPhone && (
              <a href={`tel:${item.assayerPhone}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--accent)', textDecoration: 'none', fontWeight: 700 }}>
                <Phone size={12} /> {item.assayerPhone}
              </a>
            )}
            <span style={{ color: 'var(--warning)', fontWeight: 700 }}>{inr(item.proposedFee)} proposed</span>
            {/* Sanity guard: a mis-entered contract rate must be a visible warning, never silent money. */}
            {item.feeFlagged && item.clientBaseFee != null && item.proposedFee != null && (
              <span
                title={`This fee is ${(item.proposedFee / item.clientBaseFee).toFixed(1)}× the client's reference rate of ${inr(item.clientBaseFee)}. Check the assayer's contracted rate before offering.`}
                style={{ fontSize: '10px', fontWeight: 800, padding: '1px 8px', borderRadius: '8px', background: 'var(--status-cancelled-bg)', color: 'var(--danger)', cursor: 'help' }}
              >
                ⚠ {(item.proposedFee / item.clientBaseFee).toFixed(1)}× CLIENT RATE
              </span>
            )}
          </div>
        </div>
        {children}
      </div>
    </div>
  );

  const miniInput = (placeholder: string, value: string, onChange: (v: string) => void, type = 'number') => (
    <input
      autoFocus type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      style={{ width: type === 'number' ? '110px' : '220px', padding: '5px 9px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', outline: 'none', fontSize: '12px' }}
    />
  );

  const data0: InboxData = data ?? {
    callTasks: [], negotiations: [], replacements: [], unscheduled: [], overdue: [],
    waitingOnApp: 0, fieldIssues: [], suggestNextAfterAttempts: 3,
  };
  const totalActionable =
    data0.callTasks.length + data0.negotiations.length + data0.replacements.length +
    data0.unscheduled.length + data0.overdue.length + data0.fieldIssues.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', padding: '0 8px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '22px' }}>Operations Inbox</h1>
          <p style={{ margin: '4px 0 0', fontSize: '12.5px', color: 'var(--text-secondary)' }}>
            Every assignment waiting on a desk decision. Phone-channel assayers appear as call tasks — record the
            call's outcome and the system does the rest. An empty inbox is a healthy operation.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {data0.waitingOnApp > 0 && (
            <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
              {data0.waitingOnApp} offer{data0.waitingOnApp > 1 ? 's' : ''} awaiting in-app response
            </span>
          )}
          <button onClick={() => refetch()} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <RefreshCw size={14} className={isFetching ? 'spin' : undefined} /> Refresh
          </button>
        </div>
      </div>

      {message && <AlertBanner type={message.type} message={message.text} onClose={() => setMessage(null)} />}
      {isError && (
        <AlertBanner type="error">
          <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            Could not load the inbox.
            <button onClick={() => refetch()} className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: '11px' }}>Retry</button>
          </span>
        </AlertBanner>
      )}

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>
          <span className="spinner" style={{ display: 'inline-block', marginBottom: 8 }} /> Loading the queue…
        </div>
      ) : totalActionable === 0 ? (
        <div className="glass-card" style={{ padding: '48px', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <InboxIcon size={34} style={{ opacity: 0.5, marginBottom: 10 }} />
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>Inbox zero — the operation is healthy.</div>
          <div style={{ fontSize: '12.5px', marginTop: 4 }}>New calls, counters, declines and field issues will appear here the moment they need you.</div>
        </div>
      ) : (
        <>
          {lane('Call queue', <Phone size={14} />, data0.callTasks.length, 'var(--warning)', (
            data0.callTasks.map((item) => {
              const suggestNext = item.callAttempts >= data0.suggestNextAfterAttempts;
              const form = openForm?.id === item.id ? openForm.kind : null;
              const busy = busyId === item.id;
              return (
                <CardShell
                  key={item.id}
                  item={item}
                  chip={
                    <span style={{ marginLeft: 8, fontSize: '10px', fontWeight: 800, padding: '1px 8px', borderRadius: '8px', background: item.channel === 'PHONE' ? 'var(--status-pending-bg)' : 'var(--bg-surface-2)', color: item.channel === 'PHONE' ? 'var(--warning)' : 'var(--text-muted)' }}>
                      {item.channel === 'PHONE' ? 'PHONE-ONLY' : 'APP · GONE QUIET'}
                    </span>
                  }
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-end' }}>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {form === 'agree' ? (
                        <>
                          {miniInput('Agreed ₹', feeInput, setFeeInput)}
                          <button onClick={() => agree(item)} disabled={busy} className="btn btn-primary" style={{ padding: '5px 12px', fontSize: '11.5px', background: 'var(--success)', borderColor: 'var(--success)' }}>
                            {busy ? 'Saving…' : 'Confirm & assign'}
                          </button>
                          <button onClick={() => setOpenForm(null)} className="btn btn-secondary" style={{ padding: '5px 10px', fontSize: '11.5px' }}><X size={12} /></button>
                        </>
                      ) : form === 'counter' ? (
                        <>
                          {miniInput('They want ₹', feeInput, setFeeInput)}
                          <button onClick={() => counter(item)} disabled={busy} className="btn btn-primary" style={{ padding: '5px 12px', fontSize: '11.5px', background: 'var(--warning)', borderColor: 'var(--warning)' }}>
                            {busy ? 'Saving…' : 'Record counter'}
                          </button>
                          <button onClick={() => setOpenForm(null)} className="btn btn-secondary" style={{ padding: '5px 10px', fontSize: '11.5px' }}><X size={12} /></button>
                        </>
                      ) : form === 'decline' ? (
                        <>
                          {miniInput('Reason…', reasonInput, setReasonInput, 'text')}
                          <button onClick={() => decline(item)} disabled={busy} className="btn btn-primary" style={{ padding: '5px 12px', fontSize: '11.5px', background: 'var(--danger)', borderColor: 'var(--danger)' }}>
                            {busy ? 'Saving…' : 'Confirm decline'}
                          </button>
                          <button onClick={() => setOpenForm(null)} className="btn btn-secondary" style={{ padding: '5px 10px', fontSize: '11.5px' }}><X size={12} /></button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => { setFeeInput(String(item.proposedFee ?? '')); setOpenForm({ id: item.id, kind: 'agree' }); }} disabled={busy}
                            className="btn btn-primary" style={{ padding: '5px 12px', fontSize: '11.5px', background: 'var(--success)', borderColor: 'var(--success)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <CheckCircle size={12} /> Agreed at ₹…
                          </button>
                          <button onClick={() => { setFeeInput(''); setOpenForm({ id: item.id, kind: 'counter' }); }} disabled={busy}
                            className="btn btn-secondary" style={{ padding: '5px 12px', fontSize: '11.5px', color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <IndianRupee size={12} /> Wants ₹…
                          </button>
                          <button onClick={() => { setReasonInput(''); setOpenForm({ id: item.id, kind: 'decline' }); }} disabled={busy}
                            className="btn btn-secondary" style={{ padding: '5px 12px', fontSize: '11.5px', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <XCircle size={12} /> Declined
                          </button>
                          <button onClick={() => noAnswer(item)} disabled={busy}
                            className="btn btn-secondary" style={{ padding: '5px 12px', fontSize: '11.5px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <PhoneOff size={12} /> {busy ? '…' : 'No answer'}
                          </button>
                        </>
                      )}
                    </div>
                    {suggestNext && !form && (
                      <button onClick={() => setReassignFor(item)} className="btn btn-secondary"
                        style={{ padding: '4px 10px', fontSize: '11px', color: 'var(--warning)', borderColor: 'var(--status-pending-bg)' }}>
                        {item.callAttempts}+ unanswered calls — find another assayer
                      </button>
                    )}
                  </div>
                </CardShell>
              );
            })
          ))}

          {lane('Negotiations', <IndianRupee size={14} />, data0.negotiations.length, 'var(--accent)', (
            data0.negotiations.map((item) => {
              const busy = busyId === item.id;
              return (
                <CardShell key={item.id} item={item}
                  chip={<span style={{ marginLeft: 8, fontSize: '10px', fontWeight: 800, padding: '1px 8px', borderRadius: '8px', background: 'var(--status-pending-bg)', color: 'var(--warning)' }}>ROUND {item.negotiationCount}/{maxNegotiationRounds}</span>}>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <button
                      onClick={() => void act(item, async () => {
                        await api.request(`/assignments/${item.id}/transition`, {
                          method: 'POST',
                          body: JSON.stringify({ targetStatus: 'ACCEPTED', fee: item.proposedFee, reason: 'Counter fee approved by the desk' }),
                        });
                      }, `Accepted ${item.assayerName}'s ${inr(item.proposedFee)} on ${item.branchName}.`)}
                      disabled={busy}
                      className="btn btn-primary" style={{ padding: '5px 12px', fontSize: '11.5px', background: 'var(--success)', borderColor: 'var(--success)' }}>
                      {busy ? 'Saving…' : `Accept ${inr(item.proposedFee)}`}
                    </button>
                    {/*
                      This inbox transcribes a phone call — every action here records what the
                      assayer said, it does not send them anything. `counter()` posts the amount as
                      the assayer's new asking price ("Fee requested on call, recorded by the desk")
                      and the row then offers "Accept ₹X".

                      Labelling it "Counter back…" with a "Counter ₹" placeholder said the opposite:
                      that the desk was making its own counter-offer. An operator who typed the
                      figure *they* wanted to pay had it filed as the assayer's demand, and one more
                      click locked that fee in — with the call log and audit trail both recording
                      that the assayer had asked for it.
                    */}
                    <button onClick={() => { setFeeInput(''); setOpenForm({ id: item.id, kind: 'counter' }); }} disabled={busy}
                      className="btn btn-secondary" style={{ padding: '5px 12px', fontSize: '11.5px', color: 'var(--warning)' }}>
                      Record their ask…
                    </button>
                    {openForm?.id === item.id && openForm.kind === 'counter' && (
                      <>
                        {miniInput('They asked ₹', feeInput, setFeeInput)}
                        <button onClick={() => counter(item)} disabled={busy} className="btn btn-primary" style={{ padding: '5px 12px', fontSize: '11.5px', background: 'var(--warning)', borderColor: 'var(--warning)' }}>Send</button>
                      </>
                    )}
                    <button onClick={() => { setReasonInput(''); setOpenForm({ id: item.id, kind: 'decline' }); }} disabled={busy}
                      className="btn btn-secondary" style={{ padding: '5px 12px', fontSize: '11.5px', color: 'var(--danger)' }}>
                      Decline
                    </button>
                    {openForm?.id === item.id && openForm.kind === 'decline' && (
                      <>
                        {miniInput('Reason…', reasonInput, setReasonInput, 'text')}
                        <button onClick={() => decline(item)} disabled={busy} className="btn btn-primary" style={{ padding: '5px 12px', fontSize: '11.5px', background: 'var(--danger)', borderColor: 'var(--danger)' }}>Confirm</button>
                      </>
                    )}
                  </div>
                </CardShell>
              );
            })
          ))}

          {lane('Needs a replacement', <UserX size={14} />, data0.replacements.length, 'var(--danger)', (
            data0.replacements.map((item) => (
              <CardShell key={item.id} item={item}
                chip={<span style={{ marginLeft: 8, fontSize: '10px', fontWeight: 800, padding: '1px 8px', borderRadius: '8px', background: 'var(--status-cancelled-bg)', color: 'var(--danger)' }}>
                  {item.rejectReason === 'AUTO_DECLINED_SLA_EXPIRED' ? 'OFFER EXPIRED' : 'DECLINED'}
                </span>}>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button onClick={() => setReassignFor(item)} className="btn btn-primary" style={{ padding: '5px 12px', fontSize: '11.5px' }}>
                    Find replacement
                  </button>
                  <button onClick={() => navigate(`/planning?projectId=`)} className="btn btn-secondary" style={{ padding: '5px 12px', fontSize: '11.5px' }}>
                    Open planning
                  </button>
                </div>
              </CardShell>
            ))
          ))}

          {lane('Accepted, not scheduled', <CalendarClock size={14} />, data0.unscheduled.length, 'var(--accent)', (
            data0.unscheduled.map((item) => (
              <CardShell key={item.id} item={item}>
                <button onClick={() => navigate('/scheduling')} className="btn btn-primary" style={{ padding: '5px 12px', fontSize: '11.5px' }}>
                  Put on calendar
                </button>
              </CardShell>
            ))
          ))}

          {lane('Overdue — no check-in', <AlertTriangle size={14} />, data0.overdue.length, 'var(--danger)', (
            data0.overdue.map((item) => (
              <CardShell key={item.id} item={item}
                chip={<span style={{ marginLeft: 8, fontSize: '10px', fontWeight: 800, padding: '1px 8px', borderRadius: '8px', background: 'var(--status-cancelled-bg)', color: 'var(--danger)' }}>
                  DUE {item.scheduledDate}
                </span>}>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button onClick={() => navigate(`/assignments?id=${item.id}`)} className="btn btn-secondary" style={{ padding: '5px 12px', fontSize: '11.5px' }}>
                    Open in Stage 3
                  </button>
                </div>
              </CardShell>
            ))
          ))}

          {lane('Field issues', <MapPin size={14} />, data0.fieldIssues.length, 'var(--warning)', (
            data0.fieldIssues.map((issue) => (
              <div key={issue.id} className="glass-card" style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: '13.5px', fontWeight: 800, color: 'var(--text-primary)' }}>
                    {issue.categoryLabel || issue.category || 'Issue'} · {issue.branchName || issue.assignmentId.slice(0, 8)}
                  </div>
                  <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                    {issue.note || 'No detail given.'} — {issue.assayerName || 'Assayer'} · {new Date(issue.reportedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                  </div>
                </div>
                <button onClick={() => navigate(`/assignments?id=${issue.assignmentId}`)} className="btn btn-primary" style={{ padding: '5px 12px', fontSize: '11.5px' }}>
                  Open assignment
                </button>
              </div>
            ))
          ))}
        </>
      )}

      {reassignFor && (
        <ReassignDrawer
          item={reassignFor}
          onClose={() => setReassignFor(null)}
          onOffered={(name) => {
            setReassignFor(null);
            setMessage({ type: 'success', text: `Offer sent to ${name} for ${reassignFor.branchName}.` });
            refresh();
          }}
        />
      )}
    </div>
  );
};

/**
 * Inline reassignment: the engine's ranked candidates for the branch, one click to offer —
 * without leaving the queue. Mirrors the planning page's recommendation data exactly.
 */
const ReassignDrawer: React.FC<{
  item: InboxItem;
  onClose: () => void;
  onOffered: (assayerName: string) => void;
}> = ({ item, onClose, onOffered }) => {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['inbox-recommendations', item.branchId, item.scheduledDate],
    // A replacement steps into the ORIGINAL audit date, so candidates are ranked for that
    // day — availability and fees for "today" would answer the wrong question.
    queryFn: () => getRecommendations<Candidate, unknown>(item.branchId!, item.scheduledDate?.slice(0, 10) || undefined),
    enabled: !!item.branchId,
    staleTime: 30_000,
  });
  const candidates = (data?.data ?? []).filter((c) => c.id !== item.assayerId).slice(0, 6);

  const offer = async (c: Candidate) => {
    if (!item.projectBranchId || busyId) return;
    setBusyId(c.id);
    setError(null);
    try {
      await api.request('/assignments', {
        method: 'POST',
        body: JSON.stringify({
          projectBranchId: item.projectBranchId,
          assayerId: c.id,
          proposedFee: c.baseFee ?? undefined,
          remarks: `Reassigned from the Operations Inbox (previous: ${item.assayerName ?? 'n/a'})`,
        }),
      });
      onOffered(c.displayName);
    } catch (err: any) {
      setError(err?.message || 'Could not create the offer.');
      setBusyId(null);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', justifyContent: 'flex-end', zIndex: 1000 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(420px, 100%)', height: '100%', overflowY: 'auto', background: 'var(--bg-primary)', borderLeft: '1px solid var(--border-color)', padding: '18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>Find a replacement</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
              {item.branchName}{item.branchCity ? ` · ${item.branchCity}` : ''} — the engine's ranked candidates. One click sends the offer.
            </div>
          </div>
          <button onClick={onClose} className="btn btn-secondary" style={{ padding: '6px', lineHeight: 0 }} aria-label="Close"><X size={15} /></button>
        </div>

        {error && <AlertBanner type="error" message={error} onClose={() => setError(null)} />}

        {!item.branchId ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '12.5px' }}>This item carries no branch reference — open planning instead.</div>
        ) : isLoading ? (
          <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
            <span className="spinner" style={{ display: 'inline-block', marginBottom: 8 }} /> Ranking candidates…
          </div>
        ) : candidates.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '12.5px' }}>No eligible candidates — open planning to widen the filters.</div>
        ) : (
          candidates.map((c, i) => (
            <div key={c.id} className="glass-card" style={{ padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  <span style={{ color: 'var(--text-muted)', fontWeight: 800, marginRight: 6 }}>#{i + 1}</span>
                  {c.displayName}
                  {c.score != null && <span style={{ marginLeft: 6, fontSize: '10.5px', fontWeight: 800, color: 'var(--success)' }}>{Math.round(c.score)}%</span>}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  {c.distanceKm != null ? `${c.distanceKm} km` : 'distance n/a'} · base {inr(c.baseFee)}
                </div>
              </div>
              <button onClick={() => offer(c)} disabled={busyId != null}
                className="btn btn-primary" style={{ padding: '5px 12px', fontSize: '11.5px', flexShrink: 0 }}>
                {busyId === c.id ? 'Offering…' : 'Offer'}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OperationsInbox;
