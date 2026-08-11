import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, FileText, Search } from 'lucide-react';

import { api } from '../../services/api';
import { useCurrentRoles } from '../../hooks/useCurrentRoles';
import { userMessage } from '../../services/errors';
import {
  deskRole, deskCard, deskLabel, fmtWhen,
  PagedQueue, PacketRow, TeamMember,
} from './deskRoles';

/**
 * The packet queue: every returned audit packet, as a server-paginated table.
 *
 * Heads see the whole desk (with an assignee filter and per-row delegation);
 * validators see only their own packets. Lane chips (waiting / working / rework /
 * left desk) carry server-computed counts, search matches branch name/code/file,
 * and the page never holds more than one page of rows regardless of desk size.
 */

const LANES: Array<{ key: '' | 'unassigned' | 'working' | 'rework' | 'done'; label: string; tone: string }> = [
  { key: '', label: 'All', tone: 'var(--text-secondary)' },
  { key: 'unassigned', label: 'Waiting to assign', tone: 'var(--warning)' },
  { key: 'working', label: 'Being worked', tone: 'var(--accent)' },
  { key: 'rework', label: 'Rework', tone: 'var(--danger)' },
  { key: 'done', label: 'Left the desk', tone: 'var(--success)' },
];

const LANE_CHIP: Record<string, { label: string; color: string }> = {
  unassigned: { label: 'WAITING', color: 'var(--warning)' },
  working: { label: 'WORKING', color: 'var(--accent)' },
  rework: { label: 'REWORK', color: 'var(--danger)' },
  done: { label: 'WITH HEAD', color: 'var(--success)' },
};

const PAGE_SIZE = 25;

