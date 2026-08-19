import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, FileText, Search } from 'lucide-react';

import { api } from '../../services/api';
import { useCurrentRoles } from '../../hooks/useCurrentRoles';
import { userMessage } from '../../services/errors';
import { deskRole, deskCard, deskLabel, CaseListRow, TeamMember } from './deskRoles';
import { Select } from '../../components/ui';
import { validationStatusLabel } from '@fapoms/shared';

/**
 * The review queue: validation cases as a server-paginated table.
 *
 * Heads work it — route reviews among themselves, approve (single or bulk), send
 * back for rework, submit. Validators read it: the server scopes their view to the
 * branches whose packets they worked (`workedBy=me`), answering "where do my
 * handed-back reports stand" without downloading the desk.
 */

const STATUS_TABS: Array<{ key: string; label: string }> = [
  { key: 'HUMAN_REVIEW', label: 'In review' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'SUBMITTED', label: 'Submitted' },
  { key: '', label: 'All' },
];

const STATUS_CHIP: Record<string, string> = {
  PENDING: 'var(--text-muted)', ASSIGNED: 'var(--accent)', OCR_PROCESSING: 'var(--accent)',
  HUMAN_REVIEW: 'var(--warning)', CORRECTION_REQUIRED: 'var(--danger)',
  APPROVED: 'var(--success)', SUBMITTED: 'var(--success)',
};

const PAGE_SIZE = 25;

