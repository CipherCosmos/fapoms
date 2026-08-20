import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Send, Trash2 } from 'lucide-react';
import { SystemRole } from '@fapoms/shared';

import { api } from '../services/api';
import { userMessage } from '../services/errors';
import { queryKeys } from '../hooks/queryKeys';
import { hasAnyRole, useCurrentRoles, useCurrentUserId } from '../hooks/useCurrentRoles';
import { roleLabel } from '@fapoms/shared';
import { Select, useConfirm } from './ui';

/**
 * Staff remarks about one assayer: the list, the summary the recommendation engine scores from,
 * and (for the roles that may) the form to add one.
 *
 * ## Why one component
 *
 * Two screens showed remarks before this — the HR drawer's Remarks tab and the planning desk's
 * assayer-detail modal — each with its own fetch, its own list markup and its own idea of what a
 * remark was (one drew 1–5 stars, the other free text). Both now render this, against the one
 * API (`/assayer-remarks`), so what HR reads and what the planner reads about the same person is
 * the same list, and the summary line at the top is the exact figure that moved the candidate's
 * score. See packages/backend/src/modules/assayer-remarks.
 *
 * ## What the reader sees
 *
 * Every remark shows who wrote it, in which role, when, its category, and its rating on a
 * −2…+2 scale. There is no anonymous remark: attribution is the thing that keeps a remark a
 * professional observation rather than a rumour.
 */

/** Mirrors AssayerRemarkCategory on the backend (assayer-remark.contract.ts). */
const CATEGORIES = ['QUALITY', 'PUNCTUALITY', 'CONDUCT', 'PAPERWORK', 'COMMUNICATION', 'OTHER'] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_LABEL: Record<Category, string> = {
  QUALITY: 'Quality of work',
  PUNCTUALITY: 'Punctuality',
  CONDUCT: 'Conduct',
  PAPERWORK: 'Paperwork',
  COMMUNICATION: 'Communication',
  OTHER: 'Other',
};

/** Mirrors REMARK_WRITE_ROLES on the backend — the desks that work with assayers. */
const WRITE_ROLES: SystemRole[] = [
  SystemRole.ADMIN,
  SystemRole.ADMIN,
  SystemRole.OPERATIONS,
  SystemRole.OPERATIONS,
  SystemRole.DESK,
  SystemRole.OPERATIONS,
  SystemRole.OPERATIONS,
  SystemRole.DESK_OPERATOR,
  SystemRole.DESK,
  SystemRole.DESK,
];
/** Mirrors REMARK_MODERATE_ROLES — may remove anyone's remark. Authors may always retract their own. */
const MODERATE_ROLES: SystemRole[] = [
  SystemRole.ADMIN,
  SystemRole.ADMIN,
  SystemRole.OPERATIONS,
  SystemRole.OPERATIONS,
];

const RATINGS: Array<{ value: number; label: string; hint: string }> = [
  { value: 2, label: '+2', hint: 'Exemplary — go out of your way to send them again' },
  { value: 1, label: '+1', hint: 'Good — better than expected' },
  { value: 0, label: '0', hint: 'A note, neither for nor against' },
  { value: -1, label: '−1', hint: 'A concern worth knowing before the next offer' },
  { value: -2, label: '−2', hint: 'Serious — the desk should think twice' },
];

export interface AssayerRemark {
  id: string;
  assayerId: string;
  authorId: string;
  authorName: string;
  authorRole: string | null;
  content: string;
  category: string;
  rating: number | null;
  assignmentId: string | null;
  createdAt: string;
}

/** Mirrors RemarkSummary on the backend; also carried on each planning candidate. */
export interface RemarkSummary {
  count: number;
  weightedMean: number | null;
  latest: { rating: number; category: string; text: string; authorRole: string | null; createdAt: string } | null;
}

export const remarksQueryKey = (assayerId: string) => ['assayer-remarks', assayerId] as const;

/** "+1.3" / "−0.7" / "0.0" — signed, one decimal, a real minus sign. */
export const fmtSignedMean = (mean: number | null | undefined): string => {
  if (mean === null || mean === undefined || !Number.isFinite(mean)) return '—';
  const s = mean.toFixed(1);
  return mean > 0 ? `+${s}` : mean < 0 ? `−${s.slice(1)}` : s;
};

