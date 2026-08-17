import React, { useState, useMemo } from 'react';
import {
  Send, AlertTriangle, CheckCircle2, Clock, Search, FileText, ChevronRight, ChevronDown,
} from 'lucide-react';

const STAGE_META: Record<string, { label: string; color: string; bg: string }> = {
  UPLOADED: { label: 'Prepared', color: 'var(--accent)', bg: 'var(--status-pending-bg)' },
  DISPATCHED: { label: 'With assayer', color: 'var(--accent)', bg: 'var(--status-pending-bg)' },
  RECEIVED: { label: 'Returned', color: 'var(--success)', bg: 'var(--status-completed-bg)' },
  SENT_TO_DATA_ENTRY: { label: 'Data entry', color: 'var(--accent)', bg: 'var(--status-pending-bg)' },
  SENT_TO_EXTERNAL_OCR: { label: 'External OCR', color: 'var(--warning)', bg: 'var(--status-pending-bg)' },
  EXCEL_GENERATED: { label: 'Excel ready', color: 'var(--success)', bg: 'var(--status-completed-bg)' },
  PROCESSED: { label: 'Processed', color: 'var(--success)', bg: 'var(--status-completed-bg)' },
  COMPLETED: { label: 'Completed', color: 'var(--success)', bg: 'var(--status-completed-bg)' },
};

export interface DocRow {
  id: string;
  fileName: string;
  fileSize: number;
  type: string;
  status: string;
  createdAt: string;
  projectBranchId: string | null;
  assessmentId: string | null;
  branchName: string | null;
  branchCode: string | null;
  projectName: string | null;
  clientName: string | null;
  scheduledDate: string | null;
  daysUntilAudit?: number | null;
  trail: {
    uploadedAt: string | null;
    dispatchedAt: string | null;
    dispatchMethod: string | null;
    dispatchedByName: string | null;
    receivedAt: string | null;
    sentToDataEntryAt: string | null;
    sentToExternalOcrAt: string | null;
  };
}

/**
 * One branch card.
 *
 * `branchId`, `projectId`, `projectNumber`, `branchStatus` and `assessmentStatus` used to ride
 * along on every row and no view ever read one of them; they are no longer sent. If something
 * here needs them again, widen the SELECT in `document.service.ts` rather than reinstating the
 * whole projection — the branch list is 40k rows on the scale book.
 */
export interface BranchGroup {
  projectBranchId: string;
  branchName: string;
  branchCode: string | null;
  projectName: string;
  clientName: string | null;
  scheduledDate: string | null;
  daysUntilAudit: number | null;
  /** Audit confirmed, no packet prepared at all. Decided server-side, per row. */
  neverPrepared: boolean;
  documentCount: number;
  documentsByType: Record<string, DocRow[]>;
}

export interface OverviewData {
  documents: DocRow[];
  pipeline: Array<{ stage: string; count: number }>;
  totals: {
    total: number; awaitingDispatch: number; neverPrepared: number;
    outstandingReturns: number; inDataEntry: number; completed: number;
  };
  awaitingDispatch: DocRow[];
  blockingFieldWork: DocRow[];
  /**
   * ONE PAGE of branches, not every branch. The count of the set it was cut from arrives in
   * `meta.pagination.total`, so anything that needs "how many are there" must read that and
   * never `branches.length`.
   */
  branches: BranchGroup[];
  branchPagination: { page: number; limit: number; total: number };
  /** Capped alert list; `totals.neverPrepared` is the true count. */
  neverPrepared: BranchGroup[];
}

const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null);
const fmtSize = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/**
 * Document control console.
 *
 * Replaces a flat list of file name / type / status / date that showed neither
 * which branch a document belonged to nor any of the dispatch, return and
 * hand-off timestamps already recorded against it — so it could not answer
 * "where is this branch's paperwork" or "what is blocking tomorrow's audits".
 */
