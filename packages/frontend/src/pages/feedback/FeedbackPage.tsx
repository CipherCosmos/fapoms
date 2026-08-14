import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageSquare, Inbox, Loader2, Search, Sparkles, Flame, Clock, TrendingUp, Users, AlertTriangle, ArrowRight } from 'lucide-react';
import { SystemRole, FeedbackStatus, FeedbackCategory, FeedbackSeverity } from '@fapoms/shared';

import { useCurrentRoles } from '../../hooks/useCurrentRoles';
import { connectSocket, getSocket } from '../../services/socket';
import {
  getMyFeedback, getQueue, getStats, getDigest, getAssignees, getAttention,
  type FeedbackThread, type FeedbackStats, type FeedbackDigest, type FeedbackAttention,
} from '../../services/feedback';
import { CATEGORY, SEVERITY, STATUS, Badge, fmtWhen, card, label } from './feedbackUi';
import { FeedbackDetail } from './FeedbackDetail';
import { FeedbackProperties } from './FeedbackProperties';
import { FeedbackThreadPanel } from './FeedbackThreadPanel';
import { FeedbackLauncher } from './FeedbackLauncher';
import { getThread } from '../../services/feedback';

import { FEEDBACK_STATUS_LABELS } from '@fapoms/shared';
const PAGE_SIZE = 25;
const TEAM_ROLES = [SystemRole.PRODUCT_SUPPORT, SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR];

const STATUS_TABS: { key: FeedbackStatus | 'ALL'; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: FeedbackStatus.OPEN, label: FEEDBACK_STATUS_LABELS[FeedbackStatus.OPEN] },
  { key: FeedbackStatus.ACKNOWLEDGED, label: FEEDBACK_STATUS_LABELS[FeedbackStatus.ACKNOWLEDGED] },
  { key: FeedbackStatus.IN_PROGRESS, label: FEEDBACK_STATUS_LABELS[FeedbackStatus.IN_PROGRESS] },
  { key: FeedbackStatus.RESOLVED, label: FEEDBACK_STATUS_LABELS[FeedbackStatus.RESOLVED] },
  { key: FeedbackStatus.CLOSED, label: FEEDBACK_STATUS_LABELS[FeedbackStatus.CLOSED] },
];

const Stat: React.FC<{ n: number; label: string; tone?: string; onClick?: () => void; active?: boolean }> = ({ n, label: l, tone, onClick, active }) => (
  <button onClick={onClick} disabled={!onClick} style={{
    ...card, padding: '12px 14px', textAlign: 'left', cursor: onClick ? 'pointer' : 'default',
    minWidth: '120px', flex: '1 1 120px',
    borderColor: active ? 'var(--accent-primary)' : 'var(--border-color)',
    background: active ? 'var(--accent-soft)' : 'var(--bg-surface)',
  }}>
    <div style={{ fontSize: '24px', fontWeight: 800, lineHeight: 1, color: tone ?? 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{n}</div>
    <div style={{ ...label, marginTop: '5px' }}>{l}</div>
  </button>
);

/** One row in the list/queue. */
const Row: React.FC<{ t: FeedbackThread; active: boolean; onClick: () => void }> = ({ t, active, onClick }) => (
  <button onClick={onClick} style={{
    display: 'block', width: '100%', textAlign: 'left', padding: '11px 13px', cursor: 'pointer',
    background: active ? 'var(--accent-soft)' : 'var(--bg-surface)',
    border: '1px solid', borderColor: active ? 'var(--accent-primary)' : 'var(--border-color)',
    borderRadius: '10px',
  }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'flex-start' }}>
      <span style={{ fontSize: '13px', fontWeight: 600, lineHeight: 1.3, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{t.title}</span>
      <Badge chip={STATUS[t.status]} />
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '7px', flexWrap: 'wrap' }}>
      <Badge chip={CATEGORY[t.category]} />
      <Badge chip={SEVERITY[t.severity]} />
      {t.voteCount > 1 && (
        <span title={`${t.voteCount} people affected`} style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '11px', fontWeight: 700, color: 'var(--accent-primary)' }}>
          <Users size={11} /> {t.voteCount}
        </span>
      )}
      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t.reporterName} · {fmtWhen(t.lastMessageAt)}</span>
    </div>
  </button>
);

