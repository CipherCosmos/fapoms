import React, { useState } from 'react';
import { Loader2, CheckCircle2, RotateCcw, Sparkles, Copy, MapPin, Users, Clock, User as UserIcon } from 'lucide-react';
import { FeedbackCategory, FeedbackSeverity, FeedbackStatus } from '@fapoms/shared';

import { triageFeedback, resolveFeedback, reopenFeedback, voteFeedback, type FeedbackThread } from '../../services/feedback';
import { userMessage } from '../../services/errors';
import { CATEGORY, SEVERITY, STATUS, Badge, fmtDay, label } from './feedbackUi';

/**
 * The right-hand properties rail for one feedback item on the team desk.
 *
 * Everything about an item that is *not* the conversation lives here — status,
 * severity, category, assignee, SLA state, impact, the AI read, and possible
 * duplicates — so the conversation itself gets the full height of the centre pane
 * instead of being pushed below a stack of controls.
 */
interface Props {
  thread: FeedbackThread;
  assignees: { id: string; name: string }[];
  onChanged: () => void;
  onOpenThread?: (id: string) => void;
}

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '7px 9px', fontSize: '12.5px', fontWeight: 600, borderRadius: '8px',
  background: 'var(--bg-input)', color: 'inherit', border: '1px solid var(--border-color)', outline: 'none', cursor: 'pointer',
};
const fieldLabel: React.CSSProperties = { ...label, display: 'block', marginBottom: '5px' };

