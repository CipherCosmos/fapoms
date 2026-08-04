import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Search, X, ChevronUp, ChevronDown, ExternalLink, Edit2, Trash2,
  AlertTriangle, Download, ArrowRightLeft, MapPin, CheckCircle2, Users, SlidersHorizontal,
} from 'lucide-react';
import { AssayerLifecycleStatus } from '@fapoms/shared';

import { api } from '../../services/api';
import { connectSocket } from '../../services/socket';
import { UploadExcelControls } from '../../components/ui';
import { useCurrentRoles, canManageAssayers } from '../../hooks/useCurrentRoles';
import { CreateAssayerModal, EditAssayerModal } from './AssayerForms';
import type { Assayer } from './assayer-shared';
import { STATUS_COLORS } from './assayer-shared';
import { AssayerDetailDrawer } from './AssayerDetailDrawer';

/**
 * The workforce roster.
 *
 * Rebuilt from a 380px card list beside a detail panel, which showed about eight
 * people at a time and hid the facts HR actually act on. A roster is a table: you
 * scan it, sort it, filter it, and act on many rows at once. Detail moved to a
 * drawer so opening someone doesn't cost you your place in the list.
 *
 * The columns are chosen from what the HR console flags — record completeness,
 * lifecycle stage, tenure — so the thing the dashboard tells you to fix is the
 * thing you can see and fix here.
 */

/** Fields that block payroll, statutory filing or duty-of-care if empty. */
const CRITICAL_FIELDS: { key: keyof Assayer; label: string }[] = [
  { key: 'panNumber', label: 'PAN' },
  { key: 'bankAccountNumber', label: 'Bank a/c' },
  { key: 'ifscCode', label: 'IFSC' },
  { key: 'joiningDate', label: 'Joining date' },
  { key: 'emergencyContactPhone', label: 'Emergency contact' },
];

const ONBOARDING_STAGES: string[] = [
  AssayerLifecycleStatus.INVITED,
  AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
  AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
  AssayerLifecycleStatus.TRAINING,
];