export const FeedbackPage: React.FC = () => {
  const roles = useCurrentRoles();
  const isTeam = useMemo(() => roles.some((r) => TEAM_ROLES.includes(r)), [roles]);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('id');
  const setSelectedId = useCallback((id: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set('id', id); else next.delete('id');
      return next;
    });
  }, [setParams]);

  return isTeam
    ? <TeamView selectedId={selectedId} setSelectedId={setSelectedId} />
    : <ReporterView selectedId={selectedId} setSelectedId={setSelectedId} />;
};

// ── Reporter ──────────────────────────────────────────────────────────────────

const ReporterView: React.FC<{ selectedId: string | null; setSelectedId: (id: string | null) => void }> = ({ selectedId, setSelectedId }) => {
  const [items, setItems] = useState<FeedbackThread[] | null>(null);
  const load = useCallback(() => { getMyFeedback().then(setItems).catch(() => setItems([])); }, []);
  useEffect(() => { load(); }, [load]);

  // Live: reporter's own room pushes feedback:* — refresh the list on any of them.
  useEffect(() => {
    const socket = connectSocket() ?? getSocket();
    if (!socket) return;
    const onEvt = () => load();
    socket.on('feedback:message', onEvt); socket.on('feedback:updated', onEvt); socket.on('feedback:new', onEvt);
    return () => { socket.off('feedback:message', onEvt); socket.off('feedback:updated', onEvt); socket.off('feedback:new', onEvt); };
  }, [load]);

  return (
    <div style={{ padding: '20px', maxWidth: '1100px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '16px', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 800, margin: 0 }}>My feedback</h1>
          <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: '4px 0 0' }}>Bugs, ideas and questions you've sent the product team.</p>
        </div>
        <FeedbackLauncher />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 380px) 1fr', gap: '14px', flex: 1, minHeight: 0 }} className="feedback-split">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto', paddingRight: '2px' }}>
          {items === null && <div style={{ color: 'var(--text-muted)', fontSize: '13px', display: 'flex', gap: '8px', alignItems: 'center' }}><Loader2 size={15} className="spin" /> Loading…</div>}
          {items?.length === 0 && (
            <div style={{ ...card, textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
              <MessageSquare size={26} style={{ opacity: 0.3, marginBottom: '8px' }} />
              <div>You haven't sent any feedback yet.</div>
              <div style={{ fontSize: '11.5px', marginTop: '4px' }}>Use the Feedback button any time you hit a bug or have an idea.</div>
            </div>
          )}
          {items?.map((t) => <Row key={t.id} t={t} active={t.id === selectedId} onClick={() => setSelectedId(t.id)} />)}
        </div>

        <div style={{ ...card, padding: 0, overflow: 'hidden', minHeight: 0 }}>
          {selectedId
            ? <FeedbackDetail threadId={selectedId} isTeam={false} assignees={[]} onChanged={load} />
            : <Empty icon={<MessageSquare size={30} />} text="Select a thread to see the conversation." />}
        </div>
      </div>
    </div>
  );
};

// ── Team ──────────────────────────────────────────────────────────────────────

