import React, { useEffect, useRef, useState } from 'react';
import { Send, X, Image as ImageIcon, CornerUpLeft, CheckCircle2, Loader2, AlertTriangle, MessageSquare, RotateCcw } from 'lucide-react';

import { api } from '../../services/api';
import type { RegionCapture, Region } from './PdfRegionViewer';
import { userMessage } from '../../services/errors';

/**
 * One clarification thread: messages, composer, resolve.
 *
 * Pulled out of what used to be ClarificationWorkspace so a case with several
 * open clarifications can render each one without duplicating the message list
 * and composer per thread. The PDF stays owned by the parent (CaseWorkspace) so
 * marking a region and picking which thread to attach it to are independent —
 * you mark first, then choose or start the conversation it belongs to.
 */

export interface ThreadMessage {
  id: string;
  authorType: 'STAFF' | 'ASSAYER';
  authorName: string | null;
  body: string | null;
  attachments: { url: string; fileName: string; fileType: string }[] | null;
  pageNumber: number | null;
  region: Region | null;
  snapshotPath: string | null;
  createdAt: string;
}

interface Props {
  queryId: string;
  status?: string;
  /** A region just marked on the PDF, offered up to attach to the next message. */
  pending: RegionCapture | null;
  onClearPending: () => void;
  onFocusRegion: (f: { pageNumber: number; region: Region | null }) => void;
  onResolved?: () => void;
  onChanged?: () => void;
}

const fmtWhen = (d: string) =>
  new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });


