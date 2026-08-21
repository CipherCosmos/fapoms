import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { MessageSquarePlus, X, Loader2, CheckCircle2, Sparkles, Users, Paperclip } from 'lucide-react';
import { FeedbackCategory } from '@fapoms/shared';

import {
  createFeedback, getSimilarFeedback, voteFeedback, uploadFeedbackAttachment,
  MAX_FEEDBACK_FILES, FEEDBACK_ACCEPT, formatFileSize,
  type SimilarFeedback, type FeedbackAttachment,
} from '../../services/feedback';
import { MAX_FEEDBACK_ATTACHMENT_MB } from '@fapoms/shared';
import { userMessage } from '../../services/errors';
import { CATEGORY, areaFromPath } from './feedbackUi';
import { useCurrentRoles } from '../../hooks/useCurrentRoles';
import { canAccessRoute } from '../../config/route-permissions';

/**
 * The always-available "send feedback" entry point.
 *
 * Lives in the header so every user — on any page — can report a bug, request a
 * feature or ask a question without hunting for a menu. It captures the route they
 * were on and their platform automatically, so the team can reproduce, and leaves
 * category detection to the classifier unless the reporter picks one.
 */
/**
 * One chosen file and how its upload is going.
 *
 * `uploaded` is set when the server has the file and returned its descriptor; until then the
 * row shows progress, and `error` replaces it if the upload was refused — by size, by type, or
 * by the connection.
 */
interface PendingAttachment {
  file: File;
  progress: number;
  uploaded?: FeedbackAttachment;
  error?: string;
  abort: AbortController;
}

