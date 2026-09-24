import React, { useState } from 'react';
import { auditDocumentTypeLabel } from '@fapoms/shared';
import { visibleSelection, hiddenSelectionNote } from '../../utils/selection';
import { Pagination } from '../../components/ui';
// One source for every document word on these screens — see documents/vocabulary.ts.
import { stageWords } from './vocabulary';
import { ALL_DOCUMENT_ACTIONS, type DocumentActions } from './document-actions';
import {
  Send, AlertTriangle, CheckCircle2, Clock, Search, FileText, ChevronRight, ChevronDown,
} from 'lucide-react';


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
  solId: string | null;
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
  solId: string | null;
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
  /**
   * ONE PAGE of documents, filtered and cut in SQL — see `documentPagination` for the size of
   * the set it came from. Never `documents.length` when you mean "how many are there".
   */
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
  documentPagination: { page: number; limit: number; total: number };
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
  /**
   * The search box and pipeline chips are the page's filter, not this panel's — the server
   * applies them, so they have to live where the request is made. Held by `Documents.tsx` and
   * shared with the branch view, which asks the same question of the same query.
   */
  search: string;
  onSearchChange: (v: string) => void;
  stage: string;
  onStageChange: (v: string) => void;
  onPageChange: (p: number) => void;
  /** Which actions the caller's role is served — see document-actions.ts. Omitted: all offered. */
  actions?: DocumentActions;
}> = ({ data, onDispatch, onDownload, busy, search, onSearchChange, stage, onStageChange, onPageChange, actions: allow = ALL_DOCUMENT_ACTIONS }) => {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);

  /**
   * The document rows as the server sent them.
   *
   * Search and the stage filter now run in SQL alongside the branch list's, so this no longer
   * filters locally: a client-side filter over one page searches the page, not the book, and
   * `documents` is a window now rather than the whole table.
   */
  const rows = data.documents;

  // Nothing is selectable for a role the dispatch route refuses — the tick boxes only feed Send.
  const selectable = allow.dispatch ? rows.filter((r) => r.status === 'UPLOADED') : [];
  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // What "Send to assayers" will really send: ticked AND still listed under the current search and
  // pipeline stage. The button used to post the raw ticked set, so narrowing the search after
  // ticking dispatched paperwork that was no longer on screen. See `utils/selection.ts`.
  const { ids: dispatchableIds, hiddenCount: hiddenSelectedCount } =
    visibleSelection(selected, selectable, (r) => r.id);
  const hiddenNote = hiddenSelectionNote(hiddenSelectedCount, 'document');

  const dispatchSelected = async () => {
    if (dispatchableIds.length === 0) return;
    await onDispatch(dispatchableIds);
    // Only what was sent is unticked. Anything the filter is hiding stays ticked and reappears,
    // still selected, when the filter is cleared.
    setSelected((s) => {
      const n = new Set(s);
      for (const id of dispatchableIds) n.delete(id);
      return n;
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Overdue paperwork blocks field work outright, so it leads. */}
      {data.blockingFieldWork.length > 0 && (
        <div style={{ background: 'var(--status-cancelled-bg)', border: '1px solid var(--status-cancelled-bg)', borderRadius: 'var(--radius-md)', padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--danger)', fontWeight: 700, fontSize: 'var(--text-sm)', marginBottom: 8 }}>
            <AlertTriangle size={15} />
            {data.blockingFieldWork.length} audit{data.blockingFieldWork.length === 1 ? '' : 's'} blocked — paperwork never sent
          </div>
          {data.blockingFieldWork.map((d) => (
            <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '6px 0', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 'var(--text-xs)' }}>
                <strong>{d.branchName ?? 'Unknown branch'}</strong>
                <span style={{ color: 'var(--text-muted)' }}> · {d.fileName}</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--danger)', fontWeight: 600 }}>
                  {d.daysUntilAudit != null && d.daysUntilAudit < 0
                    ? `audit was ${Math.abs(d.daysUntilAudit)} day(s) ago`
                    : 'audit due today'}
                </span>
                {allow.dispatch && (
                  <button onClick={() => onDispatch([d.id])} disabled={busy} title={`Send ${d.fileName} to the assayer now`} className="btn btn-primary" style={{ padding: '4px 10px', fontSize: 'var(--text-2xs)' }}>
                    Send now
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Pipeline: where every document currently sits, in lifecycle order. */}
      <div>
        <Label>Pipeline</Label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Stage active={stage === 'ALL'} onClick={() => onStageChange('ALL')} label="All" count={data.totals.total} color="var(--text-secondary)" bg="var(--bg-surface-2)" />
          {data.pipeline.filter((s) => s.count > 0).map((s) => (
            <Stage
              key={s.stage}
              active={stage === s.stage}
              onClick={() => onStageChange(stage === s.stage ? 'ALL' : s.stage)}
              label={stageWords(s.stage)?.label ?? s.stage}
              count={s.count}
              color={stageWords(s.stage)?.color ?? 'var(--text-muted)'}
              bg={stageWords(s.stage)?.bg ?? 'var(--status-draft-bg)'}
            />
          ))}
        </div>
      </div>

      {/* Search + bulk action */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            value={search} onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search by branch, client, project or file…"
            title="Search documents by branch name, client, project, or file name"
            style={{ width: '100%', padding: '8px 10px 8px 30px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 'var(--text-sm)' }}
          />
        </div>
        {selectable.length > 0 && (
          // Ticks or unticks the unsent documents CURRENTLY LISTED, and says so — it is not
          // "every unsent document in the project" whenever a search or stage filter is on.
          // Anything the filter hides keeps whatever state the user already gave it.
          <button
            onClick={() => setSelected((prev) => {
              const next = new Set(prev);
              const allShownTicked = selectable.every((r) => prev.has(r.id));
              for (const r of selectable) { if (allShownTicked) next.delete(r.id); else next.add(r.id); }
              return next;
            })}
            title={selectable.every((r) => selected.has(r.id)) ? 'Clear bulk selection of documents' : `Select all ${selectable.length} unsent documents shown on this page`}
            className="btn btn-secondary" style={{ fontSize: 'var(--text-xs)', padding: '7px 12px' }}
          >
            {selectable.every((r) => selected.has(r.id)) ? `Clear the ${selectable.length} shown` : `Select all ${selectable.length} unsent shown`}
          </button>
        )}
        {dispatchableIds.length > 0 && (
          <>
            <button onClick={dispatchSelected} disabled={busy} className="btn btn-primary" title={`Dispatch ${dispatchableIds.length} document(s) directly to assayers`} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', padding: '7px 13px' }}>
              <Send size={13} /> {busy ? `Sending ${dispatchableIds.length}…` : `Send ${dispatchableIds.length} to assayers`}
            </button>
            {/*
              A working state here, not a counter. `POST /documents/dispatch-batch` queues the
              batch and the Documents page follows the job: the real "(12/40)" the server reports
              is shown there, above every view, rather than invented here. Cancelling is not
              offered: leaving the page only stops the watching, while the server carries on
              releasing paperwork. The button naming the count is the part that was actually
              missing — on a forty-document selection it previously said "Sending…" and looked dead.
            */}
            {busy && (
              <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                Releasing {dispatchableIds.length} document{dispatchableIds.length === 1 ? '' : 's'} in one go — the list refreshes when it is done.
              </span>
            )}
          </>
        )}
        {hiddenNote && (
          <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{hiddenNote}</span>
        )}
      </div>

      {/* Document list — branch first, because that is how paperwork is discussed. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
            No documents match this filter. Clear it to see every document for this project.
          </div>
        )}
        {rows.map((d) => {
          const meta = stageWords(d.status) ?? { label: d.status, meaning: '', color: 'var(--text-muted)', bg: 'var(--status-draft-bg)' };
          const open = expanded === d.id;
          return (
            <div key={d.id} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', flexWrap: 'wrap' }}>
                {allow.dispatch && d.status === 'UPLOADED' && (
                  <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} title={`Select ${d.fileName} to send in bulk`} style={{ cursor: 'pointer' }} />
                )}
                <button onClick={() => setExpanded(open ? null : d.id)} title={open ? `Hide paperwork trail for ${d.fileName}` : `Show paperwork trail for ${d.fileName}`} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex' }}>
                  {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </button>
                <FileText size={15} style={{ color: meta.color, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 170 }}>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{d.branchName ?? 'Unlinked document'}</div>
                  <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                    {d.fileName} · {auditDocumentTypeLabel(d.type)} · {fmtSize(d.fileSize)}
                  </div>
                </div>
                <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', minWidth: 110 }}>{d.clientName ?? '—'}</span>
                <span style={{ padding: '3px 9px', borderRadius: 'var(--radius-sm)', background: meta.bg, color: meta.color, fontSize: 'var(--text-2xs)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {meta.label}
                </span>
                {allow.dispatch && d.status === 'UPLOADED' && (
                  <button onClick={() => onDispatch([d.id])} disabled={busy} className="btn btn-primary" title={`Dispatch ${d.fileName} to assayer`} style={{ padding: '4px 10px', fontSize: 'var(--text-2xs)', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <Send size={11} /> Send
                  </button>
                )}
                {allow.download && (
                  <button onClick={() => onDownload(d.id)} className="btn btn-secondary" title={`Download ${d.fileName}`} style={{ padding: '4px 10px', fontSize: 'var(--text-2xs)' }}>
                    Download
                  </button>
                )}
              </div>

              {open && (
                <div style={{ borderTop: '1px solid var(--border-color)', padding: '12px 13px 13px 46px', background: 'var(--bg-primary)' }}>
                  <div style={{ fontSize: 'var(--text-3xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', marginBottom: 9 }}>
                    Transport trail
                  </div>
                  <Trail trail={d.trail} />
                  <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: 10 }}>
                    {d.projectName && <>Project: {d.projectName} · </>}
                    {d.solId && <>SOL ID: {d.solId} · </>}
                    {d.scheduledDate && <>Audit date: {new Date(d.scheduledDate).toLocaleDateString()}</>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Pagination
        page={data.documentPagination.page}
        totalPages={Math.max(1, Math.ceil(data.documentPagination.total / data.documentPagination.limit))}
        total={data.documentPagination.total}
        pageSize={data.documentPagination.limit}
        onPageChange={onPageChange}
      />
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
              <span style={{ fontSize: 'var(--text-xs)', color: done ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: done ? 600 : 400 }}>
                {s.label}
              </span>
              <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginLeft: 8 }}>
                {done ? fmtDate(s.at) : '—'}
              </span>
              {s.note && (
                <div style={{ fontSize: 'var(--text-3xs)', color: done ? 'var(--text-muted)' : 'var(--warning)', marginTop: 1 }}>{s.note}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const Stage: React.FC<{ active: boolean; onClick: () => void; label: string; count: number; color: string; bg: string }> = ({ active, onClick, label, count, color, bg }) => (
  <button
    onClick={onClick}
    title={active ? `Currently filtering by ${label} (${count} files). Click to clear filter` : `Filter documents by status: ${label} (${count} files)`}
    style={{
      padding: '7px 12px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 600,
      background: active ? bg : 'transparent', color: active ? color : 'var(--text-secondary)',
      border: `1px solid ${active ? color : 'var(--border-color)'}`, display: 'flex', alignItems: 'center', gap: 7,
    }}
  >
    {label}
    <span style={{ background: active ? color : 'var(--bg-tertiary)', color: active ? 'var(--text-primary)' : 'var(--text-muted)', borderRadius: 9, padding: '1px 7px', fontSize: 'var(--text-2xs)', fontWeight: 700 }}>{count}</span>
  </button>
);

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 'var(--text-2xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.9px', color: 'var(--text-muted)', marginBottom: 9 }}>{children}</div>
);
