import React, { useEffect, useRef, useState } from 'react';
import { Send, Loader2, AlertTriangle, MessageSquare, Lock } from 'lucide-react';

import { connectSocket, getSocket } from '../../services/socket';
import { userMessage } from '../../services/errors';
import { getMessages, postMessage, markThreadRead, type FeedbackMessage } from '../../services/feedback';
import { fmtWhen } from './feedbackUi';

/**
 * One feedback thread's conversation: message feed + composer.
 *
 * Mirrors the assayer clarification ThreadPanel — socket-driven reload, Enter to
 * send, Shift+Enter for a newline — with reporter/team sides in place of
 * assayer/desk. The team gets an "internal note" toggle; those messages render with
 * a lock and never reach the reporter (the API filters them out server-side too).
 */
interface Props {
  threadId: string;
  isTeam: boolean;
  onChanged?: () => void;
}

export const FeedbackThreadPanel: React.FC<Props> = ({ threadId, isTeam, onChanged }) => {
  const [messages, setMessages] = useState<FeedbackMessage[] | null>(null);
  const [draft, setDraft] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const load = () => {
    getMessages(threadId)
      .then((m) => setMessages(Array.isArray(m) ? m : []))
      .catch(() => setMessages([]));
  };

  useEffect(() => {
    setMessages(null);
    load();
    markThreadRead(threadId).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // Live thread: join this thread's room and reload on every posted message.
  useEffect(() => {
    const socket = connectSocket() ?? getSocket();
    if (!socket) return;
    socket.emit('subscribe:feedback', threadId);
    const onEvent = (p: { threadId?: string }) => { if (p?.threadId === threadId) load(); };
    socket.on('feedback:message', onEvent);
    socket.on('feedback:updated', onEvent);
    return () => {
      socket.emit('unsubscribe:feedback', threadId);
      socket.off('feedback:message', onEvent);
      socket.off('feedback:updated', onEvent);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const send = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await postMessage(threadId, draft.trim(), isTeam && internal);
      setDraft('');
      load();
      onChanged?.();
    } catch (e) {
      setErr(userMessage(e));
    }
    setBusy(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--bg-surface)' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {messages === null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)', fontSize: '12.5px', padding: '20px 0' }}>
            <Loader2 size={15} className="spin" /> Loading conversation…
          </div>
        )}
        {messages?.length === 0 && (
          <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12.5px' }}>
            <MessageSquare size={24} style={{ opacity: 0.3, marginBottom: '8px' }} />
            <div>No messages yet.</div>
          </div>
        )}

        {messages?.map((m) => {
          if (m.authorType === 'SYSTEM') {
            return (
              <div key={m.id} style={{ alignSelf: 'center', maxWidth: '90%', textAlign: 'center' }}>
                <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', fontStyle: 'italic', padding: '4px 10px', background: 'var(--bg-surface-2)', borderRadius: '8px', display: 'inline-block' }}>
                  {m.body} · {fmtWhen(m.createdAt)}
                </div>
              </div>
            );
          }
          const mine = m.authorType === 'TEAM'; // right-align the team's side in the team view
          const rightAlign = isTeam ? m.authorType === 'TEAM' : m.authorType === 'REPORTER';
          return (
            <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: rightAlign ? 'flex-end' : 'flex-start' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600 }}>
                <span style={{
                  padding: '1px 5px', borderRadius: '4px', fontSize: '9.5px', fontWeight: 700,
                  background: m.authorType === 'TEAM' ? 'rgba(59,130,246,0.15)' : 'rgba(168,85,247,0.15)',
                  color: m.authorType === 'TEAM' ? '#3b82f6' : '#a855f7',
                }}>
                  {m.authorType === 'TEAM' ? 'PRODUCT TEAM' : 'REPORTER'}
                </span>
                <span>{m.authorName ?? '—'}</span>
                <span>·</span>
                <span>{fmtWhen(m.createdAt)}</span>
                {m.isInternal && (
                  <span title="Internal note — not visible to the reporter" style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', color: 'var(--warning)' }}>
                    <Lock size={10} /> internal
                  </span>
                )}
              </div>
              <div style={{
                maxWidth: '85%', padding: '10px 14px', borderRadius: '12px', fontSize: '13px', lineHeight: 1.45,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                background: m.isInternal ? 'rgba(234,179,8,0.12)' : mine ? 'var(--accent)' : 'var(--bg-surface-2)',
                color: mine && !m.isInternal ? '#ffffff' : 'inherit',
                border: m.isInternal ? '1px dashed var(--warning)' : mine ? 'none' : '1px solid var(--border-color)',
              }}>
                {m.body}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {err && (
        <div style={{ padding: '7px 13px', fontSize: '11.5px', color: 'var(--danger)', display: 'flex', gap: '6px', alignItems: 'center' }}>
          <AlertTriangle size={12} /> {err}
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--border-color)', padding: '10px 13px' }}>
        {isTeam && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11.5px', color: 'var(--text-secondary)', marginBottom: '8px', cursor: 'pointer' }}>
            <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
            <Lock size={11} /> Internal note (team only)
          </label>
        )}
        <div style={{ display: 'flex', gap: '7px' }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={isTeam ? (internal ? 'Note for the team…' : 'Reply to the reporter…') : 'Add to the conversation…'}
            rows={2}
            style={{
              flex: 1, resize: 'none', padding: '8px 10px', fontSize: '12.5px', borderRadius: '8px',
              background: internal ? 'rgba(234,179,8,0.08)' : 'var(--bg-input)', color: 'inherit',
              border: `1px solid ${internal ? 'var(--warning)' : 'var(--border-color)'}`, outline: 'none',
            }}
          />
          <button onClick={send} disabled={busy || !draft.trim()} className="btn btn-primary" style={{ padding: '8px 13px', alignSelf: 'stretch' }}>
            {busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
};

export default FeedbackThreadPanel;