export const ReviewsQueue: React.FC = () => {
  const roles = useCurrentRoles();
  const { isHead } = deskRole(roles);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const status = params.get('status') ?? 'HUMAN_REVIEW';
  const unroutedOnly = params.get('routed') === 'no';
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<CaseListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [reviewers, setReviewers] = useState<TeamMember[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (status) qs.set('status', status);
    if (search) qs.set('search', search);
    if (isHead && unroutedOnly) qs.set('reviewerId', 'none');
    if (!isHead) qs.set('workedBy', 'me');
    api.request<{ data: CaseListRow[]; meta?: { pagination?: { total: number } } }>(`/validation?${qs}`, { method: 'GET', withMeta: true } as any)
      .then((r) => { setRows(r.data ?? []); setTotal(r.meta?.pagination?.total ?? 0); setErr(null); })
      .catch((e) => setErr(userMessage(e)));
  }, [isHead, status, unroutedOnly, search, page]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!isHead) return;
    api.request<TeamMember[]>('/validation/team')
      .then((t) => setReviewers(Array.isArray(t) ? t : []))
      .catch(() => setReviewers([]));
  }, [isHead]);

  const setStatus = (s: string) => {
    const next = new URLSearchParams(params);
    if (s) next.set('status', s); else next.delete('status');
    setParams(next, { replace: true });
    setPage(1);
    setSel(new Set());
  };

  const toggleUnrouted = () => {
    const next = new URLSearchParams(params);
    if (unroutedOnly) next.delete('routed'); else next.set('routed', 'no');
    setParams(next, { replace: true });
    setPage(1);
  };

  const route = async (caseId: string, reviewerId: string) => {
    if (!reviewerId) return;
    setBusy(caseId);
    try {
      await api.request(`/validation/${caseId}/assign`, { method: 'POST', body: JSON.stringify({ reviewerId }) });
      load();
    } catch (e) { setErr(userMessage(e)); }
    setBusy(null);
  };

  const bulkDecide = async (target: 'APPROVED' | 'CORRECTION_REQUIRED') => {
    if (sel.size === 0) return;
    setMsg(null);
    setBusy('__bulk__');
    try {
      const res = await api.request<{ succeeded: { id: string }[]; failed: { id: string; reason: string }[] }>('/validation/bulk/transition', {
        method: 'POST',
        body: JSON.stringify({ ids: Array.from(sel), targetStatus: target, remarks: note.trim() || undefined }),
      });
      const s = res.succeeded?.length ?? 0;
      const f = res.failed ?? [];
      setMsg(f.length
        ? { type: 'error', text: `${s} updated · ${f.length} failed: ${f.map((x) => x.reason).join('; ')}` }
        : { type: 'success', text: `${s} ${target === 'APPROVED' ? 'approved' : 'sent back for rework'}` });
      setSel(new Set());
      setNote('');
      load();
    } catch (e) { setMsg({ type: 'error', text: userMessage(e) }); }
    setBusy(null);
  };

  const toggle = (id: string) => setSel((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total]);
  const showBulk = isHead && status === 'HUMAN_REVIEW';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        {STATUS_TABS.map((t) => (
          <button key={t.key || 'all'} onClick={() => setStatus(t.key)}
            className={status === t.key ? 'btn btn-primary' : 'btn btn-secondary'}
            style={{ fontSize: '12px', padding: '6px 12px', width: 'auto' }}>
            {t.label}
          </button>
        ))}
        {isHead && status === 'HUMAN_REVIEW' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: unroutedOnly ? 'var(--danger)' : 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={unroutedOnly} onChange={toggleUnrouted} /> Not routed only
          </label>
        )}
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', background: 'var(--bg-input)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '6px 10px' }}>
          <Search size={13} style={{ color: 'var(--text-muted)' }} />
          <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search branch / code…"
            style={{ background: 'transparent', border: 'none', outline: 'none', color: 'inherit', fontSize: '12.5px', width: '170px' }} />
        </span>
      </div>

      {err && (
        <div style={{ padding: '9px 13px', borderRadius: '8px', background: 'var(--status-cancelled-bg)', color: 'var(--danger)', fontSize: '12.5px', display: 'flex', gap: '7px', alignItems: 'center' }}>
          <AlertTriangle size={14} /> {err}
        </div>
      )}

      {showBulk && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', fontSize: '12px' }}>
          <span style={{ color: 'var(--text-muted)' }}>{sel.size} selected</span>
          {/*
            The note is optional to approve and required to reject. Sending work back without
            saying what is wrong leaves the data-entry operator looking at a case marked
            "CORRECTION REQUIRED" with nothing anywhere on the screen telling them what to fix —
            and the case-level "Request correction" control has always required notes, so the same
            decision had opposite rules depending on which screen you made it from.
          */}
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the decision (required to send back)"
            style={{ flex: '1 1 220px', padding: '6px 10px', fontSize: '12px', borderRadius: '7px', background: 'var(--bg-input)', color: 'inherit', border: '1px solid var(--border-color)', outline: 'none' }} />
          <button onClick={() => bulkDecide('APPROVED')} disabled={sel.size === 0 || busy === '__bulk__'} className="btn btn-primary"
            style={{ fontSize: '11.5px', padding: '6px 12px', width: 'auto' }}>
            {busy === '__bulk__' ? 'Saving…' : 'Approve selected'}
          </button>
          <button onClick={() => bulkDecide('CORRECTION_REQUIRED')} disabled={sel.size === 0 || busy === '__bulk__' || !note.trim()} className="btn btn-secondary"
            title={!note.trim() ? 'Add a note saying what needs correcting' : undefined}
            style={{ fontSize: '11.5px', padding: '6px 12px', width: 'auto', color: 'var(--danger)' }}>
            Send back for rework
          </button>
        </div>
      )}

      {msg && (
        <div style={{ padding: '8px 12px', borderRadius: '7px', fontSize: '12px', background: msg.type === 'success' ? 'var(--status-pending-bg)' : 'var(--status-cancelled-bg)', color: msg.type === 'success' ? 'var(--success)' : 'var(--danger)' }}>
          {msg.text}
        </div>
      )}

      <section style={{ ...deskCard, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
              {showBulk && <th style={{ width: '34px' }} />}
              {['Branch', 'Status', 'Reviewer', ''].map((h) => (
                <th key={h} style={{ ...deskLabel, textAlign: 'left', padding: '10px 14px', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={showBulk ? 5 : 4} style={{ padding: '22px 14px', color: 'var(--text-muted)', textAlign: 'center' }}>
                Nothing here{search ? ` matching “${search}”` : ''}.
              </td></tr>
            )}
            {rows.map((c) => {
              const branch = c.projectBranch?.branch;
              const tone = STATUS_CHIP[c.status] ?? 'var(--text-muted)';
              return (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--border-hair)' }}>
                  {showBulk && (
                    <td style={{ padding: '9px 0 9px 14px' }}>
                      <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} style={{ cursor: 'pointer' }} />
                    </td>
                  )}
                  <td style={{ padding: '9px 14px' }}>
                    <div style={{ fontWeight: 600 }}>{branch?.name ?? 'Branch'}</div>
                    <div style={{ ...deskLabel, fontSize: '10px' }}>{branch?.branchCode ?? '—'}</div>
                  </td>
                  <td style={{ padding: '9px 14px' }}>
                    <span style={{ fontSize: '10px', fontWeight: 800, padding: '2px 8px', borderRadius: '8px', color: tone, border: `1px solid ${tone}`, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
                      {validationStatusLabel(c.status)}
                    </span>
                  </td>
                  <td style={{ padding: '9px 14px', whiteSpace: 'nowrap' }}>
                    {isHead && c.status === 'HUMAN_REVIEW' ? (
                      <Select
                        compact
                        value={c.reviewerId ?? ''}
                        disabled={busy === c.id}
                        onChange={(v) => route(c.id, v)}
                        placeholder={c.reviewerId ? 'Re-route…' : 'Route to…'}
                        options={reviewers.map((v) => ({ value: v.id, label: v.name }))}
                        style={c.reviewerId ? undefined : { border: '1px solid var(--warning)' }}
                      />
                    ) : c.reviewerName ? (
                      <span>{c.reviewerName}</span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: '9px 14px', whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button onClick={() => navigate(`/data-entry/case/${c.projectBranchId}`)} className="btn btn-secondary"
                      style={{ fontSize: '11.5px', padding: '5px 10px', width: 'auto', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                      <FileText size={12} /> {isHead && c.status === 'HUMAN_REVIEW' ? 'Review' : 'Open'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', color: 'var(--text-secondary)' }}>
        <span>{total} case{total === 1 ? '' : 's'}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' }}>
          <button className="btn btn-secondary" style={{ fontSize: '11.5px', padding: '4px 10px', width: 'auto' }}
            disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{page} / {totalPages}</span>
          <button className="btn btn-secondary" style={{ fontSize: '11.5px', padding: '4px 10px', width: 'auto' }}
            disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next ›</button>
        </span>
      </div>
    </div>
  );
};

export default ReviewsQueue;