export const DocumentControlPanel: React.FC<{
  data: OverviewData;
  onDispatch: (ids: string[]) => Promise<void>;
  onDownload: (id: string) => void;
  busy?: boolean;
}> = ({ data, onDispatch, onDownload, busy }) => {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState<string>('ALL');
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.documents.filter((d) => {
      if (stage !== 'ALL' && d.status !== stage) return false;
      if (!q) return true;
      // Searching by branch or client is the common case in practice; the old page
      // could only match file name, type and status because nothing else was loaded.
      return [d.fileName, d.type, d.status, d.branchName, d.branchCode, d.projectName, d.clientName]
        .some((v) => v?.toLowerCase().includes(q));
    });
  }, [data.documents, search, stage]);

  const selectable = rows.filter((r) => r.status === 'UPLOADED');
  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const dispatchSelected = async () => {
    await onDispatch([...selected]);
    setSelected(new Set());
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Overdue paperwork blocks field work outright, so it leads. */}
      {data.blockingFieldWork.length > 0 && (
        <div style={{ background: 'var(--status-cancelled-bg)', border: '1px solid var(--status-cancelled-bg)', borderRadius: 'var(--radius-md)', padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--danger)', fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
            <AlertTriangle size={15} />
            {data.blockingFieldWork.length} audit{data.blockingFieldWork.length === 1 ? '' : 's'} blocked — paperwork never sent
          </div>
          {data.blockingFieldWork.map((d) => (
            <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '6px 0', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.5 }}>
                <strong>{d.branchName ?? 'Unknown branch'}</strong>
                <span style={{ color: 'var(--text-muted)' }}> · {d.fileName}</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 11.5, color: 'var(--danger)', fontWeight: 600 }}>
                  {d.daysUntilAudit != null && d.daysUntilAudit < 0
                    ? `audit was ${Math.abs(d.daysUntilAudit)} day(s) ago`
                    : 'audit due today'}
                </span>
                <button onClick={() => onDispatch([d.id])} disabled={busy} className="btn btn-primary" style={{ padding: '4px 10px', fontSize: 11.5 }}>
                  Send now
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Pipeline: where every document currently sits, in lifecycle order. */}
      <div>
        <Label>Pipeline</Label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Stage active={stage === 'ALL'} onClick={() => setStage('ALL')} label="All" count={data.totals.total} color="var(--text-secondary)" bg="var(--bg-surface-2)" />
          {data.pipeline.filter((s) => s.count > 0).map((s) => (
            <Stage
              key={s.stage}
              active={stage === s.stage}
              onClick={() => setStage(stage === s.stage ? 'ALL' : s.stage)}
              label={STAGE_META[s.stage]?.label ?? s.stage}
              count={s.count}
              color={STAGE_META[s.stage]?.color ?? 'var(--text-muted)'}
              bg={STAGE_META[s.stage]?.bg ?? 'var(--status-draft-bg)'}
            />
          ))}
        </div>
      </div>

      {/* Search + bulk action */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by branch, client, project or file…"
            style={{ width: '100%', padding: '8px 10px 8px 30px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 13 }}
          />
        </div>
        {selectable.length > 0 && (
          <button
            onClick={() => setSelected(selected.size === selectable.length ? new Set() : new Set(selectable.map((r) => r.id)))}
            className="btn btn-secondary" style={{ fontSize: 12, padding: '7px 12px' }}
          >
            {selected.size === selectable.length ? 'Clear' : `Select all ${selectable.length} unsent`}
          </button>
        )}
        {selected.size > 0 && (
          <button onClick={dispatchSelected} disabled={busy} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '7px 13px' }}>
            <Send size={13} /> {busy ? 'Sending…' : `Send ${selected.size} to assayers`}
          </button>
        )}
      </div>

      {/* Document list — branch first, because that is how paperwork is discussed. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
            No documents match this filter.
          </div>
        )}
        {rows.map((d) => {
          const meta = STAGE_META[d.status] ?? { label: d.status, color: 'var(--text-muted)', bg: 'var(--status-draft-bg)' };
          const open = expanded === d.id;
          return (
            <div key={d.id} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', flexWrap: 'wrap' }}>
                {d.status === 'UPLOADED' && (
                  <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} style={{ cursor: 'pointer' }} />
                )}
                <button onClick={() => setExpanded(open ? null : d.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex' }}>
                  {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </button>
                <FileText size={15} style={{ color: meta.color, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 170 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{d.branchName ?? 'Unlinked document'}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {d.fileName} · {d.type.replace(/_/g, ' ').toLowerCase()} · {fmtSize(d.fileSize)}
                  </div>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 110 }}>{d.clientName ?? '—'}</span>
                <span style={{ padding: '3px 9px', borderRadius: 'var(--radius-sm)', background: meta.bg, color: meta.color, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {meta.label}
                </span>
                {d.status === 'UPLOADED' && (
                  <button onClick={() => onDispatch([d.id])} disabled={busy} className="btn btn-primary" style={{ padding: '4px 10px', fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <Send size={11} /> Send
                  </button>
                )}
                <button onClick={() => onDownload(d.id)} className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 11.5 }}>
                  Download
                </button>
              </div>

              {open && (
                <div style={{ borderTop: '1px solid var(--border-color)', padding: '12px 13px 13px 46px', background: 'var(--bg-primary)' }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', marginBottom: 9 }}>
                    Transport trail
                  </div>
                  <Trail trail={d.trail} />
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
                    {d.projectName && <>Project: {d.projectName} · </>}
                    {d.branchCode && <>Branch code: {d.branchCode} · </>}
                    {d.scheduledDate && <>Audit date: {new Date(d.scheduledDate).toLocaleDateString()}</>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/** The document's journey; unreached steps are shown greyed so gaps are obvious. */
const Trail: React.FC<{ trail: DocRow['trail'] }> = ({ trail }) => {
  const steps = [
    { label: 'Uploaded', at: trail.uploadedAt, note: null },
    {
      label: 'Sent to assayer', at: trail.dispatchedAt,
      note: trail.dispatchedAt
        ? `${trail.dispatchMethod === 'AUTO' ? 'automatically' : 'manually'}${trail.dispatchedByName ? ` by ${trail.dispatchedByName}` : ''}`
        : 'not yet released — the assayer cannot download it',
    },
    { label: 'Returned by assayer', at: trail.receivedAt, note: null },
    { label: 'Sent to data entry', at: trail.sentToDataEntryAt, note: null },
    { label: 'Sent to external OCR', at: trail.sentToExternalOcrAt, note: null },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {steps.map((s) => {
        const done = !!s.at;
        return (
          <div key={s.label} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            {done
              ? <CheckCircle2 size={13} color="var(--success)" style={{ marginTop: 1, flexShrink: 0 }} />
              : <Clock size={13} color="var(--text-muted)" style={{ marginTop: 1, flexShrink: 0 }} />}
            <div style={{ minWidth: 0 }}>
              <span style={{ fontSize: 12, color: done ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: done ? 600 : 400 }}>
                {s.label}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>
                {done ? fmtDate(s.at) : '—'}
              </span>
              {s.note && (
                <div style={{ fontSize: 10.5, color: done ? 'var(--text-muted)' : 'var(--warning)', marginTop: 1 }}>{s.note}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const Stage: React.FC<{ active: boolean; onClick: () => void; label: string; count: number; color: string; bg: string }> = ({ active, onClick, label, count, color, bg }) => (
  <button onClick={onClick} style={{
    padding: '7px 12px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 12, fontWeight: 600,
    background: active ? bg : 'transparent', color: active ? color : 'var(--text-secondary)',
    border: `1px solid ${active ? color : 'var(--border-color)'}`, display: 'flex', alignItems: 'center', gap: 7,
  }}>
    {label}
    <span style={{ background: active ? color : 'var(--bg-tertiary)', color: active ? 'var(--text-primary)' : 'var(--text-muted)', borderRadius: 9, padding: '1px 7px', fontSize: 11, fontWeight: 700 }}>{count}</span>
  </button>
);

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.9px', color: 'var(--text-muted)', marginBottom: 9 }}>{children}</div>
);