const ratingTone = (rating: number | null | undefined) =>
  rating == null || rating === 0
    ? { bg: 'var(--bg-surface-2)', fg: 'var(--text-secondary)' }
    : rating > 0
      ? { bg: 'var(--status-active-bg)', fg: 'var(--success)' }
      : { bg: 'var(--status-cancelled-bg)', fg: 'var(--danger)' };

/**
 * Byline for a remark's author. Was a private de-caser that lower-cased the raw role, so a
 * remark was attributed to "operations executive" / "hr manager" — a second spelling of a
 * vocabulary that already has exactly one home. `roleLabel` is that home; the only thing kept
 * from the local version is that an author with no role reads as "staff" rather than a dash,
 * because this renders mid-sentence ("— Priya, operations executive") where "—" would break.
 */
const authorRoleLabel = (role: string | null) => (role ? roleLabel(role) : 'staff');

const fmtWhen = (d: string) =>
  new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export const AssayerRemarks: React.FC<{
  assayerId: string;
  /** Tighter spacing for the planning modal; the drawer uses the default. */
  compact?: boolean;
}> = ({ assayerId, compact = false }) => {
  const { confirm, confirmDialog } = useConfirm();
  const roles = useCurrentRoles();
  const userId = useCurrentUserId();
  const canWrite = hasAnyRole(roles, WRITE_ROLES);
  const canModerate = hasAnyRole(roles, MODERATE_ROLES);
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: remarksQueryKey(assayerId),
    queryFn: ({ signal }) =>
      api.request<{ remarks: AssayerRemark[]; summary: RemarkSummary }>(`/assayer-remarks/assayer/${assayerId}`, { signal }),
    staleTime: 15_000,
  });

  const [rating, setRating] = useState<number | null>(null);
  const [category, setCategory] = useState<Category>('QUALITY');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);

  /**
   * After a write, the remark list AND every cached recommendation are stale: the engine's
   * `remarksScore` for this person just changed, and the planning cards carry the summary. The
   * prefix invalidation is what makes the card's chip and its score update without a reload.
   */
  const afterWrite = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: remarksQueryKey(assayerId) }),
      qc.invalidateQueries({ queryKey: queryKeys.planning.recommendationsAll }),
    ]);
  };

  const create = useMutation({
    mutationFn: () =>
      api.request<AssayerRemark>('/assayer-remarks', {
        method: 'POST',
        body: JSON.stringify({ assayerId, rating, category, text: text.trim() }),
      }),
    onSuccess: async () => { setRating(null); setCategory('QUALITY'); setText(''); setErr(null); await afterWrite(); },
    onError: (e) => setErr(userMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.request(`/assayer-remarks/${id}`, { method: 'DELETE' }),
    onSuccess: afterWrite,
    onError: (e) => setErr(userMessage(e)),
  });

  const remarks = query.data?.remarks ?? [];
  const summary = query.data?.summary;
  const submittable = rating !== null && text.trim().length > 0 && text.trim().length <= 1000 && !create.isPending;
  const fs = compact ? '11.5px' : '12.5px';
  const inputStyle: React.CSSProperties = {
    padding: compact ? '6px 9px' : '8px 11px', fontSize: fs, borderRadius: '7px',
    background: 'var(--bg-page)', color: 'inherit', border: '1px solid var(--border-color)',
  };

  return (
    <div>
      {confirmDialog}
      {/* The number the engine used, stated up front so nobody has to guess why a score moved. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: compact ? '8px' : '12px', flexWrap: 'wrap' }}>
        <MessageSquare size={compact ? 12 : 14} style={{ color: 'var(--text-muted)' }} />
        {summary && summary.count > 0 ? (
          <span style={{ fontSize: fs, color: 'var(--text-secondary)' }}>
            <strong>{summary.count}</strong> rated remark{summary.count === 1 ? '' : 's'} in the last year ·
            {' '}recency-weighted average{' '}
            <strong style={{ color: ratingTone(summary.weightedMean).fg }}>{fmtSignedMean(summary.weightedMean)}</strong>
            <span title="How the engine folds remarks in: score = 50 + 25 × weighted mean, so −2 across the board is 0 and +2 is 100. Worth 6% of a recommendation — enough to settle a close call, never enough to remove anyone." style={{ marginLeft: '6px', color: 'var(--text-muted)', cursor: 'help', fontSize: '10.5px' }}>
              (scores {Math.round(50 + 25 * (summary.weightedMean ?? 0))}/100 in planning)
            </span>
          </span>
        ) : (
          <span style={{ fontSize: fs, color: 'var(--text-muted)' }}>
            {query.isLoading ? 'Loading remarks…' : 'No rated remarks in the last year — scores a neutral 50/100 in planning.'}
          </span>
        )}
      </div>

      {canWrite && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: compact ? '10px' : '14px', padding: compact ? '8px' : '10px', border: '1px solid var(--border-color)', borderRadius: '8px', background: 'var(--bg-surface-2)' }}>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Rating</span>
            {RATINGS.map((r) => {
              const on = rating === r.value;
              const tone = ratingTone(r.value);
              return (
                <button key={r.value} type="button" title={r.hint} onClick={() => setRating(r.value)}
                  style={{
                    fontSize: '11px', fontWeight: 700, padding: '3px 9px', borderRadius: '6px', cursor: 'pointer',
                    background: on ? tone.bg : 'transparent', color: on ? tone.fg : 'var(--text-secondary)',
                    border: `1px solid ${on ? tone.fg : 'var(--border-color)'}`,
                  }}>
                  {r.label}
                </button>
              );
            })}
            <Select
              value={category}
              onChange={(v) => setCategory(v as Category)}
              options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
              compact={compact}
              style={{ marginLeft: 'auto', background: 'var(--bg-page)' }}
            />
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={1000}
              onKeyDown={(e) => { if (e.key === 'Enter' && submittable) create.mutate(); }}
              placeholder={rating === null ? 'Pick a rating, then say what you saw…' : 'What did you see? Be specific — this is read before the next offer.'}
              style={{ ...inputStyle, flex: 1 }} />
            <button type="button" onClick={() => create.mutate()} disabled={!submittable} className="btn btn-primary" style={{ fontSize: '12px', padding: compact ? '6px 10px' : '8px 12px' }}>
              <Send size={12} />
            </button>
          </div>
          {err && <div style={{ fontSize: '11px', color: 'var(--danger)' }}>{err}</div>}
        </div>
      )}
      {!canWrite && err && <div style={{ fontSize: '11px', color: 'var(--danger)', marginBottom: '8px' }}>{err}</div>}

      {query.isError ? (
        <div style={{ fontSize: fs, color: 'var(--danger)' }}>{userMessage(query.error)}</div>
      ) : remarks.length === 0 && !query.isLoading ? (
        <div style={{ fontSize: fs, color: 'var(--text-muted)', padding: compact ? '8px 0' : '14px 0' }}>No remarks yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', maxHeight: compact ? '280px' : undefined, overflowY: compact ? 'auto' : undefined }}>
          {remarks.map((r) => {
            const tone = ratingTone(r.rating);
            const mine = !!userId && r.authorId === userId;
            return (
              <div key={r.id} style={{ padding: compact ? '7px 0' : '10px 0', borderBottom: '1px solid var(--border-hair)', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                <span title={r.rating == null ? 'Unrated note' : `Rating ${fmtSignedMean(r.rating)}`} style={{ flexShrink: 0, minWidth: '30px', textAlign: 'center', fontSize: '11px', fontWeight: 700, padding: '2px 6px', borderRadius: '6px', background: tone.bg, color: tone.fg }}>
                  {r.rating == null ? '·' : fmtSignedMean(r.rating).replace('.0', '')}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: fs, lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.content}</div>
                  <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '3px' }}>
                    <span style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.02em' }}>{r.category}</span>
                    {' · '}{r.authorName} <span style={{ fontStyle: 'italic' }}>({authorRoleLabel(r.authorRole)})</span>
                    {' · '}{fmtWhen(r.createdAt)}
                    {r.assignmentId && <> · about one assignment</>}
                  </div>
                </div>
                {(mine || canModerate) && (
                  <button type="button" title={mine ? 'Retract your remark' : 'Remove this remark (moderator)'} disabled={remove.isPending}
                    onClick={async () => {
                      // Wording kept from the dialog this replaces: it already said the one
                      // thing people get wrong here — removing it from the list does not
                      // erase it from the trail.
                      const ok = await confirm({
                        title: mine ? 'Retract this remark?' : 'Remove this remark?',
                        message: 'It stops showing on the assayer\u2019s record, but it stays in the audit trail.',
                        confirmLabel: mine ? 'Retract remark' : 'Remove remark',
                        reversible: false,
                        tone: 'danger',
                      });
                      if (ok) remove.mutate(r.id);
                    }}
                    style={{ flexShrink: 0, background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px' }}>
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default AssayerRemarks;