export const FeedbackLauncher: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  /**
   * Whether this user can actually open /feedback, asked of ROUTE_PERMISSIONS rather than
   * assumed. The channel was narrowed to super administrators (2026-08-17) while the launcher
   * stayed available to everyone who can reach it — so "View my feedback" is a link that
   * ProtectedRoute would bounce straight back to the dashboard for anybody else, silently.
   *
   * Today Header.tsx only mounts this launcher when the same check passes, so the bounce is
   * not reachable in the shipped app. The check is repeated here because the component cannot
   * assume where it is mounted, and because the reporter view it links to is explicitly kept
   * "for the day the desk is widened again" (FeedbackPage.tsx) — the day one of those two
   * lists moves is exactly when a dead link would appear with nothing to catch it.
   *
   * When the user cannot follow the link, the reassurance it carried is given as text instead:
   * the report was received and a reply will arrive as a notification. Sending feedback stays
   * available to everyone — only *browsing the channel* is restricted.
   */
  const roles = useCurrentRoles();
  const canOpenChannel = canAccessRoute(roles, '/feedback');
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<FeedbackCategory | ''>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);
  const [similar, setSimilar] = useState<SimilarFeedback[]>([]);
  const [votedMsg, setVotedMsg] = useState<string | null>(null);
  /**
   * Attachments, uploading in the background as they are chosen.
   *
   * They used to be held until submit and uploaded inside it. That made Send do all the waiting:
   * the dialog locked behind one spinner for however long a multi-megabyte screenshot took over
   * whatever connection was available, with no progress and no way out. People read that as the
   * app hanging, and gave up — which aborted the request and left a 500 in the log for something
   * the server had done nothing wrong in.
   *
   * Uploading on pick moves the wait to where the person is not blocked by it: they carry on
   * typing while the bar fills, and Send posts a small piece of JSON. The trade is a file
   * uploaded for a report that is then abandoned — harmless, because an attachment no message
   * references is served to nobody and reachable by no one.
   */
  const [files, setFiles] = useState<PendingAttachment[]>([]);

  const reset = () => {
    setTitle(''); setBody(''); setCategory(''); setErr(null); setDoneId(null); setSimilar([]); setVotedMsg(null);
    setFiles([]);
  };
  const close = () => { setOpen(false); reset(); };

  // Dedup at the source: as the reporter describes the problem, look for open items that
  // already match so they can add their voice instead of filing a duplicate.
  useEffect(() => {
    if (doneId || body.trim().length < 12) { setSimilar([]); return; }
    const q = `${title} ${body}`.trim();
    const t = setTimeout(() => { getSimilarFeedback(q).then(setSimilar).catch(() => setSimilar([])); }, 500);
    return () => clearTimeout(t);
  }, [title, body, doneId]);

  /**
   * Take the picked files and start uploading them straight away.
   *
   * The ceiling and the type list are checked here so the fifth file, or a video, is refused
   * before anything is sent rather than after a long upload — but the server still decides:
   * this only saves the wait, it does not grant anything.
   */
  const addFiles = (picked: File[]) => {
    const room = MAX_FEEDBACK_FILES - files.length;
    if (room <= 0) {
      setErr(`A report can carry ${MAX_FEEDBACK_FILES} files.`);
      return;
    }
    const accepted = picked.slice(0, room);
    if (picked.length > room) setErr(`Only the first ${room} of those were added — a report can carry ${MAX_FEEDBACK_FILES}.`);

    for (const file of accepted) {
      const entry: PendingAttachment = { file, progress: 0, abort: new AbortController() };
      setFiles((prev) => [...prev, entry]);

      if (file.size > MAX_FEEDBACK_ATTACHMENT_MB * 1024 * 1024) {
        update(file, { error: `Too large — the limit is ${MAX_FEEDBACK_ATTACHMENT_MB} MB.` });
        continue;
      }

      uploadFeedbackAttachment(file, (fraction) => update(file, { progress: fraction }), entry.abort.signal)
        .then((uploaded) => update(file, { uploaded, progress: 1 }))
        .catch((e) => {
          // A cancelled upload is the person's own doing; the row is already gone.
          if ((e as DOMException)?.name === 'AbortError') return;
          update(file, { error: userMessage(e) });
        });
    }
  };

  /** Patch one row by identity — the list is re-created on every state change. */
  const update = (file: File, patch: Partial<PendingAttachment>) =>
    setFiles((prev) => prev.map((f) => (f.file === file ? { ...f, ...patch } : f)));

  const removeFile = (entry: PendingAttachment) => {
    entry.abort.abort();
    setFiles((prev) => prev.filter((f) => f !== entry));
  };

  const meToo = async (id: string) => {
    try {
      const res = await voteFeedback(id);
      setSimilar((prev) => prev.map((s) => (s.id === id ? { ...s, hasVoted: res.voted, voteCount: res.voteCount } : s)));
      if (res.voted) setVotedMsg('Added your vote — no need to file a new report.');
    } catch (e) { setErr(userMessage(e)); }
  };

  /** Still going up. Send waits for these rather than quietly filing the report without them. */
  const uploading = files.some((f) => !f.uploaded && !f.error);

  const submit = async () => {
    if (!body.trim()) { setErr('Please describe the issue or idea.'); return; }
    if (uploading) { setErr('One moment — an attachment is still uploading.'); return; }
    setBusy(true);
    setErr(null);
    try {
      // Whatever finished uploading. Anything still in flight or failed is named below rather
      // than silently dropped, and never blocks the report itself.
      const attachments = files.map((f) => f.uploaded).filter(Boolean) as FeedbackAttachment[];
      const thread = await createFeedback({
        title: title.trim() || undefined,
        body: body.trim(),
        category: category || undefined,
        attachments: attachments.length ? attachments : undefined,
        area: areaFromPath(location.pathname),
        appContext: {
          route: location.pathname + location.search,
          platform: 'web',
          userAgent: navigator.userAgent,
        },
      });
      setDoneId(thread.id);
    } catch (e) {
      setErr(userMessage(e));
    }
    setBusy(false);
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Send feedback to the product team"
        aria-label="Send feedback"
        style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          padding: '5px 11px', borderRadius: 'var(--radius-full)',
          background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
          color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        <MessageSquarePlus size={14} />
        <span className="feedback-launcher-label">Feedback</span>
      </button>

      {open && createPortal(
        <div
          onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
          }}
        >
          <div style={{
            width: '100%', maxWidth: '480px', background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', maxHeight: '90vh',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, fontSize: '14px' }}>
                <MessageSquarePlus size={16} style={{ color: 'var(--accent)' }} /> Send feedback
              </div>
              <button onClick={close} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={18} /></button>
            </div>

            {doneId ? (
              <div style={{ padding: '28px 20px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                <CheckCircle2 size={40} style={{ color: 'var(--success)' }} />
                <div style={{ fontSize: '15px', fontWeight: 700 }}>Thanks — the product team has it.</div>
                <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', maxWidth: '320px' }}>
                  {canOpenChannel
                    ? "You'll be notified when they reply. You can follow the conversation any time."
                    : "You'll get a notification here when the team replies — there is nothing else you need to do."}
                </div>
                <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                  {canOpenChannel && (
                    <button className="btn btn-secondary" onClick={() => { const id = doneId; close(); navigate(`/feedback?id=${id}`); }}>View my feedback</button>
                  )}
                  <button className="btn btn-primary" onClick={reset}>Send another</button>
                </div>
              </div>
            ) : (
              <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto' }}>
                <div>
                  <div style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '5px' }}>What kind of feedback?</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    <TypeChip active={category === ''} onClick={() => setCategory('')} label="Auto-detect" icon={<Sparkles size={12} />} />
                    {(Object.keys(CATEGORY) as FeedbackCategory[]).map((c) => (
                      <TypeChip key={c} active={category === c} onClick={() => setCategory(c)} label={CATEGORY[c].label} color={CATEGORY[c].fg} />
                    ))}
                  </div>
                </div>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  <span style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--text-secondary)' }}>Title <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></span>
                  <input
                    value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200}
                    placeholder="Short summary"
                    style={{ padding: '8px 10px', fontSize: '13px', borderRadius: '8px', background: 'var(--bg-input)', color: 'inherit', border: '1px solid var(--border-color)', outline: 'none' }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  <span style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--text-secondary)' }}>Details</span>
                  <textarea
                    value={body} onChange={(e) => setBody(e.target.value)} rows={5} autoFocus
                    placeholder="What happened, or what would help? The more detail, the faster we can act."
                    style={{ padding: '9px 11px', fontSize: '13px', borderRadius: '8px', resize: 'vertical', background: 'var(--bg-input)', color: 'inherit', border: '1px solid var(--border-color)', outline: 'none', lineHeight: 1.5 }}
                  />
                </label>

                {/*
                  * Attach a screenshot.
                  *
                  * Feedback is where somebody says "this screen is wrong", and a picture of the
                  * screen settles in one glance what a paragraph cannot. Files are held here
                  * until submit, so choosing one is instant and an abandoned report uploads
                  * nothing.
                  */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{
                    display: 'inline-flex', alignItems: 'center', gap: '6px', alignSelf: 'flex-start',
                    padding: '6px 11px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
                    border: '1px dashed var(--border-color)', color: 'var(--text-secondary)',
                  }}>
                    <Paperclip size={13} />
                    {files.length ? 'Add another' : 'Attach a screenshot or file'}
                    <input
                      type="file" multiple hidden
                      accept={FEEDBACK_ACCEPT}
                      onChange={(e) => {
                        const picked = Array.from(e.target.files ?? []);
                        e.target.value = '';
                        addFiles(picked);
                      }}
                    />
                  </label>

                  {files.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {files.map((f, i) => (
                        <div key={`${f.file.name}-${i}`} style={{
                          display: 'flex', flexDirection: 'column', gap: '4px',
                          padding: '5px 9px', borderRadius: '7px', background: 'var(--bg-surface-2)',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
                            {f.uploaded
                              ? <CheckCircle2 size={11} style={{ flexShrink: 0, color: 'var(--status-active)' }} />
                              : <Paperclip size={11} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />}
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file.name}</span>
                            <span style={{ color: 'var(--text-muted)', fontSize: '11px', flexShrink: 0 }}>{formatFileSize(f.file.size)}</span>
                            <button
                              type="button" aria-label={`Remove ${f.file.name}`}
                              onClick={() => removeFile(f)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex' }}
                            >
                              <X size={12} />
                            </button>
                          </div>

                          {/* The bar only exists while there is something to report about. */}
                          {!f.uploaded && !f.error && (
                            <div style={{ height: 3, borderRadius: 999, background: 'var(--bg-card)', overflow: 'hidden' }}>
                              <div style={{
                                height: '100%', width: `${Math.round(f.progress * 100)}%`,
                                background: 'var(--accent)', transition: 'width 120ms linear',
                              }} />
                            </div>
                          )}
                          {f.error && (
                            <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{f.error}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Similar open items — vote instead of duplicating. */}
                {similar.length > 0 && (
                  <div style={{ borderRadius: '10px', border: '1px solid var(--border-color)', background: 'var(--bg-surface-2)', padding: '10px 12px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginBottom: '8px' }}>
                      Already reported? Add your vote instead
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                      {similar.map((s) => (
                        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ flex: 1, fontSize: '12.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                          <button onClick={() => meToo(s.id)} style={{
                            display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0,
                            padding: '3px 9px', borderRadius: '999px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                            background: s.hasVoted ? 'var(--accent-soft)' : 'var(--bg-card)',
                            color: s.hasVoted ? 'var(--accent-primary)' : 'var(--text-secondary)',
                            border: `1px solid ${s.hasVoted ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                          }}>
                            {s.hasVoted ? <CheckCircle2 size={11} /> : <Users size={11} />} {s.hasVoted ? 'Voted' : 'Me too'} · {s.voteCount}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {votedMsg && <div style={{ fontSize: '12px', color: 'var(--success)', display: 'flex', gap: '6px', alignItems: 'center' }}><CheckCircle2 size={13} /> {votedMsg}</div>}

                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  We'll attach the page you're on ({areaFromPath(location.pathname)}) so the team can find it.
                </div>

                {err && <div style={{ fontSize: '12px', color: 'var(--danger)' }}>{err}</div>}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '2px' }}>
                  <button className="btn btn-secondary" onClick={close}>Cancel</button>
                  <button className="btn btn-primary" onClick={submit} disabled={busy || uploading || !body.trim()} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {busy ? <Loader2 size={14} className="spin" /> : <MessageSquarePlus size={14} />} Send
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};

const TypeChip: React.FC<{ active: boolean; onClick: () => void; label: string; color?: string; icon?: React.ReactNode }> = ({ active, onClick, label, color, icon }) => (
  <button
    onClick={onClick}
    style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px',
      padding: '5px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
      background: active ? (color ? `${color}22` : 'var(--accent-soft)') : 'var(--bg-primary)',
      color: active ? (color ?? 'var(--accent-primary)') : 'var(--text-secondary)',
      border: `1px solid ${active ? (color ?? 'var(--accent-primary)') : 'var(--border-color)'}`,
    }}
  >
    {icon} {label}
  </button>
);

export default FeedbackLauncher;