const TeamView: React.FC<{ selectedId: string | null; setSelectedId: (id: string | null) => void }> = ({ selectedId, setSelectedId }) => {
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const [digest, setDigest] = useState<FeedbackDigest | null>(null);
  const [attention, setAttention] = useState<FeedbackAttention | null>(null);
  const [detail, setDetail] = useState<FeedbackThread | null>(null);
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'ok' | 'missing'>('idle');
  const [assignees, setAssignees] = useState<{ id: string; name: string }[]>([]);
  const [items, setItems] = useState<FeedbackThread[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const [statusTab, setStatusTab] = useState<FeedbackStatus | 'ALL'>('ALL');
  const [category, setCategory] = useState<FeedbackCategory | ''>('');
  const [severity, setSeverity] = useState<FeedbackSeverity | ''>('');
  const [mineOnly, setMineOnly] = useState<'' | 'me' | 'none'>('');
  const [sort, setSort] = useState<'recent' | 'impact'>('recent');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => { const t = setTimeout(() => setDebounced(search), 350); return () => clearTimeout(t); }, [search]);

  const loadAux = useCallback(() => {
    getStats().then(setStats).catch(() => {});
    // On error, fall back to an empty digest so the panel shows "clean desk" rather than
    // sitting on "Loading the digest…" forever.
    getDigest().then(setDigest).catch(() => setDigest({ openCount: 0, topThemes: [], aging: [], criticalOpen: [] }));
    getAttention().then(setAttention).catch(() => {});
  }, []);
  useEffect(() => { loadAux(); getAssignees().then(setAssignees).catch(() => {}); }, [loadAux]);

  const loadQueue = useCallback(() => {
    getQueue({
      page, limit: PAGE_SIZE,
      status: statusTab === 'ALL' ? '' : statusTab,
      category, severity, sort,
      assignedToUserId: mineOnly || undefined,
      search: debounced || undefined,
    })
      .then((res) => { setItems(res.data); setTotal(res.meta.pagination.total); })
      .catch(() => { setItems([]); setTotal(0); });
  }, [page, statusTab, category, severity, mineOnly, sort, debounced]);
  useEffect(() => { loadQueue(); }, [loadQueue]);
  useEffect(() => { setPage(1); }, [statusTab, category, severity, mineOnly, sort, debounced]);

  // The open item's full detail (with duplicate candidates + hasVoted) for the properties rail.
  // Track a 'missing' state so a stale/removed id shows a clear message instead of a spinner
  // that never resolves — getThread rejects on 404.
  const loadDetail = useCallback(() => {
    if (!selectedId) { setDetail(null); setDetailState('idle'); return; }
    setDetailState('loading');
    getThread(selectedId)
      .then((d) => { setDetail(d); setDetailState('ok'); })
      .catch(() => { setDetail(null); setDetailState('missing'); });
  }, [selectedId]);
  useEffect(() => { loadDetail(); }, [loadDetail]);

  // Live: the team's role rooms push every feedback:* — refresh queue + stats.
  useEffect(() => {
    const socket = connectSocket() ?? getSocket();
    if (!socket) return;
    const onEvt = () => { loadQueue(); loadAux(); };
    socket.on('feedback:new', onEvt); socket.on('feedback:message', onEvt); socket.on('feedback:updated', onEvt);
    return () => { socket.off('feedback:new', onEvt); socket.off('feedback:message', onEvt); socket.off('feedback:updated', onEvt); };
  }, [loadQueue, loadAux]);

  const refreshAll = () => { loadQueue(); loadAux(); loadDetail(); };
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '14px', height: '100%', minHeight: 0 }}>
      <div>
        <h1 style={{ fontSize: '20px', fontWeight: 800, margin: 0 }}>Feedback desk</h1>
        <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: '4px 0 0' }}>Everything users have reported — triage, respond, and track to resolution.</p>
      </div>

      {/* SLA breaches — the exception surface. Disappears when the desk is on time. */}
      <AttentionBanner attention={attention} onOpen={setSelectedId} />

      {/* Stat strip */}
      {stats && (
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <Stat n={stats.open} label="Open" />
          <Stat n={stats.untriaged} label="Untriaged" tone={stats.untriaged ? '#eab308' : undefined} active={statusTab === FeedbackStatus.OPEN} onClick={() => setStatusTab(FeedbackStatus.OPEN)} />
          <Stat n={stats.unassigned} label="Unassigned" tone={stats.unassigned ? '#3b82f6' : undefined} active={mineOnly === 'none'} onClick={() => setMineOnly(mineOnly === 'none' ? '' : 'none')} />
          <Stat n={stats.criticalOpen} label="Critical open" tone={stats.criticalOpen ? '#ef4444' : undefined} active={severity === FeedbackSeverity.CRITICAL} onClick={() => setSeverity(severity === FeedbackSeverity.CRITICAL ? '' : FeedbackSeverity.CRITICAL)} />
          <Stat n={stats.total} label="Total" />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: (selectedId && detailState !== 'missing') ? '320px minmax(0, 1fr) 336px' : '320px minmax(0, 1fr)', gap: '14px', flex: 1, minHeight: 0 }} className="feedback-desk-grid">
        {/* Queue column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0 }}>
          {/* Filters */}
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {STATUS_TABS.map((t) => (
              <button key={t.key} onClick={() => setStatusTab(t.key)} style={{
                padding: '4px 10px', borderRadius: '999px', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer',
                background: statusTab === t.key ? 'var(--accent-primary)' : 'var(--bg-surface)',
                color: statusTab === t.key ? 'var(--bg-primary)' : 'var(--text-secondary)',
                border: '1px solid', borderColor: statusTab === t.key ? 'var(--accent-primary)' : 'var(--border-color)',
              }}>{t.label}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flex: '1 1 140px', padding: '4px 8px', borderRadius: '7px', background: 'var(--bg-input)', border: '1px solid var(--border-color)' }}>
              <Search size={13} style={{ color: 'var(--text-muted)' }} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'inherit', fontSize: '12px' }} />
            </div>
            <select value={category} onChange={(e) => setCategory(e.target.value as FeedbackCategory | '')} style={{ padding: '5px 7px', fontSize: '11.5px', borderRadius: '7px', background: 'var(--bg-input)', color: 'inherit', border: '1px solid var(--border-color)' }}>
              <option value="">All types</option>
              {Object.values(FeedbackCategory).map((c) => <option key={c} value={c}>{CATEGORY[c].label}</option>)}
            </select>
            <button onClick={() => setMineOnly(mineOnly === 'me' ? '' : 'me')} style={{
              padding: '5px 10px', borderRadius: '7px', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer',
              background: mineOnly === 'me' ? 'var(--accent-soft)' : 'var(--bg-surface)',
              color: mineOnly === 'me' ? 'var(--accent-primary)' : 'var(--text-secondary)',
              border: '1px solid', borderColor: mineOnly === 'me' ? 'var(--accent-primary)' : 'var(--border-color)',
            }}>Mine</button>
            <button onClick={() => setSort(sort === 'impact' ? 'recent' : 'impact')} title="Sort by how many people are affected" style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              padding: '5px 10px', borderRadius: '7px', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer',
              background: sort === 'impact' ? 'var(--accent-soft)' : 'var(--bg-surface)',
              color: sort === 'impact' ? 'var(--accent-primary)' : 'var(--text-secondary)',
              border: '1px solid', borderColor: sort === 'impact' ? 'var(--accent-primary)' : 'var(--border-color)',
            }}><Users size={12} /> Impact</button>
          </div>

          {/* List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto', flex: 1, minHeight: 0, paddingRight: '2px' }}>
            {items === null && <div style={{ color: 'var(--text-muted)', fontSize: '13px', display: 'flex', gap: '8px', alignItems: 'center' }}><Loader2 size={15} className="spin" /> Loading…</div>}
            {items?.length === 0 && <div style={{ ...card, textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}><Inbox size={24} style={{ opacity: 0.3, marginBottom: '6px' }} /><div>Nothing here.</div></div>}
            {items?.map((t) => <Row key={t.id} t={t} active={t.id === selectedId} onClick={() => setSelectedId(t.id)} />)}
          </div>

          {pages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-muted)' }}>
              <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} style={{ padding: '4px 10px', fontSize: '12px' }}>Prev</button>
              <span>Page {page} / {pages} · {total}</span>
              <button className="btn btn-secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} style={{ padding: '4px 10px', fontSize: '12px' }}>Next</button>
            </div>
          )}
        </div>

        {/* Conversation column — the chat gets the full height of the pane. */}
        <div style={{ ...card, padding: 0, overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {!selectedId ? (
            <DigestPanel digest={digest} onOpen={setSelectedId} />
          ) : detailState === 'missing' ? (
            <Empty icon={<Inbox size={30} />} text="This item is no longer available — it may have been removed." />
          ) : (
            <>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-surface-2)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '14.5px', fontWeight: 700, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail?.title ?? 'Loading…'}</div>
                  {detail && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{detail.reporterName} · {CATEGORY[detail.category].label}</div>}
                </div>
                {detail && <Badge chip={STATUS[detail.status]} />}
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <FeedbackThreadPanel threadId={selectedId} isTeam onChanged={refreshAll} />
              </div>
            </>
          )}
        </div>

        {/* Properties rail — status, triage, SLA, impact, AI, duplicates. Only with a live thread open. */}
        {selectedId && detailState !== 'missing' && (
          <div style={{ ...card, padding: 0, overflow: 'hidden', minHeight: 0 }}>
            {detail
              ? <FeedbackProperties thread={detail} assignees={assignees} onChanged={refreshAll} onOpenThread={setSelectedId} />
              : <div style={{ padding: '20px', color: 'var(--text-muted)', fontSize: '13px', display: 'flex', gap: '8px', alignItems: 'center' }}><Loader2 size={14} className="spin" /> Loading…</div>}
          </div>
        )}
      </div>
    </div>
  );
};

