import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { MessageSquarePlus, X, Loader2, CheckCircle2, Sparkles, Users } from 'lucide-react';
import { FeedbackCategory } from '@fapoms/shared';

import { createFeedback, getSimilarFeedback, voteFeedback, type SimilarFeedback } from '../../services/feedback';
import { userMessage } from '../../services/errors';
import { CATEGORY, areaFromPath } from './feedbackUi';

/**
 * The always-available "send feedback" entry point.
 *
 * Lives in the header so every user — on any page — can report a bug, request a
 * feature or ask a question without hunting for a menu. It captures the route they
 * were on and their platform automatically, so the team can reproduce, and leaves
 * category detection to the classifier unless the reporter picks one.
 */
export const FeedbackLauncher: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<FeedbackCategory | ''>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [doneId, setDoneId] = useState<string | null>(null);
  const [similar, setSimilar] = useState<SimilarFeedback[]>([]);
  const [votedMsg, setVotedMsg] = useState<string | null>(null);

  const reset = () => {
    setTitle(''); setBody(''); setCategory(''); setErr(null); setDoneId(null); setSimilar([]); setVotedMsg(null);
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

  const meToo = async (id: string) => {
    try {
      const res = await voteFeedback(id);
      setSimilar((prev) => prev.map((s) => (s.id === id ? { ...s, hasVoted: res.voted, voteCount: res.voteCount } : s)));
      if (res.voted) setVotedMsg('Added your vote — no need to file a new report.');
    } catch (e) { setErr(userMessage(e)); }
  };

  const submit = async () => {
    if (!body.trim()) { setErr('Please describe the issue or idea.'); return; }
    setBusy(true);
    setErr(null);
    try {
      const thread = await createFeedback({
        title: title.trim() || undefined,
        body: body.trim(),
        category: category || undefined,
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
                  You'll be notified when they reply. You can follow the conversation any time.
                </div>
                <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                  <button className="btn btn-secondary" onClick={() => { const id = doneId; close(); navigate(`/feedback?id=${id}`); }}>View my feedback</button>
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
                  <button className="btn btn-primary" onClick={submit} disabled={busy || !body.trim()} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
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