export const ThreadPanel: React.FC<Props> = ({
  queryId, status, pending, onClearPending, onFocusRegion, onResolved, onChanged,
}) => {
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const load = () => {
    api.request<ThreadMessage[]>(`/validation-queries/${queryId}/messages`)
      .then((m) => setMessages(Array.isArray(m) ? m : []))
      .catch(() => setMessages([]));
  };

  useEffect(() => { setMessages(null); load(); }, [queryId]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const send = async () => {
    if (!draft.trim() && !pending) return;
    setBusy(true);
    setErr(null);
    try {
      let snapshotPath: string | undefined;
      if (pending) {
        const fd = new FormData();
        fd.append('file', pending.blob, `region-p${pending.pageNumber}.png`);
        const up = await api.request<any>('/validation-queries/upload-single', { method: 'POST', body: fd });
        snapshotPath = up?.url ?? up?.data?.url;
      }
      await api.request(`/validation-queries/${queryId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          body: draft.trim() || undefined,
          pageNumber: pending?.pageNumber,
          region: pending?.region,
          snapshotPath,
        }),
      });
      setDraft('');
      onClearPending();
      load();
      onChanged?.();
    } catch (e) {
      setErr(userMessage(e));
    }
    setBusy(false);
  };

  const resolve = async () => {
    setBusy(true);
    try {
      await api.request(`/validation-queries/${queryId}/resolve`, { method: 'POST' });
      onResolved?.();
      load();
    } catch (e) { setErr(userMessage(e)); }
    setBusy(false);
  };

  // A resolution can be wrong; reopening returns the query to the assayer and keeps the thread
  // rather than forcing a brand-new query that loses the conversation.
  const reopen = async () => {
    setBusy(true);
    try {
      await api.request(`/validation-queries/${queryId}/reopen`, { method: 'POST' });
      onResolved?.();
      load();
    } catch (e) { setErr(userMessage(e)); }
    setBusy(false);
  };

  const resolved = status === 'RESOLVED';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--bg-surface)' }}>
      {/* Header / Actions Bar */}
      <div style={{
        padding: '10px 14px', borderBottom: '1px solid var(--border-color)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'var(--bg-surface-2)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{
            fontSize: '11px', fontWeight: 700, padding: '3px 8px', borderRadius: '12px',
            background: resolved ? 'rgba(34, 197, 94, 0.15)' : 'rgba(234, 179, 8, 0.15)',
            color: resolved ? 'var(--success)' : 'var(--warning)',
            display: 'inline-flex', alignItems: 'center', gap: '4px',
          }}>
            {resolved ? <CheckCircle2 size={12} /> : <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warning)' }} />}
            {resolved ? 'RESOLVED' : 'ACTIVE CLARIFICATION'}
          </span>
        </div>

        {!resolved ? (
          <button onClick={resolve} disabled={busy} className="btn btn-secondary"
            style={{ fontSize: '11px', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: '5px', fontWeight: 600 }}>
            {busy ? <Loader2 size={12} className="spin" /> : <CheckCircle2 size={12} />} Mark Resolved
          </button>
        ) : (
          <button onClick={reopen} disabled={busy} className="btn btn-secondary"
            title="Return this clarification to the assayer and continue the thread"
            style={{ fontSize: '11px', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: '5px', fontWeight: 600 }}>
            {busy ? <Loader2 size={12} className="spin" /> : <RotateCcw size={12} />} Reopen
          </button>
        )}
      </div>

      {/* Messages Feed */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', minHeight: 0, display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {messages === null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)', fontSize: '12.5px', padding: '20px 0' }}>
            <Loader2 size={15} className="spin" /> Loading message history…
          </div>
        )}
        {messages?.length === 0 && (
          <div style={{
            padding: '24px 16px', textAlign: 'center', borderRadius: '10px',
            background: 'var(--bg-surface-2)', border: '1px border-dashed var(--border-color)',
            color: 'var(--text-muted)', fontSize: '12.5px',
          }}>
            <MessageSquare size={24} style={{ opacity: 0.3, marginBottom: '8px' }} />
            <div>No messages yet in this clarification thread.</div>
            <div style={{ fontSize: '11.5px', marginTop: '4px' }}>
              Mark an area on the PDF or type below to send your query to the field assayer.
            </div>
          </div>
        )}

        {messages?.map((m) => {
          const isStaff = m.authorType === 'STAFF';
          return (
            <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: isStaff ? 'flex-end' : 'flex-start' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px',
                fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600,
              }}>
                <span style={{
                  padding: '1px 5px', borderRadius: '4px', fontSize: '9.5px', fontWeight: 700,
                  background: isStaff ? 'rgba(59, 130, 246, 0.15)' : 'rgba(168, 85, 247, 0.15)',
                  color: isStaff ? '#3b82f6' : '#a855f7',
                }}>
                  {isStaff ? 'DATA ENTRY' : 'ASSAYER'}
                </span>
                <span>{m.authorName ?? (isStaff ? 'Data Entry Staff' : 'Field Assayer')}</span>
                <span>·</span>
                <span>{fmtWhen(m.createdAt)}</span>
              </div>

              <div style={{
                maxWidth: '85%', padding: '10px 14px', borderRadius: '12px', fontSize: '13px', lineHeight: 1.45,
                background: isStaff ? 'var(--accent)' : 'var(--bg-surface-2)',
                color: isStaff ? '#ffffff' : 'inherit',
                border: isStaff ? 'none' : '1px solid var(--border-color)',
                borderTopRightRadius: isStaff ? '2px' : '12px',
                borderTopLeftRadius: isStaff ? '12px' : '2px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
              }}>
                {m.pageNumber && (
                  <button
                    onClick={() => onFocusRegion({ pageNumber: m.pageNumber!, region: m.region })}
                    title="Focus marked area on document"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '5px', marginBottom: '8px',
                      padding: '4px 8px', borderRadius: '6px', cursor: 'pointer',
                      background: isStaff ? 'rgba(255,255,255,0.2)' : 'rgba(234,179,8,0.15)',
                      color: isStaff ? '#ffffff' : 'var(--warning)',
                      border: 'none', fontSize: '11px', fontWeight: 700,
                    }}>
                    <CornerUpLeft size={12} /> Jump to Page {m.pageNumber}
                  </button>
                )}

                {m.snapshotPath && (
                  <div style={{ marginBottom: '8px', overflow: 'hidden', borderRadius: '8px', border: '1px solid rgba(0,0,0,0.1)' }}>
                    <img
                      src={m.snapshotPath}
                      alt={`Marked crop on page ${m.pageNumber}`}
                      onClick={() => m.pageNumber && onFocusRegion({ pageNumber: m.pageNumber, region: m.region })}
                      style={{ maxWidth: '100%', display: 'block', cursor: 'pointer' }}
                    />
                  </div>
                )}

                {m.body && <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</div>}

                {(m.attachments ?? []).map((a) => (
                  <a key={a.url} href={a.url} target="_blank" rel="noreferrer"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11.5px',
                      marginTop: '8px', padding: '4px 8px', borderRadius: '6px',
                      background: isStaff ? 'rgba(255,255,255,0.2)' : 'var(--bg-surface)',
                      color: isStaff ? '#ffffff' : 'var(--accent)', textDecoration: 'none',
                    }}>
                    <ImageIcon size={12} /> {a.fileName}
                  </a>
                ))}
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

      {resolved ? (
        <div style={{ padding: '11px 13px', borderTop: '1px solid var(--border-color)', fontSize: '12px', color: 'var(--success)', display: 'flex', gap: '6px', alignItems: 'center' }}>
          <CheckCircle2 size={14} /> Resolved.
        </div>
      ) : (
        <div style={{ borderTop: '1px solid var(--border-color)', padding: '10px 13px' }}>
          {pending && (
            <div style={{
              display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px', padding: '7px',
              borderRadius: '8px', background: 'var(--status-active-bg)', border: '1px solid var(--status-active-bg)',
            }}>
              <img src={pending.dataUrl} alt="Marked area" style={{ height: '42px', borderRadius: '4px' }} />
              <div style={{ fontSize: '11px', flex: 1 }}>
                Marked area on page {pending.pageNumber}
                <div style={{ color: 'var(--text-muted)' }}>attached to this message</div>
              </div>
              <button onClick={onClearPending} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                <X size={14} />
              </button>
            </div>
          )}
          <div style={{ display: 'flex', gap: '7px' }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={pending ? 'What is wrong with this area?' : 'Ask the assayer…'}
              rows={2}
              style={{
                flex: 1, resize: 'none', padding: '8px 10px', fontSize: '12.5px', borderRadius: '8px',
                background: 'var(--bg-input)', color: 'inherit',
                border: '1px solid var(--border-color)', outline: 'none',
              }}
            />
            <button onClick={send} disabled={busy || (!draft.trim() && !pending)} className="btn btn-primary"
              style={{ padding: '8px 13px', alignSelf: 'stretch' }}>
              {busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ThreadPanel;
