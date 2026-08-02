import React, { useEffect, useRef, useState } from 'react';
import { Send, X, Image as ImageIcon, CornerUpLeft, CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';

import { api } from '../../services/api';
import type { RegionCapture, Region } from './PdfRegionViewer';

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

const label: React.CSSProperties = {
  fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)',
};

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
      setErr((e as Error).message);
    }
    setBusy(false);
  };

  const resolve = async () => {
    setBusy(true);
    try {
      await api.request(`/validation-queries/${queryId}/resolve`, { method: 'POST' });
      onResolved?.();
      load();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const resolved = status === 'RESOLVED';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {!resolved && (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={resolve} disabled={busy} className="btn btn-secondary"
            style={{ fontSize: '11px', padding: '5px 9px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <CheckCircle2 size={12} /> Resolve
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 13px', minHeight: 0 }}>
        {messages === null && <Muted>Loading conversation…</Muted>}
        {messages?.length === 0 && (
          <Muted>Nothing said yet. Mark the area you have a question about, then send — the assayer sees the same crop.</Muted>
        )}
        {messages?.map((m) => {
          const mine = m.authorType === 'STAFF';
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', marginBottom: '10px' }}>
              <div style={{
                maxWidth: '86%', padding: '8px 10px', borderRadius: '10px', fontSize: '12.5px',
                background: mine ? 'var(--status-pending-bg)' : 'var(--bg-surface-2)',
                border: `1px solid ${mine ? 'var(--status-pending-bg)' : 'var(--border-color)'}`,
              }}>
                <div style={{ ...label, marginBottom: '4px' }}>
                  {m.authorName ?? (mine ? 'Data entry' : 'Assayer')} · {fmtWhen(m.createdAt)}
                </div>

                {m.pageNumber && (
                  <button
                    onClick={() => onFocusRegion({ pageNumber: m.pageNumber!, region: m.region })}
                    title="Show this on the document"
                    style={{
                      display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '6px',
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                      color: 'var(--warning)', fontSize: '11px', fontWeight: 600,
                    }}>
                    <CornerUpLeft size={11} /> page {m.pageNumber}
                  </button>
                )}

                {m.snapshotPath && (
                  <img
                    src={m.snapshotPath}
                    alt={`Marked area on page ${m.pageNumber}`}
                    onClick={() => m.pageNumber && onFocusRegion({ pageNumber: m.pageNumber, region: m.region })}
                    style={{ maxWidth: '100%', borderRadius: '6px', marginBottom: '6px', cursor: 'pointer', border: '1px solid var(--border-color)' }}
                  />
                )}

                {m.body && <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>}

                {(m.attachments ?? []).map((a) => (
                  <a key={a.url} href={a.url} target="_blank" rel="noreferrer"
                    style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--accent)', marginTop: '5px' }}>
                    <ImageIcon size={11} /> {a.fileName}
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

const Muted: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', padding: '16px 0' }}>{children}</div>
);

export default ThreadPanel;
