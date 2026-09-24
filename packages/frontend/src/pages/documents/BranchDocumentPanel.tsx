import React, { useState } from 'react';
import {
  AlertTriangle, FileText, Send, CheckCircle2, Clock, Search, ChevronRight, ChevronDown,
  UploadCloud, Inbox, ArrowRightCircle,
} from 'lucide-react';
import { Pagination } from '../../components/ui';
import type { BranchGroup } from './DocumentControlPanel';
import { UPLOAD_LIMIT_HINT } from '@fapoms/shared';
// One source for every document word on these screens — see documents/vocabulary.ts.
import {
  DOCUMENT_STAGE_ORDER as STAGE_ORDER, stageWords,
  DOCUMENT_TYPE, DOCUMENT_TYPE_ORDER as TYPE_ORDER, UPLOADABLE_TYPES, documentTypeLabel,
} from './vocabulary';
import { ALL_DOCUMENT_ACTIONS, type DocumentActions } from './document-actions';

const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : null);
const fmtDateTime = (d?: string | null) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null);

/**
 * Documents organised by branch — one card per branch, every file it has
 * grouped underneath it, with every action (upload, dispatch, mark received,
 * send to OCR, upload the Excel result) available inline on the row it applies
 * to. This replaces three disconnected surfaces — a flat per-document list, a
 * separate upload form, and a separate data-entry queue table — that together
 * meant doing one branch's paperwork required jumping between tabs and made it
 * hard to tell what was actually done versus still pending.
 */
