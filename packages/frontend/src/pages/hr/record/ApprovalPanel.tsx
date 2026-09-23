import React, { useCallback, useEffect, useState } from 'react';
import {
  AssayerLifecycleStatus, ONBOARDING_APPROVAL_STATUS_LABELS, OnboardingApprovalEventKind as Kind,
  OnboardingApprovalStatus as Status, approvalTextProblem, type OnboardingApprovalEvent,
} from '@fapoms/shared';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { fmtWhen } from '../hr-ui';

/** A round as the server gives it (`GET /assayers/:id/approval`). */
export interface ApprovalRound {
  id: string;
  round: number;
  status: Status;
  events: OnboardingApprovalEvent[];
  decidedAt: string | null;
  preparers: string[];
}

const EVENT_WORDS: Record<Kind, string> = {
  [Kind.SUBMITTED]: 'Sent for approval',
  [Kind.INFO_REQUESTED]: 'Asked HR for more',
  [Kind.ANSWERED]: 'HR answered',
  [Kind.APPROVED]: 'Approved',
  [Kind.REJECTED]: 'Not approved',
};

const STATUS_TONE: Record<Status, string> = {
  [Status.PENDING]: 'var(--warning)',
  [Status.INFO_REQUESTED]: 'var(--accent)',
  [Status.APPROVED]: 'var(--success)',
  [Status.REJECTED]: 'var(--danger)',
};

const box: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', minHeight: '64px', resize: 'vertical', padding: '8px 10px',
  fontSize: 'var(--text-sm)', border: '1px solid var(--border-color)', borderRadius: '8px',
  background: 'var(--bg-input, var(--bg-surface))', color: 'var(--text-primary)',
};
const btn = (tone: 'primary' | 'secondary' | 'danger'): React.CSSProperties => ({
  fontSize: 'var(--text-xs)', padding: '6px 12px',
  ...(tone === 'danger' ? { background: 'var(--danger)', color: '#fff', borderColor: 'var(--danger)' } : {}),
});