export const FeedbackProperties: React.FC<Props> = ({ thread, assignees, onChanged, onOpenThread }) => {
  const [busy, setBusy] = useState(false);
  const [voting, setVoting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const patch = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); onChanged(); } catch (e) { setErr(userMessage(e)); }
    setBusy(false);
  };
  const vote = async () => {
    setVoting(true);
    try { await voteFeedback(thread.id); onChanged(); } catch (e) { setErr(userMessage(e)); }
    setVoting(false);
  };

  const ai = thread.aiMeta;
  const route = (thread.appContext?.route as string | undefined) ?? null;
  const settled = thread.status === FeedbackStatus.RESOLVED || thread.status === FeedbackStatus.CLOSED;

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '14px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/* Status chips + primary action */}
      <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
        <Badge chip={CATEGORY[thread.category]} />
        <Badge chip={SEVERITY[thread.severity]} />
        <Badge chip={STATUS[thread.status]} />
      </div>

      {/* Impact + SLA + context */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
        <button onClick={vote} disabled={voting} title={thread.hasVoted ? 'Remove your vote' : 'I hit this too'} style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', alignSelf: 'flex-start',
          padding: '4px 11px', borderRadius: '999px', fontSize: '12px', fontWeight: 700,
          background: thread.hasVoted ? 'var(--accent-soft)' : 'var(--bg-surface-2)',
          color: thread.hasVoted ? 'var(--accent-primary)' : 'var(--text-secondary)',
          border: `1px solid ${thread.hasVoted ? 'var(--accent-primary)' : 'var(--border-color)'}`,
        }}>
          {voting ? <Loader2 size={12} className="spin" /> : <Users size={12} />} {thread.voteCount} affected
        </button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: thread.firstRespondedAt ? 'var(--success)' : 'var(--warning)' }}>
          <Clock size={13} /> {thread.firstRespondedAt ? 'Team has responded' : 'Awaiting first response'}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><UserIcon size={13} /> {thread.reporterName}{thread.reporterRole ? ` · ${thread.reporterRole}` : ''}</span>
        {(route || thread.area) && <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><MapPin size={13} /> {route ?? thread.area}</span>}
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Reported {fmtDay(thread.createdAt)}</span>
      </div>

      <div style={{ height: 1, background: 'var(--border-color)' }} />

      {/* Triage controls */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '11px' }}>
        <div>
          <span style={fieldLabel}>Status</span>
          <select style={selectStyle} value={thread.status} disabled={busy} onChange={(e) => patch(() => triageFeedback(thread.id, { status: e.target.value as FeedbackStatus }))}>
            {Object.values(FeedbackStatus).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <div style={{ flex: 1 }}>
            <span style={fieldLabel}>Severity</span>
            <select style={selectStyle} value={thread.severity} disabled={busy} onChange={(e) => patch(() => triageFeedback(thread.id, { severity: e.target.value as FeedbackSeverity }))}>
              {Object.values(FeedbackSeverity).map((s) => <option key={s} value={s}>{SEVERITY[s].label}</option>)}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <span style={fieldLabel}>Type</span>
            <select style={selectStyle} value={thread.category} disabled={busy} onChange={(e) => patch(() => triageFeedback(thread.id, { category: e.target.value as FeedbackCategory }))}>
              {Object.values(FeedbackCategory).map((c) => <option key={c} value={c}>{CATEGORY[c].label}</option>)}
            </select>
          </div>
        </div>
        <div>
          <span style={fieldLabel}>Assigned to</span>
          <select style={selectStyle} value={thread.assignedToUserId ?? ''} disabled={busy} onChange={(e) => patch(() => triageFeedback(thread.id, { assignedToUserId: e.target.value || null }))}>
            <option value="">Unassigned</option>
            {assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        {settled ? (
          <button className="btn btn-secondary" disabled={busy} onClick={() => patch(() => reopenFeedback(thread.id))} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
            <RotateCcw size={14} /> Reopen
          </button>
        ) : (
          <button className="btn btn-primary" disabled={busy} onClick={() => patch(() => resolveFeedback(thread.id))} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
            <CheckCircle2 size={14} /> Mark resolved
          </button>
        )}
        {busy && <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'inline-flex', gap: '5px', alignItems: 'center' }}><Loader2 size={12} className="spin" /> Saving…</span>}
        {err && <span style={{ fontSize: '12px', color: 'var(--danger)' }}>{err}</span>}
      </div>

      {/* AI read */}
      {ai && (ai.confidence !== undefined || (ai.keywords?.length ?? 0) > 0) && (
        <>
          <div style={{ height: 1, background: 'var(--border-color)' }} />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', ...label, marginBottom: '7px' }}><Sparkles size={11} /> AI suggestion</div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {ai.suggestedCategory && <>Read as <b>{CATEGORY[ai.suggestedCategory].label}</b> · </>}
              {ai.suggestedSeverity && <><b>{SEVERITY[ai.suggestedSeverity].label}</b> · </>}
              {ai.confidence !== undefined && <>{Math.round((ai.confidence ?? 0) * 100)}% confident</>}
            </div>
            {(ai.keywords?.length ?? 0) > 0 && (
              <div style={{ marginTop: '7px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {ai.keywords!.map((k) => <span key={k} style={{ fontSize: '10.5px', padding: '2px 7px', borderRadius: '5px', background: 'var(--bg-surface-2)', color: 'var(--text-muted)' }}>{k}</span>)}
              </div>
            )}
          </div>
        </>
      )}

      {/* Possible duplicates */}
      {(thread.duplicateCandidates?.length ?? 0) > 0 && (
        <>
          <div style={{ height: 1, background: 'var(--border-color)' }} />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', ...label, color: 'var(--warning)', marginBottom: '7px' }}><Copy size={11} /> Possible duplicates</div>
            {thread.duplicateCandidates!.map((d) => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                <button onClick={() => onOpenThread?.(d.id)} style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', color: 'var(--accent)', fontSize: '12px', cursor: 'pointer', padding: 0 }}>{d.title}</button>
                <button onClick={() => patch(() => triageFeedback(thread.id, { duplicateOfId: d.id }))} disabled={busy} title="Mark this a duplicate of that (merges impact, closes this)" className="btn btn-secondary" style={{ fontSize: '10.5px', padding: '3px 7px' }}>Merge</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export default FeedbackProperties;