export const BranchDocumentPanel: React.FC<{
  /** One page of branches. Never the whole set — see `total`. */
  branches: BranchGroup[];
  neverPrepared: BranchGroup[];
  /** True count of branches matching the current search/stage, across all pages. */
  total: number;
  /** True count of never-prepared branches; `neverPrepared` itself is a capped list. */
  neverPreparedTotal: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  search: string;
  onSearchChange: (search: string) => void;
  stage: string;
  onStageChange: (stage: string) => void;
  loading?: boolean;
  pipeline: Array<{ stage: string; count: number }>;
  onDispatch: (ids: string[]) => Promise<void>;
  onDownload: (id: string) => void;
  onUpload: (projectBranchId: string, type: string, file: File) => Promise<void>;
  onMarkReceived: (docId: string) => Promise<void>;
  onSendToOcr: (docId: string) => Promise<void>;
  onUploadExcel: (assessmentId: string, file: File) => Promise<void>;
  busy?: boolean;
  /** Which actions the caller's role is served — see document-actions.ts. Omitted: all offered. */
  actions?: DocumentActions;
}> = ({
  branches, neverPrepared, total, neverPreparedTotal, page, pageSize, onPageChange,
  search, onSearchChange, stage: stageFilter, onStageChange, loading,
  pipeline, onDispatch, onDownload, onUpload, onMarkReceived, onSendToOcr, onUploadExcel, busy,
  actions: allow = ALL_DOCUMENT_ACTIONS,
}) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Tracks which specific document/branch is mid-action, so only that row shows
  // a busy state instead of freezing the whole page on every click.
  const [acting, setActing] = useState<Set<string>>(new Set());

  const withActing = async (key: string, fn: () => Promise<void>) => {
    setActing((s) => new Set(s).add(key));
    try { await fn(); } finally { setActing((s) => { const n = new Set(s); n.delete(key); return n; }); }
  };

  /**
   * `branches` IS the result — there is no filtering left to do here.
   *
   * Search and the stage filter used to be a `useMemo` over the full branch list, which worked
   * only because the server sent all 40,087 of them (17 MB) on every load. Filtering one page in
   * the browser would search 25 rows and confidently report "no branches match" for the other
   * 40,062, so both moved into SQL with the pagination.
   */
  const rows = branches;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const toggle = (id: string) =>
    setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Pipeline strip: click a stage to see only branches with a document sitting
          there right now — the fast way to answer "what's stuck and where". */}
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
        {/* `total`, not `branches.length` — that is one page, so the chip would read "25". */}
        <StageChip active={stageFilter === 'ALL'} onClick={() => onStageChange('ALL')} label="All branches" count={total} color="var(--text-secondary)" bg="var(--bg-surface-2)" />
        {STAGE_ORDER.map((stage) => {
          const count = pipeline.find((p) => p.stage === stage)?.count ?? 0;
          if (count === 0) return null;
          const meta = stageWords(stage)!;
          return (
            <StageChip key={stage} active={stageFilter === stage} onClick={() => onStageChange(stageFilter === stage ? 'ALL' : stage)} label={meta.label} count={count} color={meta.color} bg={meta.bg} />
          );
        })}
        {neverPreparedTotal > 0 && (
          <StageChip active={stageFilter === 'NEVER_PREPARED'} onClick={() => onStageChange(stageFilter === 'NEVER_PREPARED' ? 'ALL' : 'NEVER_PREPARED')} label="Nothing prepared" count={neverPreparedTotal} color="var(--danger)" bg="var(--status-cancelled-bg)" />
        )}
      </div>

      {neverPrepared.length > 0 && stageFilter !== 'NEVER_PREPARED' && (
        <div style={{ background: 'var(--status-cancelled-bg)', border: '1px solid var(--status-cancelled-bg)', borderRadius: 'var(--radius-md)', padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--danger)', fontWeight: 700, fontSize: 'var(--text-sm)', marginBottom: 8 }}>
            <AlertTriangle size={15} />
            {neverPreparedTotal} branch{neverPreparedTotal === 1 ? '' : 'es'} confirmed with no paperwork prepared at all
            {/* The list below is capped. Say so, rather than showing 50 under a heading that
                claims there are 137. */}
            {neverPreparedTotal > neverPrepared.length && (
              <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>
                — showing the {neverPrepared.length} most urgent
              </span>
            )}
          </div>
          {neverPrepared.map((b) => (
            <div key={b.projectBranchId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', fontSize: 'var(--text-xs)', flexWrap: 'wrap', gap: 6 }}>
              <span><strong>{b.branchName}</strong> <span style={{ color: 'var(--text-muted)' }}>· {b.projectName}</span></span>
              <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--danger)', fontWeight: 600 }}>
                {b.daysUntilAudit != null && b.daysUntilAudit < 0
                  ? `audit was ${Math.abs(b.daysUntilAudit)} day(s) ago — nothing to send yet`
                  : `audit in ${b.daysUntilAudit} day(s) — no packet uploaded`}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 320px', maxWidth: 420 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            value={search} onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search by branch, client or project…"
            title="Type to filter branches by name, client or project"
            style={{ width: '100%', padding: '8px 10px 8px 30px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 'var(--text-sm)' }}
          />
        </div>
        {/* The search runs on the server, so there is a round-trip to acknowledge. Without this
            the box looks unresponsive while 40k branches are being filtered. */}
        {loading && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Searching…</span>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
            {loading ? 'Searching…' : 'No branches match this filter.'}
          </div>
        )}
        {rows.map((b) => {
          const isOpen = expanded.has(b.projectBranchId);
          // Comes down on the row itself now. Testing membership of the `neverPrepared` list only
          // worked while that list held every branch in the book.
          const gapFlag = b.neverPrepared;
          return (
            <div key={b.projectBranchId} style={{
              background: 'var(--bg-secondary)',
              border: `1px solid ${gapFlag ? 'var(--status-cancelled-bg)' : 'var(--border-color)'}`,
              borderRadius: 'var(--radius-md)', overflow: 'hidden',
            }}>
              <button
                onClick={() => toggle(b.projectBranchId)}
                title={isOpen ? `Hide paperwork for ${b.branchName}` : `Show paperwork for ${b.branchName}`}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--text-primary)' }}
              >
                {isOpen ? <ChevronDown size={15} color="var(--text-muted)" /> : <ChevronRight size={15} color="var(--text-muted)" />}
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700 }}>{b.branchName}</div>
                  <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                    {b.clientName} · {b.projectName}{b.solId ? ` · ${b.solId}` : ''}
                  </div>
                </div>
                {b.scheduledDate && (
                  <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Audit {fmtDate(b.scheduledDate)}</span>
                )}
                {/* One chip per known file type — filled if present, dim if not, and
                    an empty chip for an ops-uploaded type doubles as its upload button. */}
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
                  {TYPE_ORDER.map((t) => {
                    const docs = b.documentsByType[t];
                    const meta = DOCUMENT_TYPE[t];
                    const typeName = documentTypeLabel(t);
                    if (!docs?.length) {
                      if (!UPLOADABLE_TYPES.has(t) || !allow.upload) {
                        return (
                          <span key={t} title={UPLOADABLE_TYPES.has(t) ? `${typeName}: not uploaded yet` : `${typeName}: not applicable yet`} style={{
                            fontSize: 'var(--text-3xs)', padding: '2px 7px', borderRadius: 'var(--radius-sm)',
                            background: 'transparent', border: '1px dashed var(--border-color)', color: 'var(--text-muted)',
                          }}>{meta.short}</span>
                        );
                      }
                      const uploadKey = `upload:${b.projectBranchId}:${t}`;
                      return (
                        <UploadChip
                          key={t}
                          label={meta.short}
                          title={`Upload ${typeName}`}
                          busy={acting.has(uploadKey)}
                          onFile={(file) => withActing(uploadKey, () => onUpload(b.projectBranchId, t, file))}
                        />
                      );
                    }
                    const latest = docs[0];
                    const stage = stageWords(latest.status) ?? { label: latest.status, meaning: '', color: 'var(--text-muted)', bg: 'var(--status-draft-bg)' };
                    return (
                      <span key={t} title={`${typeName}: ${stage.label}${docs.length > 1 ? ` (${docs.length} files)` : ''}`} style={{
                        fontSize: 'var(--text-3xs)', fontWeight: 700, padding: '2px 7px', borderRadius: 'var(--radius-sm)',
                        background: stage.bg, color: stage.color,
                      }}>{meta.short}{docs.length > 1 ? ` ×${docs.length}` : ''}</span>
                    );
                  })}
                </div>
              </button>

              {isOpen && (
                <div style={{ borderTop: '1px solid var(--border-color)', padding: '10px 14px 14px 39px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {TYPE_ORDER.filter((t) => b.documentsByType[t]?.length).map((t) => (
                    <div key={t}>
                      <div style={{ fontSize: 'var(--text-3xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', marginBottom: 5 }}>
                        {documentTypeLabel(t)}
                      </div>
                      {b.documentsByType[t].map((d) => {
                        const stage = stageWords(d.status) ?? { label: d.status, meaning: '', color: 'var(--text-muted)', bg: 'var(--status-draft-bg)' };
                        const isReturn = d.type === 'AUDITED_RETURN_PDF';
                        const canMarkReceived = allow.markReceived && isReturn && d.status === 'UPLOADED';
                        const canSendToOcr = allow.sendToOcr && isReturn && (d.status === 'RECEIVED' || d.status === 'SENT_TO_DATA_ENTRY');
                        const canUploadExcel = allow.uploadExcel && isReturn && d.status === 'SENT_TO_EXTERNAL_OCR';
                        const rowBusy = acting.has(d.id);
                        return (
                          <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0', flexWrap: 'wrap' }}>
                            <FileText size={13} color={stage.color} style={{ flexShrink: 0 }} />
                            <span style={{ fontSize: 'var(--text-xs)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.fileName}</span>
                            <span style={{ fontSize: 'var(--text-3xs)', fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--radius-sm)', background: stage.bg, color: stage.color, whiteSpace: 'nowrap' }}>
                              {stage.label}
                            </span>
                            {d.trail?.dispatchedAt && (
                              <span title={`Sent to assayer ${fmtDateTime(d.trail.dispatchedAt)}`} style={{ display: 'flex' }}>
                                <CheckCircle2 size={12} color="var(--success)" />
                              </span>
                            )}
                            {allow.dispatch && d.status === 'UPLOADED' && !isReturn && (
                              <button onClick={() => withActing(d.id, () => onDispatch([d.id]))} disabled={busy || rowBusy} title={`Send ${d.fileName} to the assayer`} className="btn btn-primary" style={{ padding: '3px 9px', fontSize: 'var(--text-2xs)', display: 'flex', alignItems: 'center', gap: 4 }}>
                                <Send size={10} /> {rowBusy ? '…' : 'Send'}
                              </button>
                            )}
                            {canMarkReceived && (
                              <button onClick={() => withActing(d.id, () => onMarkReceived(d.id))} disabled={rowBusy} title={`Mark ${d.fileName} as received back from assayer`} className="btn btn-secondary" style={{ padding: '3px 9px', fontSize: 'var(--text-2xs)', display: 'flex', alignItems: 'center', gap: 4, color: 'var(--success)', borderColor: 'var(--status-completed-bg)' }}>
                                <Inbox size={11} /> {rowBusy ? '…' : 'Mark Received'}
                              </button>
                            )}
                            {canSendToOcr && (
                              <button onClick={() => withActing(d.id, () => onSendToOcr(d.id))} disabled={rowBusy} title={`Send ${d.fileName} for text scanning`} className="btn btn-secondary" style={{ padding: '3px 9px', fontSize: 'var(--text-2xs)', display: 'flex', alignItems: 'center', gap: 4, color: 'var(--warning)', borderColor: 'var(--status-pending-bg)' }}>
                                <ArrowRightCircle size={11} /> {rowBusy ? '…' : 'Send for scanning'}
                              </button>
                            )}
                            {canUploadExcel && d.assessmentId && (
                              <UploadChip
                                label={rowBusy ? '…' : 'Upload Excel'}
                                title="Upload the Excel produced by external OCR"
                                busy={rowBusy}
                                variant="button"
                                onFile={(file) => withActing(d.id, () => onUploadExcel(d.assessmentId!, file))}
                              />
                            )}
                            {allow.download && (
                              <button onClick={() => onDownload(d.id)} title={`Download ${d.fileName} to your computer`} className="btn btn-secondary" style={{ padding: '3px 9px', fontSize: 'var(--text-2xs)' }}>
                                Download
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {b.documentCount === 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 'var(--text-xs)', color: gapFlag ? 'var(--danger)' : 'var(--text-muted)' }}>
                      <Clock size={13} />
                      {gapFlag
                        ? 'Audit is confirmed but no paperwork has been uploaded for this branch yet — use the chips above to add it.'
                        : 'No documents yet for this branch — use the chips above to upload one.'}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Pagination
        page={page}
        totalPages={totalPages}
        total={total}
        pageSize={pageSize}
        onPageChange={onPageChange}
      />
    </div>
  );
};

const StageChip: React.FC<{ active: boolean; onClick: () => void; label: string; count: number; color: string; bg: string }> = ({ active, onClick, label, count, color, bg }) => (
  <button onClick={onClick} title={active ? `Showing ${label} branches, click to show all` : `Show only branches with paperwork at ${label}`} style={{
    padding: '6px 11px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 'var(--text-2xs)', fontWeight: 600,
    background: active ? bg : 'transparent', color: active ? color : 'var(--text-secondary)',
    border: `1px solid ${active ? color : 'var(--border-color)'}`, display: 'flex', alignItems: 'center', gap: 6,
  }}>
    {label}
    <span style={{ background: active ? color : 'var(--bg-tertiary)', color: active ? 'var(--text-primary)' : 'var(--text-muted)', borderRadius: 8, padding: '1px 6px', fontSize: 'var(--text-3xs)', fontWeight: 700 }}>{count}</span>
  </button>
);

/** A file input disguised as a chip or button — the same control that shows a
    file type is missing is what you click to supply it. */
/* The size limit rides along in the tooltip. There is no room on a chip this small for a
   sentence, but there is no excuse for the limit being discoverable only by failing an upload —
   and the picker itself refuses an oversized file immediately (`Documents.tsx`). */
const UploadChip: React.FC<{ label: string; title: string; busy: boolean; onFile: (file: File) => void; variant?: 'chip' | 'button' }> = ({ label, title, busy, onFile, variant = 'chip' }) => (
  <label
    title={`${title} — ${UPLOAD_LIMIT_HINT}`}
    style={variant === 'button' ? {
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', fontSize: 'var(--text-2xs)', fontWeight: 600,
      background: 'var(--status-completed-bg)', color: 'var(--success)', border: '1px solid var(--status-completed-bg)',
      borderRadius: 'var(--radius-sm)', cursor: busy ? 'wait' : 'pointer',
    } : {
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--text-3xs)', padding: '2px 7px', borderRadius: 'var(--radius-sm)',
      background: 'var(--status-pending-bg)', border: '1px dashed var(--accent-primary)', color: 'var(--accent-primary)',
      cursor: busy ? 'wait' : 'pointer', fontWeight: 600,
    }}
  >
    <UploadCloud size={variant === 'button' ? 11 : 10} />
    {busy ? '…' : label}
    <input
      type="file" style={{ display: 'none' }} disabled={busy}
      onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }}
    />
  </label>
);