export const PacketsQueue: React.FC = () => {
  const roles = useCurrentRoles();
  const { isHead } = deskRole(roles);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const lane = (params.get('lane') ?? '') as '' | 'unassigned' | 'working' | 'rework' | 'done';
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  // Seeded from the URL so the Overview's member cards can deep-link straight to
  // "everything this person holds".
  const [assignee, setAssignee] = useState(params.get('assignedTo') ?? '');
  const [data, setData] = useState<PagedQueue<PacketRow> | null>(null);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Debounced search so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (lane) qs.set('lane', lane);
    if (search) qs.set('search', search);
    if (isHead && assignee) qs.set('assignedTo', assignee);
    const base = isHead ? '/documents/data-entry/queue' : '/documents/data-entry/mine';
    api.request<PagedQueue<PacketRow>>(`${base}?${qs}`)
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(userMessage(e)));
  }, [isHead, lane, search, assignee, page]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!isHead) return;
    api.request<TeamMember[]>('/documents/data-entry/team')
      .then((t) => setTeam(Array.isArray(t) ? t : []))
      .catch(() => setTeam([]));
  }, [isHead]);

  const setLane = (l: string) => {
    const next = new URLSearchParams(params);
    if (l) next.set('lane', l); else next.delete('lane');
    setParams(next, { replace: true });
    setPage(1);
  };

  const assign = async (docId: string, assigneeId: string) => {
    if (!assigneeId) return;
    setBusy(docId);
    try {
      await api.request(`/documents/${docId}/assign-data-entry`, { method: 'POST', body: JSON.stringify({ assigneeId }) });
      load();
    } catch (e) { setErr(userMessage(e)); }
    setBusy(null);
  };

  const handBack = async (docId: string) => {
    setBusy(docId);
    try {
      await api.request(`/documents/${docId}/complete-data-entry`, { method: 'POST' });
      load();
    } catch (e) { setErr(userMessage(e)); }
    setBusy(null);
  };

  const totalPages = useMemo(() => (data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1), [data]);
  const visibleLanes = isHead ? LANES : LANES.filter((l) => l.key !== 'unassigned');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        {visibleLanes.map((l) => {
          const active = lane === l.key;
          const count = l.key === '' ? undefined : data?.counts?.[l.key as keyof typeof data.counts];
          return (
            <button key={l.key || 'all'} onClick={() => setLane(l.key)}
              className={active ? 'btn btn-primary' : 'btn btn-secondary'}
              style={{ fontSize: '12px', padding: '6px 12px', width: 'auto', display: 'flex', gap: '6px', alignItems: 'center' }}>
              {l.label}
              {count != null && <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.8 }}>{count}</span>}
            </button>
          );
        })}
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', background: 'var(--bg-input)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '6px 10px' }}>
          <Search size={13} style={{ color: 'var(--text-muted)' }} />
          <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search branch / code / file…"
            style={{ background: 'transparent', border: 'none', outline: 'none', color: 'inherit', fontSize: '12.5px', width: '190px' }} />
        </span>
        {isHead && (
          <select value={assignee} onChange={(e) => { setAssignee(e.target.value); setPage(1); }}
            style={{ padding: '6px 10px', fontSize: '12px', borderRadius: '8px', background: 'var(--bg-input)', color: 'inherit', border: '1px solid var(--border-color)' }}>
            <option value="">Everyone</option>
            <option value="unassigned">Unassigned</option>
            {team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
      </div>

      {err && (
        <div style={{ padding: '9px 13px', borderRadius: '8px', background: 'var(--status-cancelled-bg)', color: 'var(--danger)', fontSize: '12.5px', display: 'flex', gap: '7px', alignItems: 'center' }}>
          <AlertTriangle size={14} /> {err}
        </div>
      )}

      <section style={{ ...deskCard, padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
              {['Branch', 'Received', 'With', 'Lane', ''].map((h) => (
                <th key={h} style={{ ...deskLabel, textAlign: 'left', padding: '10px 14px', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data?.items.length === 0 && (
              <tr><td colSpan={5} style={{ padding: '22px 14px', color: 'var(--text-muted)', textAlign: 'center' }}>
                No packets{lane ? ' in this lane' : ''}{search ? ` matching “${search}”` : ''}.
              </td></tr>
            )}
            {data?.items.map((d) => {
              const chip = LANE_CHIP[d.lane];
              return (
                <tr key={d.id} style={{ borderBottom: '1px solid var(--border-hair)' }}>
                  <td style={{ padding: '9px 14px' }}>
                    <div style={{ fontWeight: 600 }}>{d.branchName ?? d.fileName}</div>
                    <div style={{ ...deskLabel, fontSize: '10px' }}>{d.branchCode ?? '—'}</div>
                  </td>
                  <td style={{ padding: '9px 14px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{fmtWhen(d.receivedAt)}</td>
                  <td style={{ padding: '9px 14px', whiteSpace: 'nowrap' }}>
                    {d.lane === 'unassigned' && isHead ? (
                      <select defaultValue="" disabled={busy === d.id} onChange={(e) => assign(d.id, e.target.value)}
                        style={{ padding: '5px 9px', fontSize: '11.5px', fontWeight: 600, borderRadius: '6px', background: 'var(--bg-input)', color: 'inherit', border: '1px solid var(--border-color)' }}>
                        <option value="">Assign to…</option>
                        {team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    ) : (
                      <span style={{ color: d.assigneeName ? 'inherit' : 'var(--text-muted)' }}>{d.assigneeName ?? '—'}</span>
                    )}
                  </td>
                  <td style={{ padding: '9px 14px' }}>
                    {chip && (
                      <span style={{ fontSize: '9.5px', fontWeight: 800, padding: '2px 8px', borderRadius: '8px', color: chip.color, border: `1px solid ${chip.color}`, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
                        {chip.label}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '9px 14px', whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: '6px' }}>
                      {(d.lane === 'working' || d.lane === 'rework') && (
                        <button onClick={() => handBack(d.id)} disabled={busy === d.id} className="btn btn-secondary"
                          style={{ fontSize: '11.5px', padding: '5px 10px', width: 'auto', fontWeight: 700 }}>
                          {busy === d.id ? 'Saving…' : '✓ Hand back'}
                        </button>
                      )}
                      <button onClick={() => d.projectBranchId && navigate(`/data-entry/case/${d.projectBranchId}`)}
                        disabled={!d.projectBranchId} className="btn btn-secondary"
                        style={{ fontSize: '11.5px', padding: '5px 10px', width: 'auto', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <FileText size={12} /> Open
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', color: 'var(--text-secondary)' }}>
        <span>{data ? `${data.total} packet${data.total === 1 ? '' : 's'}` : '…'}</span>
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

export default PacketsQueue;
