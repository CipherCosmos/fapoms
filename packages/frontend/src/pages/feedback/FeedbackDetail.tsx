import React, { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, RotateCcw, Sparkles, Copy, MapPin, Users, Clock } from 'lucide-react';
import { FeedbackCategory, FeedbackSeverity, FeedbackStatus } from '@fapoms/shared';

import {
  getThread, triageFeedback, resolveFeedback, reopenFeedback, voteFeedback,
  type FeedbackThread,
} from '../../services/feedback';
import { userMessage } from '../../services/errors';
import { CATEGORY, SEVERITY, STATUS, Badge, fmtDay, label } from './feedbackUi';
import { FeedbackThreadPanel } from './FeedbackThreadPanel';

interface Props {
  threadId: string;
  isTeam: boolean;
  assignees: { id: string; name: string }[];
  onChanged?: () => void;
  onOpenThread?: (id: string) => void;
}

const selectStyle: React.CSSProperties = {
  padding: '5px 8px', fontSize: '12px', fontWeight: 600, borderRadius: '7px',
  background: 'var(--bg-input)', color: 'inherit', border: '1px solid var(--border-color)', outline: 'none', cursor: 'pointer',
};

export const FeedbackDetail: React.FC<Props> = ({ threadId, isTeam, assignees, onChanged, onOpenThread }) => {
  const [thread, setThread] = useState<FeedbackThread | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [voting, setVoting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    setMissing(false);
    getThread(threadId).then(setThread).catch(() => { setThread(null); setMissing(true); });
  };
  useEffect(() => { setThread(null); load(); /* eslint-disable-next-line */ }, [threadId]);

  const vote = async () => {
    setVoting(true);
    try {
      const res = await voteFeedback(threadId);
      setThread((prev) => (prev ? { ...prev, hasVoted: res.voted, voteCount: res.voteCount } : prev));
      onChanged?.();
    } catch (e) { setErr(userMessage(e)); }
    setVoting(false);
  };

  const patch = async (fn: () => Promise<FeedbackThread>) => {
    setBusy(true); setErr(null);
    try { await fn(); load(); onChanged?.(); } catch (e) { setErr(userMessage(e)); }
    setBusy(false);
  };

  if (missing) {
    return <div style={{ padding: '24px', color: 'var(--text-muted)', fontSize: '13px' }}>This item is no longer available — it may have been removed.</div>;
  }
  if (!thread) {
    return <div style={{ padding: '24px', color: 'var(--text-muted)', fontSize: '13px', display: 'flex', gap: '8px', alignItems: 'center' }}><Loader2 size={15} className="spin" /> Loading…</div>;
  }

  const ai = thread.aiMeta;
  const route = (thread.appContext?.route as string | undefined) ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Thread header */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-surface-2)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '15px', fontWeight: 700, lineHeight: 1.3 }}>{thread.title}</div>
            <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '3px' }}>
              {thread.reporterName}{thread.reporterRole ? ` · ${thread.reporterRole}` : ''} · reported {fmtDay(thread.createdAt)}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Badge chip={CATEGORY[thread.category]} />
            <Badge chip={SEVERITY[thread.severity]} />
            <Badge chip={STATUS[thread.status]} />
          </div>
        </div>

        <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', fontSize: '11px', color: 'var(--text-muted)' }}>
          {(route || thread.area) && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}><MapPin size={12} /> {route ?? thread.area}</span>
          )}
          {/* First-response SLA state — the reporter's wait, closed once the team replies. */}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color: thread.firstRespondedAt ? 'var(--success)' : 'var(--warning)' }}>
            <Clock size={12} /> {thread.firstRespondedAt ? 'Team responded' : 'Awaiting first response'}
          </span>
          {/* Impact: how many people this affects, and a one-click "me too". */}
          <button onClick={vote} disabled={voting} title={thread.hasVoted ? 'Remove your vote' : 'I hit this too'} style={{
            display: 'inline-flex', alignItems: 'center', gap: '5px', cursor: 'pointer',
            padding: '3px 9px', borderRadius: '999px', fontSize: '11px', fontWeight: 700,
            background: thread.hasVoted ? 'var(--accent-soft)' : 'var(--bg-surface)',
            color: thread.hasVoted ? 'var(--accent-primary)' : 'var(--text-secondary)',
            border: `1px solid ${thread.hasVoted ? 'var(--accent-primary)' : 'var(--border-color)'}`,
          }}>
            {voting ? <Loader2 size={11} className="spin" /> : <Users size={11} />} {thread.voteCount} affected
          </button>
        </div>

        {/* Team-only: AI signal + triage controls */}
        {isTeam && (
          <>
            {ai && (ai.confidence !== undefined || (ai.keywords?.length ?? 0) > 0) && (
              <div style={{ marginTop: '10px', padding: '8px 10px', borderRadius: '8px', background: 'var(--bg-surface)', border: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', ...label, marginBottom: '5px' }}>
                  <Sparkles size={11} /> AI suggestion
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                  {ai.suggestedCategory && <>Read as <b>{CATEGORY[ai.suggestedCategory].label}</b> · </>}
                  {ai.suggestedSeverity && <><b>{SEVERITY[ai.suggestedSeverity].label}</b> severity · </>}
                  {ai.confidence !== undefined && <>confidence {Math.round((ai.confidence ?? 0) * 100)}%</>}
                </div>
                {(ai.keywords?.length ?? 0) > 0 && (
                  <div style={{ marginTop: '6px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {ai.keywords!.map((k) => (
                      <span key={k} style={{ fontSize: '10.5px', padding: '1px 6px', borderRadius: '4px', background: 'var(--bg-surface-2)', color: 'var(--text-muted)' }}>{k}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {(thread.duplicateCandidates?.length ?? 0) > 0 && (
              <div style={{ marginTop: '8px', padding: '8px 10px', borderRadius: '8px', background: 'rgba(234,179,8,0.08)', border: '1px dashed var(--warning)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', ...label, color: 'var(--warning)', marginBottom: '5px' }}>
                  <Copy size={11} /> Possible duplicates
                </div>
                {thread.duplicateCandidates!.map((d) => (
                  <button key={d.id} onClick={() => onOpenThread?.(d.id)} style={{ display: 'block', textAlign: 'left', width: '100%', background: 'none', border: 'none', color: 'var(--accent)', fontSize: '12px', cursor: 'pointer', padding: '2px 0' }}>
                    {d.title}
                  </button>
                ))}
              </div>
            )}

            <div style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
              <select style={selectStyle} value={thread.status} disabled={busy}
                onChange={(e) => patch(() => triageFeedback(thread.id, { status: e.target.value as FeedbackStatus }))}>
                {Object.values(FeedbackStatus).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
              </select>
              <select style={selectStyle} value={thread.severity} disabled={busy}
                onChange={(e) => patch(() => triageFeedback(thread.id, { severity: e.target.value as FeedbackSeverity }))}>
                {Object.values(FeedbackSeverity).map((s) => <option key={s} value={s}>{SEVERITY[s].label}</option>)}
              </select>
              <select style={selectStyle} value={thread.category} disabled={busy}
                onChange={(e) => patch(() => triageFeedback(thread.id, { category: e.target.value as FeedbackCategory }))}>
                {Object.values(FeedbackCategory).map((c) => <option key={c} value={c}>{CATEGORY[c].label}</option>)}
              </select>
              <select style={selectStyle} value={thread.assignedToUserId ?? ''} disabled={busy}
                onChange={(e) => patch(() => triageFeedback(thread.id, { assignedToUserId: e.target.value || null }))}>
                <option value="">Unassigned</option>
                {assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              {thread.status === FeedbackStatus.RESOLVED || thread.status === FeedbackStatus.CLOSED ? (
                <button className="btn btn-secondary" disabled={busy} onClick={() => patch(() => reopenFeedback(thread.id))} style={{ fontSize: '12px', padding: '5px 10px', display: 'flex', gap: '5px', alignItems: 'center' }}>
                  <RotateCcw size={13} /> Reopen
                </button>
              ) : (
                <button className="btn btn-secondary" disabled={busy} onClick={() => patch(() => resolveFeedback(thread.id))} style={{ fontSize: '12px', padding: '5px 10px', display: 'flex', gap: '5px', alignItems: 'center' }}>
                  <CheckCircle2 size={13} /> Resolve
                </button>
              )}
              {busy && <Loader2 size={14} className="spin" style={{ color: 'var(--text-muted)' }} />}
            </div>
          </>
        )}
        {err && <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--danger)' }}>{err}</div>}
      </div>

      {/* Conversation */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <FeedbackThreadPanel threadId={thread.id} isTeam={isTeam} onChanged={() => { load(); onChanged?.(); }} />
      </div>
    </div>
  );
};

export default FeedbackDetail;
