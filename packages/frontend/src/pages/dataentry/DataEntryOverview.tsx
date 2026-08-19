import React, { useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Inbox, UserPlus, CheckCircle2, MessageSquare, FileText, AlertTriangle, Send as SubmitIcon,
  Users as TeamIcon, RotateCcw,
} from 'lucide-react';

import { roleLabel, activityEventLabel } from '@fapoms/shared';
import { api } from '../../services/api';
import { useCurrentRoles } from '../../hooks/useCurrentRoles';
import { deskRole, deskCard, deskLabel, QueueCounts, PagedQueue } from './deskRoles';

/**
 * The desk dashboard: aggregates only, never rows.
 *
 * The old board rendered every packet and case inline on one page, which reads fine
 * at fifty items and collapses at fifty thousand. This page shows the numbers that
 * describe the desk's day — each one a link into the paged queue it summarises —
 * and, for heads, the per-member workload strip. Row-level work happens in the
 * Packets and Reviews queues, which paginate on the server.
 */

interface WorkloadMember {
  id: string; name: string; role: string;
  openPackets: number; reworkPackets: number; casesInReview: number;
  handedBackWeek: number; clearedThisWeek: number; oldestOpenDays: number | null;
}
interface Workload {
  members: WorkloadMember[];
  totals: { unassignedPackets: number; unroutedReviews: number; inReview: number; approved: number; openClarifications: number };
}

interface ActivityRow {
  at: string; eventType: string; actor: string | null; remarks: string | null;
  branchName: string | null; projectBranchId: string | null;
}

interface AttentionItem {
  id: string; projectBranchId: string | null; branchName: string | null;
  ageHours: number; who: string | null; whoId: string | null;
}
/** The sample shown, and how many there really are. Mirrors AttentionBucket on the server. */
interface AttentionBucket { items: AttentionItem[]; total: number }
interface DeskAttention {
  slaHours: Record<string, number>;
  unassignedOverdue: AttentionBucket; entryOverdue: AttentionBucket; reworkStale: AttentionBucket;
  reviewOverdue: AttentionBucket; submitOverdue: AttentionBucket; ocrStuck: AttentionBucket;
  clarificationsOverdue: AttentionBucket;
}

/** Breach buckets, ordered by how loudly they should shout. */
const ATTENTION_BUCKETS: Array<{ key: keyof Omit<DeskAttention, 'slaHours'>; label: string; tone: string; link: string }> = [
  { key: 'submitOverdue', label: 'Approved — not sent to client', tone: 'var(--danger)', link: '/data-entry/reviews?status=APPROVED' },
  { key: 'unassignedOverdue', label: 'Waiting for assignment too long', tone: 'var(--danger)', link: '/data-entry/packets?lane=unassigned' },
  { key: 'reworkStale', label: 'Rework not picked up', tone: 'var(--danger)', link: '/data-entry/packets?lane=rework' },
  { key: 'reviewOverdue', label: 'Review pending too long', tone: 'var(--warning)', link: '/data-entry/reviews?status=HUMAN_REVIEW' },
  { key: 'entryOverdue', label: 'With a member too long', tone: 'var(--warning)', link: '/data-entry/packets' },
  { key: 'ocrStuck', label: 'Stuck at external OCR', tone: 'var(--warning)', link: '/data-entry/packets' },
  { key: 'clarificationsOverdue', label: 'Clarifications overdue', tone: 'var(--warning)', link: '/data-entry/clarifications' },
];

/** Event types → what a person reads. Anything unmapped falls back to the raw type. */
/**
 * Desk-specific verb phrases for the events this feed shows.
 *
 * Deliberately kept alongside the shared `activityEventLabel` rather than folded into it:
 * these read as what a *named person did* ("Priya assigned a packet"), because this feed
 * always prints an actor first. The shared map is written for feeds with no actor
 * ("Document uploaded"). Same events, two grammatical positions. What did move to the
 * shared layer is the fallback — an unlisted event used to be de-cased inline here.
 */