const AttentionBanner: React.FC<{ attention: FeedbackAttention | null; onOpen: (id: string) => void }> = ({ attention, onOpen }) => {
  if (!attention) return null;
  const buckets = [
    { key: 'firstResponseOverdue', label: 'Awaiting first response', items: attention.firstResponseOverdue },
    { key: 'resolutionOverdue', label: 'Past resolution SLA', items: attention.resolutionOverdue },
  ].filter((b) => b.items.length > 0);
  if (buckets.length === 0) return null;
  const totalCount = buckets.reduce((n, b) => n + b.items.length, 0);
  return (
    <div style={{ borderRadius: '12px', border: '1px solid var(--danger)', background: 'rgba(239,68,68,0.07)', padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '10px' }}>
        <AlertTriangle size={15} style={{ color: 'var(--danger)' }} />
        <span style={{ fontSize: '11px', fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--danger)' }}>
          Needs attention — {totalCount} past SLA
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' }}>
        {buckets.map((b) => (
          <div key={b.key} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: '9px', padding: '9px 11px' }}>
            <div style={{ ...label, color: 'var(--danger)', marginBottom: '6px' }}>{b.label} ({b.items.length})</div>
            {b.items.slice(0, 3).map((it) => (
              <button key={it.id} onClick={() => onOpen(it.id)} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', width: '100%', textAlign: 'left',
                background: 'none', border: 'none', cursor: 'pointer', padding: '3px 0', color: 'var(--text-primary)',
              }}>
                <span style={{ fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</span>
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>{it.ageHours}h <ArrowRight size={11} /></span>
              </button>
            ))}
            {b.items.length > 3 && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>+{b.items.length - 3} more</div>}
          </div>
        ))}
      </div>
    </div>
  );
};