/** One round's conversation, in order. */
const Thread: React.FC<{ events: OnboardingApprovalEvent[] }> = ({ events }) => (
  <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
    {events.map((e, i) => (
      <li key={`${e.kind}-${e.at}-${i}`} style={{ fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          <strong style={{ color: 'var(--text-secondary)' }}>{EVENT_WORDS[e.kind] ?? e.kind}</strong>
          {e.byName ? ` · ${e.byName}` : ''} · {fmtWhen(e.at)}
        </div>
        {e.text && <div style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{e.text}</div>}
      </li>
    ))}
  </ol>
);

/**
 * THE APPROVAL BEFORE TRAINING, where it is decided.
 *
 * The approver (ASSAYER:APPROVE, never whoever sent it up or answered on it) approves, rejects with
 * the reason, or asks HR for more; HR answers here and it goes back to the approver. Every earlier
 * round — a rejection that was re-opened — stays underneath, so the record reads as what happened.
 * Renders nothing for somebody who has never been put up for approval.
 */
export const ApprovalPanel: React.FC<{
  assayerId: string;
  lifecycleStatus?: string | null;
  canManage: boolean;
  canApprove: boolean;
  currentUserId: string | null;
  /** After a decision or an answer — the person's stage may have moved. */
  onChanged: () => void;
}> = ({ assayerId, lifecycleStatus, canManage, canApprove, currentUserId, onChanged }) => {
  const [rounds, setRounds] = useState<ApprovalRound[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.request<ApprovalRound[]>(`/assayers/${assayerId}/approval`)
      // Anything but a list is "no rounds" — the panel then renders nothing, as for someone never sent up.
      .then((r) => setRounds(Array.isArray(r) ? r : []))
      .catch((e) => { setRounds([]); setError(`The approval could not be loaded. ${userMessage(e)}`); });
  }, [assayerId]);
  // Re-read whenever their stage changes — being sent up opens a round.
  useEffect(() => { load(); }, [load, lifecycleStatus]);

  if (!rounds || rounds.length === 0) return null;
  const [current, ...earlier] = rounds;
  const open = current.status === Status.PENDING || current.status === Status.INFO_REQUESTED;
  const awaiting = open && lifecycleStatus === AssayerLifecycleStatus.FINAL_APPROVAL;
  const preparer = !!currentUserId && current.preparers.includes(currentUserId);
  const mayDecide = awaiting && canApprove && !preparer;
  const mayAnswer = awaiting && current.status === Status.INFO_REQUESTED && canManage;

  const act = async (kind: Kind, path: string) => {
    const problem = approvalTextProblem(kind, text);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    try {
      await api.request(`/assayers/${assayerId}/approval/${path}`, {
        method: 'POST', body: JSON.stringify({ text: text.trim() || undefined }),
      });
      setText('');
      load();
      onChanged();
    } catch (e) { setError(userMessage(e)); } finally { setBusy(false); }
  };

  return (
    <section style={{
      background: 'var(--bg-card)', border: `1px solid ${awaiting ? 'var(--warning)' : 'var(--border-color)'}`,
      borderRadius: '10px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)' }}>
          Approval before training{rounds.length > 1 ? ` — round ${current.round}` : ''}
        </div>
        <span style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: STATUS_TONE[current.status] }}>
          {ONBOARDING_APPROVAL_STATUS_LABELS[current.status]}
        </span>
      </div>

      <Thread events={current.events} />

      {mayDecide && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label htmlFor="approval-text" style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-secondary)' }}>
            Your note — needed to ask for more or to reject; optional to approve
          </label>
          <textarea id="approval-text" style={box} value={text} disabled={busy} maxLength={2000}
            onChange={(e) => { setText(e.target.value); setError(null); }}
            placeholder="What you need from HR, or why they are not approved" />
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" style={btn('primary')} disabled={busy}
              onClick={() => void act(Kind.APPROVED, 'approve')}>Approve — on to training</button>
            <button type="button" className="btn btn-secondary" style={btn('secondary')} disabled={busy || current.status !== Status.PENDING}
              title={current.status !== Status.PENDING ? 'Waiting for HR to answer what was asked' : undefined}
              onClick={() => void act(Kind.INFO_REQUESTED, 'request-info')}>Ask HR for more</button>
            <button type="button" className="btn" style={btn('danger')} disabled={busy}
              onClick={() => void act(Kind.REJECTED, 'reject')}>Reject</button>
          </div>
        </div>
      )}

      {mayAnswer && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label htmlFor="approval-answer" style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-secondary)' }}>
            Your answer to the approver
          </label>
          <textarea id="approval-answer" style={box} value={text} disabled={busy} maxLength={2000}
            onChange={(e) => { setText(e.target.value); setError(null); }}
            placeholder="What was done, and where to find it (e.g. uploaded to Documents)" />
          <div>
            <button type="button" className="btn btn-primary" style={btn('primary')} disabled={busy}
              onClick={() => void act(Kind.ANSWERED, 'answer')}>Send back for approval</button>
          </div>
        </div>
      )}

      {awaiting && !mayDecide && !mayAnswer && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {canApprove && preparer
            ? 'You sent this person up for approval or answered on it, so somebody else has to decide it.'
            : current.status === Status.INFO_REQUESTED
              ? 'The approver asked HR for more — HR answers it here.'
              : 'Waiting for a senior to approve, reject or ask for more.'}
        </div>
      )}

      {error && <div role="alert" style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)' }}>{error}</div>}

      {earlier.length > 0 && (
        <details>
          <summary style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            Earlier {earlier.length === 1 ? 'round' : `${earlier.length} rounds`}
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '8px' }}>
            {earlier.map((r) => (
              <div key={r.id} style={{ borderTop: '1px solid var(--border-hair)', paddingTop: '8px' }}>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: STATUS_TONE[r.status], marginBottom: '6px' }}>
                  Round {r.round} — {ONBOARDING_APPROVAL_STATUS_LABELS[r.status]}
                </div>
                <Thread events={r.events} />
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
};

export default ApprovalPanel;