const ACTIVITY_LABEL: Record<string, string> = {
  DOCUMENT_DELEGATED_TO_DATA_ENTRY: 'assigned a packet',
  DOCUMENT_DATA_ENTRY_COMPLETED: 'handed back',
  DOCUMENT_RECEIVED: 'packet received',
  DOCUMENT_UPLOADED: 'packet uploaded',
  DOCUMENT_DISPATCHED: 'packet dispatched',
  VALIDATION_STARTED: 'case opened',
  VALIDATION_HUMAN_REVIEW: 'sent for review',
  VALIDATION_REVIEWER_ASSIGNED: 'routed the review',
  VALIDATION_APPROVED: 'approved',
  VALIDATION_CORRECTION_REQUIRED: 'sent back for rework',
  VALIDATION_SUBMITTED: 'submitted to client',
};

export const DataEntryOverview: React.FC = () => {
  const roles = useCurrentRoles();
  const { isHead } = deskRole(roles);
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [counts, setCounts] = useState<QueueCounts | null>(null);
  const [workload, setWorkload] = useState<Workload | null>(null);
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const [attention, setAttention] = useState<DeskAttention | null>(null);
  const [openClarifications, setOpenClarifications] = useState<number | null>(null);

  useEffect(() => {
    const queueUrl = isHead ? '/documents/data-entry/queue?limit=1' : '/documents/data-entry/mine?limit=1';
    api.request<PagedQueue<unknown>>(queueUrl).then((q) => setCounts(q.counts)).catch(() => setCounts(null));
    if (isHead) {
      api.request<Workload>('/validation/workload').then(setWorkload).catch(() => setWorkload(null));
      api.request<ActivityRow[]>('/validation/activity?limit=15')
        .then((r) => setActivity(Array.isArray(r) ? r : []))
        .catch(() => setActivity([]));
      api.request<DeskAttention>('/validation/attention').then(setAttention).catch(() => setAttention(null));
    } else {
      api.request<Array<{ status: string }>>('/validation-queries')
        .then((r) => setOpenClarifications((Array.isArray(r) ? r : []).filter((q) => q.status !== 'RESOLVED').length))
        .catch(() => setOpenClarifications(null));
    }
  }, [isHead]);

  // Old notification links point at /data-entry?branch=<id>; the workspace lives on
  // its own route now.
  const legacyBranch = params.get('branch');
  if (legacyBranch) return <Navigate to={`/data-entry/case/${legacyBranch}`} replace />;

  const totals = workload?.totals;
  // `total` is the real breach count; `items` is the sample the server sends for the preview.
  // The banner used to add up `items.length`, so it reported the server's 50-row cap as the
  // size of the backlog — "50 items past their due date" on a desk with four hundred.
  const breachedBuckets = attention
    ? ATTENTION_BUCKETS.filter((b) => (attention[b.key]?.total ?? 0) > 0)
    : [];
  const breachedTotal = breachedBuckets.reduce((n, b) => n + (attention![b.key]?.total ?? 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/* Management by exception: what has broken its SLA, loudest first. Absent when
          nothing is in breach — a clean desk needs no red banner. */}
      {isHead && breachedBuckets.length > 0 && (
        <section style={{ ...deskCard, border: '1px solid var(--danger)' }}>
          <div style={{ ...deskLabel, color: 'var(--danger)', marginBottom: '8px' }}>
            ⚠ Needs attention — {breachedTotal} item{breachedTotal === 1 ? '' : 's'} past their due date
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {breachedBuckets.map((b) => {
              const bucket = attention![b.key];
              const items = bucket.items;
              return (
                <div key={b.key} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                  <button onClick={() => navigate(b.link)}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: b.tone, fontSize: '12.5px', fontWeight: 700, width: 'auto' }}>
                    {b.label} ({bucket.total}) →
                  </button>
                  <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                    {items.slice(0, 3).map((i, idx) => (
                      <span key={i.id}>
                        {idx > 0 && ' · '}
                        {i.projectBranchId ? (
                          <button onClick={() => navigate(`/data-entry/case/${i.projectBranchId}`)}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '11.5px', width: 'auto' }}>
                            {i.branchName ?? 'branch'}
                          </button>
                        ) : (i.branchName ?? 'branch')}
                        {' '}{i.ageHours}h{i.who ? ` · ${i.who}` : ''}
                      </span>
                    ))}
                    {bucket.total > 3 && ` · +${bucket.total - 3} more`}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '10px' }}>
        {isHead ? (
          <>
            <NumberCard icon={<UserPlus size={15} />} value={counts?.unassigned} caption="Waiting to assign"
              tone={counts?.unassigned ? 'var(--warning)' : undefined} onClick={() => navigate('/data-entry/packets?lane=unassigned')} />
            <NumberCard icon={<Inbox size={15} />} value={counts?.working} caption="Being worked"
              onClick={() => navigate('/data-entry/packets?lane=working')} />
            <NumberCard icon={<RotateCcw size={15} />} value={counts?.rework} caption="Rework"
              tone={counts?.rework ? 'var(--danger)' : undefined} onClick={() => navigate('/data-entry/packets?lane=rework')} />
            <NumberCard icon={<FileText size={15} />} value={totals?.inReview} caption="In review"
              tone={totals?.inReview ? 'var(--warning)' : undefined} onClick={() => navigate('/data-entry/reviews?status=HUMAN_REVIEW')} />
            <NumberCard icon={<AlertTriangle size={15} />} value={totals?.unroutedReviews} caption="Reviews not routed"
              tone={totals?.unroutedReviews ? 'var(--danger)' : undefined} onClick={() => navigate('/data-entry/reviews?status=HUMAN_REVIEW&routed=no')} />
            <NumberCard icon={<CheckCircle2 size={15} />} value={totals?.approved} caption="Approved — to submit"
              tone={totals?.approved ? 'var(--success)' : undefined} onClick={() => navigate('/data-entry/reviews?status=APPROVED')} />
            <NumberCard icon={<MessageSquare size={15} />} value={totals?.openClarifications} caption="Open clarifications"
              tone={totals?.openClarifications ? 'var(--warning)' : undefined} onClick={() => navigate('/data-entry/clarifications')} />
          </>
        ) : (
          <>
            <NumberCard icon={<Inbox size={15} />} value={counts?.working} caption="My packets"
              tone={counts?.working ? 'var(--accent)' : undefined} onClick={() => navigate('/data-entry/packets')} />
            <NumberCard icon={<RotateCcw size={15} />} value={counts?.rework} caption="Rework — fix and hand back"
              tone={counts?.rework ? 'var(--danger)' : undefined} onClick={() => navigate('/data-entry/packets?lane=rework')} />
            <NumberCard icon={<SubmitIcon size={15} />} value={counts?.done} caption="Handed back"
              onClick={() => navigate('/data-entry/reviews')} />
            <NumberCard icon={<MessageSquare size={15} />} value={openClarifications ?? undefined} caption="Open clarifications"
              tone={openClarifications ? 'var(--warning)' : undefined} onClick={() => navigate('/data-entry/clarifications')} />
          </>
        )}
      </div>

      {isHead && workload && workload.members.length > 0 && (
        <section style={deskCard}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '10px' }}>
            <TeamIcon size={14} />
            <span style={{ ...deskLabel, color: 'var(--text-primary)' }}>Team workload</span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
              packets · rework · reviews held · cleared (7d)
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '8px' }}>
            {workload.members.map((m) => {
              const idle = m.openPackets + m.reworkPackets + m.casesInReview === 0;
              const stale = (m.oldestOpenDays ?? 0) >= 3;
              return (
                // The card is the drill-down: it opens the Packets queue filtered to this
                // member, answering "what exactly does <name> hold?" in one click.
                <button key={m.id} onClick={() => navigate(`/data-entry/packets?assignedTo=${m.id}`)}
                  style={{ padding: '9px 11px', borderRadius: '8px', border: `1px solid ${stale ? 'var(--danger)' : 'var(--border-hair)'}`, background: 'var(--bg-surface-2)', cursor: 'pointer', textAlign: 'left', color: 'inherit', width: 'auto' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                    <span style={{ fontSize: '12.5px', fontWeight: 700 }}>{m.name}</span>
                    <span style={{ ...deskLabel, fontSize: '9px' }}>{roleLabel(m.role)}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '9px', marginTop: '5px', fontSize: '12px', fontVariantNumeric: 'tabular-nums', flexWrap: 'wrap' }}>
                    <span title="Open packets">{m.openPackets} 📄</span>
                    <span title="Rework" style={{ color: m.reworkPackets ? 'var(--danger)' : 'var(--text-muted)' }}>{m.reworkPackets} ↩</span>
                    <span title="Reviews held" style={{ color: m.casesInReview ? 'var(--warning)' : 'var(--text-muted)' }}>{m.casesInReview} 🔍</span>
                    <span title="Packets handed back in the last 7 days" style={{ color: m.handedBackWeek ? 'var(--success)' : 'var(--text-muted)' }}>{m.handedBackWeek} ⇧</span>
                    <span title="Reviews cleared this week" style={{ color: m.clearedThisWeek ? 'var(--success)' : 'var(--text-muted)' }}>{m.clearedThisWeek} ✓</span>
                    {idle && <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--success)', fontWeight: 700 }}>FREE</span>}
                    {stale && <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--danger)', fontWeight: 700 }}>{m.oldestOpenDays}d OLD</span>}
                  </div>
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '8px' }}>
            📄 open packets · ↩ rework · 🔍 reviews held · ⇧ handed back (7d) · ✓ reviews cleared (7d) — click a member to see their packets
          </div>
        </section>
      )}

      {/* Who did what, newest first — the half of "manage the team" the counts can't say. */}
      {isHead && (
        <section style={deskCard}>
          <div style={{ ...deskLabel, color: 'var(--text-primary)', marginBottom: '8px' }}>Recent activity</div>
          {activity === null && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>}
          {activity?.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Nothing recorded yet.</div>}
          {activity?.map((a, i) => (
            <div key={i} style={{ display: 'flex', gap: '9px', padding: '7px 0', borderTop: i > 0 ? '1px solid var(--border-hair)' : 'none', fontSize: '12.5px', alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontSize: '11.5px' }}>
                {new Date(a.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </span>
              <span style={{ fontWeight: 700 }}>{a.actor ?? 'System'}</span>
              <span style={{ color: 'var(--text-secondary)' }}>{ACTIVITY_LABEL[a.eventType] ?? activityEventLabel(a.eventType)}</span>
              {a.branchName && (
                a.projectBranchId ? (
                  <button onClick={() => navigate(`/data-entry/case/${a.projectBranchId}`)}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent)', fontSize: '12.5px', fontWeight: 600, width: 'auto' }}>
                    {a.branchName}
                  </button>
                ) : <span style={{ color: 'var(--accent)' }}>{a.branchName}</span>
              )}
              {a.remarks && <span style={{ color: 'var(--text-muted)', fontSize: '11.5px', flexBasis: '100%' }}>{a.remarks}</span>}
            </div>
          ))}
        </section>
      )}
    </div>
  );
};

const NumberCard: React.FC<{
  icon: React.ReactNode; value: number | undefined | null; caption: string; tone?: string; onClick: () => void;
}> = ({ icon, value, caption, tone, onClick }) => (
  <button onClick={onClick} style={{
    ...deskCard, textAlign: 'left', cursor: 'pointer', color: 'inherit', width: 'auto',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', color: tone ?? 'var(--text-primary)' }}>
      {icon}
      <span style={{ fontSize: '22px', fontWeight: 700, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value ?? '…'}</span>
    </div>
    <div style={{ ...deskLabel, marginTop: '6px' }}>{caption}</div>
  </button>
);

export default DataEntryOverview;