const DigestPanel: React.FC<{ digest: FeedbackDigest | null; onOpen: (id: string) => void }> = ({ digest, onOpen }) => {
  if (!digest) return <Empty icon={<Sparkles size={30} />} text="Loading the digest…" />;
  return (
    <div style={{ padding: '18px', overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
        <Sparkles size={16} style={{ color: 'var(--accent)' }} />
        <h2 style={{ fontSize: '15px', fontWeight: 700, margin: 0 }}>What's coming in</h2>
      </div>
      <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 16px' }}>{digest.openCount} open items. Select one on the left to work it, or start with what's loudest.</p>

      {digest.criticalOpen.length > 0 && (
        <Section icon={<Flame size={13} style={{ color: '#ef4444' }} />} title="Critical, still open">
          {digest.criticalOpen.map((c) => (
            <LineItem key={c.id} onClick={() => onOpen(c.id)} left={c.title} right={STATUS[c.status].label} />
          ))}
        </Section>
      )}

      {digest.topThemes.length > 0 && (
        <Section icon={<TrendingUp size={13} style={{ color: 'var(--accent)' }} />} title="Loudest themes">
          {digest.topThemes.map((t) => (
            <LineItem key={t.term} onClick={() => t.threadIds[0] && onOpen(t.threadIds[0])} left={t.term} right={`${t.count} reports`} />
          ))}
        </Section>
      )}

      {digest.aging.length > 0 && (
        <Section icon={<Clock size={13} style={{ color: 'var(--warning)' }} />} title="Aging — no decision yet">
          {digest.aging.map((a) => (
            <LineItem key={a.id} onClick={() => onOpen(a.id)} left={a.title} right={`${a.ageDays}d`} />
          ))}
        </Section>
      )}

      {digest.criticalOpen.length === 0 && digest.topThemes.length === 0 && digest.aging.length === 0 && (
        <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', padding: '20px' }}>A clean desk — nothing loud, critical or aging.</div>
      )}
    </div>
  );
};

const Section: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode }> = ({ icon, title, children }) => (
  <div style={{ marginBottom: '18px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', ...label, marginBottom: '8px' }}>{icon} {title}</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>{children}</div>
  </div>
);

const LineItem: React.FC<{ left: string; right: string; onClick: () => void }> = ({ left, right, onClick }) => (
  <button onClick={onClick} style={{
    display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', width: '100%', textAlign: 'left',
    padding: '8px 10px', borderRadius: '8px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', cursor: 'pointer',
  }}>
    <span style={{ fontSize: '12.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{left}</span>
    <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{right}</span>
  </button>
);

const Empty: React.FC<{ icon: React.ReactNode; text: string }> = ({ icon, text }) => (
  <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', color: 'var(--text-muted)', fontSize: '13px', padding: '20px', textAlign: 'center' }}>
    <span style={{ opacity: 0.3 }}>{icon}</span>{text}
  </div>
);

export default FeedbackPage;