/** Legal next steps per stage, mirroring the backend state machine. */
const LIFECYCLE_TRANSITIONS: Record<string, string[]> = {
  [AssayerLifecycleStatus.INVITED]: [AssayerLifecycleStatus.DOCUMENT_VERIFICATION],
  [AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: [AssayerLifecycleStatus.BACKGROUND_VERIFICATION],
  [AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: [AssayerLifecycleStatus.TRAINING],
  [AssayerLifecycleStatus.TRAINING]: [AssayerLifecycleStatus.ACTIVE],
  [AssayerLifecycleStatus.ACTIVE]: [AssayerLifecycleStatus.ON_LEAVE, AssayerLifecycleStatus.SUSPENDED, AssayerLifecycleStatus.RESIGNED, AssayerLifecycleStatus.TERMINATED],
  [AssayerLifecycleStatus.ON_LEAVE]: [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.RESIGNED],
  [AssayerLifecycleStatus.SUSPENDED]: [AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.TERMINATED],
};

/** Ordered path from `from` to `target` walking only legal transitions; [] if
 *  already there, null if unreachable. Mirrors the backend state machine so the
 *  roster can offer the same destinations the API will accept. */
function findPathTo(from: string, target: string): string[] | null {
  if (from === target) return [];
  const queue: { stage: string; path: string[] }[] = [{ stage: from, path: [] }];
  const visited = new Set<string>([from]);
  while (queue.length) {
    const { stage, path } = queue.shift()!;
    for (const next of LIFECYCLE_TRANSITIONS[stage] ?? []) {
      if (next === target) return [...path, next];
      if (!visited.has(next)) {
        visited.add(next);
        queue.push({ stage: next, path: [...path, next] });
      }
    }
  }
  return null;
}

/** One-click views onto the questions HR ask most. */
const SEGMENTS: { key: string; label: string; match: (a: Assayer) => boolean }[] = [
  { key: 'all', label: 'Everyone', match: () => true },
  { key: 'active', label: 'Active', match: (a) => a.lifecycleStatus === AssayerLifecycleStatus.ACTIVE },
  { key: 'onboarding', label: 'Onboarding', match: (a) => ONBOARDING_STAGES.includes(a.lifecycleStatus) },
  { key: 'incomplete', label: 'Incomplete record', match: (a) => missingFields(a).length > 0 },
  { key: 'unprofiled', label: 'No skills', match: (a) => !a.skills || a.skills.length === 0 },
  { key: 'exited', label: 'Exited', match: (a) => !!a.exitDate || !!a.terminationDate },
];

type SortKey = 'displayName' | 'assayerCode' | 'lifecycleStatus' | 'state' | 'experienceYears' | 'completeness' | 'joiningDate';

function missingFields(a: Assayer): string[] {
  return CRITICAL_FIELDS.filter((f) => {
    const v = a[f.key];
    return v === null || v === undefined || String(v).trim() === '';
  }).map((f) => f.label);
}

const fmtDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

/** Tenure in whole months, or null when the joining date was never captured. */
function tenureMonths(a: Assayer): number | null {
  if (!a.joiningDate) return null;
  const start = new Date(a.joiningDate).getTime();
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.floor((Date.now() - start) / (1000 * 60 * 60 * 24 * 30.44)));
}

const cell: React.CSSProperties = { padding: '9px 12px', fontSize: '12.5px', verticalAlign: 'middle' };
const head: React.CSSProperties = {
  padding: '8px 12px', fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em',   color: 'var(--text-muted)', textAlign: 'left',
  whiteSpace: 'nowrap', userSelect: 'none',
};

export const AssayerRoster: React.FC = () => {
  const navigate = useNavigate();
  const canManage = canManageAssayers(useCurrentRoles());

  const [assayers, setAssayers] = useState<Assayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const [segment, setSegment] = useState('all');
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [showFilters, setShowFilters] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'displayName', dir: 'asc' });

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Assayer | null>(null);
  const [creating, setCreating] = useState(false);
  const [bulkTarget, setBulkTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [bulkReport, setBulkReport] = useState<{ target: string; succeeded: string[]; skipped: { id: string; current: string; reason: string }[]; failed: { id: string; reason: string }[] } | null>(null);
  const RENDER_CHUNK = 200;
  const [visibleCount, setVisibleCount] = useState(RENDER_CHUNK);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request<Assayer[]>('/assayers?limit=1000');
      setAssayers(Array.isArray(res) ? res : []);
    } catch (e) {
      setNotice({ tone: 'err', text: `Could not load the roster: ${(e as Error).message}` });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Lifecycle changes can come from anywhere — a bulk action here, an admin
  // elsewhere, a backend job. Keep the roster live rather than stale until reload.
  useEffect(() => {
    const socket = connectSocket();
    const events = [
      'AssayerActivated', 'AssayerSuspended', 'AssayerDeactivated', 'AssayerOnLeave',
      'AssayerResigned', 'AssayerTerminated', 'AssayerArchived',
      'AssayerDocumentVerificationStarted', 'AssayerBackgroundCheckInitiated', 'AssayerTrainingStarted',
    ];
    events.forEach((e) => socket?.on(e, load));
    return () => { events.forEach((e) => socket?.off(e, load)); };
  }, [load]);

  const states = useMemo(
    () => [...new Set(assayers.map((a) => a.state).filter(Boolean))].sort(),
    [assayers],
  );
  const statuses = useMemo(
    () => [...new Set(assayers.map((a) => a.lifecycleStatus).filter(Boolean))].sort(),
    [assayers],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const seg = SEGMENTS.find((s) => s.key === segment) ?? SEGMENTS[0];
    const filtered = assayers.filter((a) => {
      if (!seg.match(a)) return false;
      if (stateFilter !== 'ALL' && a.state !== stateFilter) return false;
      if (statusFilter !== 'ALL' && a.lifecycleStatus !== statusFilter) return false;
      if (!q) return true;
      return `${a.displayName} ${a.assayerCode} ${a.city} ${a.district} ${a.state} ${a.phone} ${a.email ?? ''} ${(a.skills ?? []).join(' ')}`
        .toLowerCase().includes(q);
    });

    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((x, y) => {
      let a: any, b: any;
      if (sort.key === 'completeness') { a = missingFields(x).length; b = missingFields(y).length; }
      else if (sort.key === 'joiningDate') { a = x.joiningDate ?? ''; b = y.joiningDate ?? ''; }
      else { a = (x as any)[sort.key] ?? ''; b = (y as any)[sort.key] ?? ''; }
      if (typeof a === 'number' && typeof b === 'number') return (a - b) * dir;
      return String(a).localeCompare(String(b)) * dir;
    });
  }, [assayers, search, segment, stateFilter, statusFilter, sort]);

  useEffect(() => { setVisibleCount(RENDER_CHUNK); }, [assayers, search, segment, stateFilter, statusFilter, sort]);

  const allShownSelected = rows.length > 0 && rows.every((r) => selectedIds.has(r.id));
  const selected = useMemo(() => assayers.filter((a) => selectedIds.has(a.id)), [assayers, selectedIds]);

  /** Every target stage reachable from *any* selected row (walking forward through
   *  the state machine). Unlike a strict intersection this works for mixed-stage
   *  batches — the backend skips rows that can't reach the chosen target. */
  const bulkOptions = useMemo(() => {
    if (selected.length === 0) return [];
    const reachable = new Set<string>();
    for (const a of selected) {
      for (const s of Object.values(AssayerLifecycleStatus)) {
        if (s === a.lifecycleStatus) continue;
        if (findPathTo(a.lifecycleStatus, s) !== null) reachable.add(s);
      }
    }
    return Object.values(AssayerLifecycleStatus).filter((s) => reachable.has(s));
  }, [selected]);

  const toggle = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const sortBy = (key: SortKey) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));

  const runBulkTransition = async () => {
    if (!bulkTarget || selected.length === 0) return;
    setBusy(true);
    setBulkReport(null);
    const ids = selected.map((a) => a.id);
    try {
      const res = await api.request<{ succeeded: { id: string; from: string; to: string }[]; skipped: { id: string; current: string; reason: string }[]; failed: { id: string; reason: string }[] }>(
        '/assayers/bulk/lifecycle',
        {
          method: 'POST',
          body: JSON.stringify({ ids, targetStatus: bulkTarget, reason: `Bulk transition to ${bulkTarget}` }),
        },
      );
      const { succeeded, skipped, failed } = res ?? { succeeded: [], skipped: [], failed: [] };
      setBulkReport({ target: bulkTarget, succeeded: succeeded.map((s) => s.id), skipped, failed });
      const moved = succeeded.length;
      setNotice(
        failed.length || skipped.length
          ? {
              tone: 'err',
              text: `${moved} moved to ${bulkTarget.replace(/_/g, ' ')}, ${skipped.length} skipped, ${failed.length} failed.`,
            }
          : { tone: 'ok', text: `${moved} assayer(s) moved to ${bulkTarget.replace(/_/g, ' ')}.` },
      );
    } catch (e) {
      setNotice({ tone: 'err', text: `Bulk move failed: ${(e as Error).message}` });
    } finally {
      setBusy(false);
      setBulkTarget('');
      setSelectedIds(new Set());
      load();
    }
  };

  const remove = async (a: Assayer) => {
    if (!window.confirm(`Delete ${a.displayName} (${a.assayerCode})? This cannot be undone.`)) return;
    try {
      await api.request(`/assayers/${a.id}`, { method: 'DELETE' });
      setNotice({ tone: 'ok', text: `${a.displayName} deleted.` });
      setOpenId(null);
      load();
    } catch (e) {
      setNotice({ tone: 'err', text: (e as Error).message });
    }
  };

  /** Exports exactly what is on screen — same filter, same sort, same order. */
  const exportCsv = () => {
    const cols = ['assayerCode', 'displayName', 'phone', 'email', 'city', 'district', 'state', 'lifecycleStatus', 'employmentType', 'joiningDate', 'experienceYears'];
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      [...cols, 'missingFields'].join(','),
      ...rows.map((r) => [...cols.map((c) => esc((r as any)[c])), esc(missingFields(r).join('; '))].join(',')),
    ].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const el = document.createElement('a');
    el.href = url;
    el.download = `workforce-roster-${new Date().toISOString().slice(0, 10)}.csv`;
    el.click();
    URL.revokeObjectURL(url);
  };

  const handleUpload = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    try {
      await api.request('/assayers/upload', { method: 'POST', body: fd });
      setNotice({ tone: 'ok', text: 'Roster imported.' });
      load();
    } catch (e) {
      setNotice({ tone: 'err', text: (e as Error).message });
    }
  };

  const downloadTemplate = async () => {
    const blob = await api.request<Blob>('/assayers/template/download', { raw: true } as any);
    const url = URL.createObjectURL(blob as any);
    const el = document.createElement('a');
    el.href = url;
    el.download = 'assayer-template.xlsx';
    el.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {notice && (
        <div style={{
          padding: '10px 14px', borderRadius: '8px', fontSize: '13px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: notice.tone === 'ok' ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)',
          color: notice.tone === 'ok' ? 'var(--success)' : 'var(--danger)',
        }}>
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}><X size={14} /></button>
        </div>
      )}

      {/* Segments: the questions HR ask, as one click each. */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
        {SEGMENTS.map((s) => {
          const n = assayers.filter(s.match).length;
          const on = segment === s.key;
          return (
            <button
              key={s.key}
              onClick={() => setSegment(s.key)}
              style={{
                padding: '5px 11px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${on ? 'transparent' : 'var(--border-color)'}`,
                background: on ? 'var(--accent)' : 'transparent',
                color: on ? 'var(--on-accent)' : 'var(--text-secondary)',
              }}
            >
              {s.label} <span style={{ opacity: 0.75 }}>{n}</span>
            </button>
          );
        })}
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 260px', minWidth: '220px' }}>
          <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, code, phone, city, skill…"
            style={{
              width: '100%', padding: '8px 10px 8px 30px', fontSize: '13px', borderRadius: '8px',
              border: '1px solid var(--border-color)', background: 'var(--bg-page)', color: 'inherit', outline: 'none',
            }}
          />
        </div>
        <button onClick={() => setShowFilters((v) => !v)} className="btn btn-secondary"
          style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 12px' }}>
          <SlidersHorizontal size={13} /> Filters
        </button>
        <button onClick={exportCsv} className="btn btn-secondary"
          style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 12px' }}>
          <Download size={13} /> Export {rows.length}
        </button>
        {canManage && (
          <>
            <UploadExcelControls onUpload={handleUpload} onDownloadTemplate={downloadTemplate} accept=".xlsx,.xls" />
            <button onClick={() => setCreating(true)} className="btn btn-primary"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', padding: '8px 14px' }}>
              <Plus size={14} /> Add assayer
            </button>
          </>
        )}
      </div>

      {showFilters && (
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', padding: '10px 12px', borderRadius: '8px', background: 'var(--bg-surface-2)' }}>
          <Select label="State" value={stateFilter} onChange={setStateFilter} options={states} />
          <Select label="Lifecycle" value={statusFilter} onChange={setStatusFilter} options={statuses} />
          {(stateFilter !== 'ALL' || statusFilter !== 'ALL' || search) && (
            <button
              onClick={() => { setStateFilter('ALL'); setStatusFilter('ALL'); setSearch(''); }}
              className="btn btn-secondary" style={{ fontSize: '11px', padding: '6px 10px', alignSelf: 'flex-end' }}
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {/* Bulk bar — only present when a selection exists, so it never adds noise. */}
      {canManage && selected.length > 0 && (
        <div style={{
          display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap',
          padding: '10px 14px', borderRadius: '8px',
          background: 'var(--status-pending-bg)', border: '1px solid rgba(216,174,71,0.3)',
        }}>
          <strong style={{ fontSize: '13px' }}>{selected.length} selected</strong>
          <ArrowRightLeft size={13} style={{ color: 'var(--text-muted)' }} />
          {bulkOptions.length > 0 ? (
            <select
              value={bulkTarget}
              onChange={(e) => setBulkTarget(e.target.value)}
              style={{ padding: '6px 10px', fontSize: '12px', borderRadius: '6px', background: 'var(--bg-page)', color: 'inherit', border: '1px solid var(--border-color)' }}
            >
              <option value="">Move all to…</option>
              {bulkOptions.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
            </select>
          ) : (
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              No stage is reachable from the selected rows.
            </span>
          )}
          <button onClick={runBulkTransition} disabled={!bulkTarget || busy} className="btn btn-primary" style={{ fontSize: '12px', padding: '6px 12px' }}>
            {busy ? 'Applying…' : 'Apply'}
          </button>
          <button onClick={() => setSelectedIds(new Set())} className="btn btn-secondary" style={{ fontSize: '12px', padding: '6px 12px', marginLeft: 'auto' }}>
            Clear selection
          </button>
        </div>
      )}

      {/* Bulk result report — what actually moved, and which rows could not reach
          the target, with per-row reasons. */}
      {bulkReport && (
        <div style={{
          marginTop: '10px', padding: '12px 14px', borderRadius: '8px', fontSize: '12px',
          background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)',
        }}>
          <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', fontWeight: 600, marginBottom: '8px' }}>
            <span style={{ color: 'var(--status-active-text)' }}>{bulkReport.succeeded.length} moved</span>
            <span style={{ color: 'var(--text-muted)' }}>{bulkReport.skipped.length} skipped</span>
            {bulkReport.failed.length > 0 && <span style={{ color: 'var(--status-danger-text)' }}>{bulkReport.failed.length} failed</span>}
            <button onClick={() => setBulkReport(null)} className="btn btn-secondary" style={{ fontSize: '11px', padding: '2px 8px', marginLeft: 'auto' }}>Dismiss</button>
          </div>
          {bulkReport.skipped.length > 0 && (
            <div style={{ marginTop: '6px' }}>
              <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>Could not reach {bulkReport.target.replace(/_/g, ' ')}:</div>
              {bulkReport.skipped.map((s) => (
                <div key={s.id} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                  <span style={{ color: 'inherit' }}>{s.current}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>— {s.reason}</span>
                </div>
              ))}
            </div>
          )}
          {bulkReport.failed.length > 0 && (
            <div style={{ marginTop: '6px' }}>
              <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>Failed:</div>
              {bulkReport.failed.map((f) => (
                <div key={f.id} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                  <span style={{ color: 'inherit' }}>{f.id.slice(0, 8)}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>— {f.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Roster */}
      <div style={{ border: '1px solid var(--border-color)', borderRadius: '10px', overflow: 'hidden', background: 'var(--bg-card)' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ background: 'var(--bg-surface-2)' }}>
              <tr>
                {canManage && (
                  <th style={{ ...head, width: '36px' }}>
                    <input
                      type="checkbox"
                      checked={allShownSelected}
                      onChange={() => setSelectedIds(allShownSelected ? new Set() : new Set(rows.map((r) => r.id)))}
                      style={{ cursor: 'pointer' }}
                    />
                  </th>
                )}
                <Th label="Assayer" k="displayName" sort={sort} onSort={sortBy} />
                <Th label="Code" k="assayerCode" sort={sort} onSort={sortBy} />
                <Th label="Stage" k="lifecycleStatus" sort={sort} onSort={sortBy} />
                <Th label="Location" k="state" sort={sort} onSort={sortBy} />
                <Th label="Record" k="completeness" sort={sort} onSort={sortBy} />
                <Th label="Joined" k="joiningDate" sort={sort} onSort={sortBy} />
                <Th label="Exp" k="experienceYears" sort={sort} onSort={sortBy} />
                <th style={{ ...head, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} style={{ ...cell, textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading roster…</td></tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ ...cell, textAlign: 'center', padding: '48px' }}>
                    <Users size={26} style={{ opacity: 0.35 }} />
                    <div style={{ fontSize: '14px', fontWeight: 600, marginTop: '10px' }}>Nobody matches this view</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px' }}>
                      {assayers.length === 0 ? 'The roster is empty — import a workforce file or add someone.' : 'Try a different segment or clear the filters.'}
                    </div>
                  </td>
                </tr>
              ) : rows.slice(0, visibleCount).map((a) => {
                const missing = missingFields(a);
                const tone = STATUS_COLORS[a.lifecycleStatus] ?? 'var(--text-muted)';
                const months = tenureMonths(a);
                return (
                  <tr
                    key={a.id}
                    onClick={() => setOpenId(a.id)}
                    style={{
                      borderTop: '1px solid var(--border-hair)', cursor: 'pointer',
                      background: selectedIds.has(a.id) ? 'rgba(216,174,71,0.12)' : undefined,
                    }}
                  >
                    {canManage && (
                      <td style={cell} onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selectedIds.has(a.id)} onChange={() => toggle(a.id)} style={{ cursor: 'pointer' }} />
                      </td>
                    )}
                    <td style={cell}>
                      <div style={{ fontWeight: 600 }}>{a.displayName}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{a.phone}</div>
                    </td>
                    <td style={{ ...cell, fontFamily: 'monospace', fontSize: '11px' }}>{a.assayerCode}</td>
                    <td style={cell}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11.5px', fontWeight: 600, color: tone }}>
                        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: tone }} />
                        {(a.lifecycleStatus ?? '').replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td style={cell}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                        <MapPin size={11} style={{ color: 'var(--text-muted)' }} />
                        {[a.city, a.state].filter(Boolean).join(', ') || '—'}
                      </span>
                    </td>
                    <td style={cell}>
                      {missing.length === 0 ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--success)', fontSize: '11.5px' }}>
                          <CheckCircle2 size={12} /> Complete
                        </span>
                      ) : (
                        <span
                          title={`Missing: ${missing.join(', ')}`}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--warning)', fontSize: '11.5px', fontWeight: 600 }}
                        >
                          <AlertTriangle size={12} /> {missing.length} missing
                        </span>
                      )}
                    </td>
                    <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                      {fmtDate(a.joiningDate)}
                      {months !== null && <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}> · {months}m</span>}
                    </td>
                    <td style={cell}>{a.experienceYears ?? 0}y</td>
                    <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                      <IconBtn title="Open full profile" onClick={() => navigate(`/assayers/${a.id}`)}><ExternalLink size={13} /></IconBtn>
                      {canManage && <IconBtn title="Edit" onClick={() => setEditing(a)}><Edit2 size={13} /></IconBtn>}
                      {canManage && <IconBtn title="Delete" tone="var(--danger)" onClick={() => remove(a)}><Trash2 size={13} /></IconBtn>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!loading && rows.length > 0 && (
          <div style={{ padding: '8px 12px', fontSize: '11.5px', color: 'var(--text-muted)', borderTop: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <span>
              Showing {Math.min(visibleCount, rows.length)} of {rows.length}
              {rows.filter((r) => missingFields(r).length > 0).length > 0 &&
                ` · ${rows.filter((r) => missingFields(r).length > 0).length} with an incomplete record`}
            </span>
            {rows.length > visibleCount && (
              <button onClick={() => setVisibleCount((c) => c + RENDER_CHUNK)} className="btn btn-secondary" style={{ padding: '4px 12px', fontSize: '11.5px' }}>
                Show more ({rows.length - visibleCount} more)
              </button>
            )}
          </div>
        )}
      </div>

      {openId && (
        <AssayerDetailDrawer
          assayerId={openId}
          canManage={canManage}
          onClose={() => setOpenId(null)}
          onEdit={(a) => setEditing(a)}
          onChanged={load}
        />
      )}
      {creating && (
        <CreateAssayerModal
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); load(); }}
          existingAssayersCount={assayers.length}
        />
      )}
      {editing && (
        <EditAssayerModal
          assayer={editing}
          onClose={() => setEditing(null)}
          onUpdated={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
};

const Th: React.FC<{ label: string; k: SortKey; sort: { key: SortKey; dir: string }; onSort: (k: SortKey) => void }> = ({
  label, k, sort, onSort,
}) => (
  <th style={{ ...head, cursor: 'pointer' }} onClick={() => onSort(k)}>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
      {label}
      {sort.key === k && (sort.dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
    </span>
  </th>
);

const IconBtn: React.FC<{ title: string; onClick: () => void; tone?: string; children: React.ReactNode }> = ({
  title, onClick, tone, children,
}) => (
  <button
    title={title}
    onClick={onClick}
    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 5px', color: tone ?? 'var(--text-muted)' }}
  >
    {children}
  </button>
);

const Select: React.FC<{ label: string; value: string; onChange: (v: string) => void; options: string[] }> = ({
  label, value, onChange, options,
}) => (
  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
    <span style={{ fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>{label}</span>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ padding: '6px 10px', fontSize: '12px', borderRadius: '6px', minWidth: '150px', background: 'var(--bg-page)', color: 'inherit', border: '1px solid var(--border-color)' }}
    >
      <option value="ALL">All</option>
      {options.map((o) => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}
    </select>
  </label>
);

export default AssayerRoster;
