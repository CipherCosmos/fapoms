import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Check, RotateCcw, Send as SubmitIcon, MessageSquarePlus, MessageSquare,
  Loader2, AlertTriangle, FileWarning,
} from 'lucide-react';

import { api } from '../../services/api';
import { useCurrentRoles } from '../../hooks/useCurrentRoles';
import { SystemRole } from '@fapoms/shared';
import { PdfRegionViewer } from './PdfRegionViewer';
import type { RegionCapture, Region } from './PdfRegionViewer';
import { ThreadPanel } from './ThreadPanel';
import { userMessage } from '../../services/errors';

/**
 * The merged workspace for one branch's returned packet: the PDF, the data
 * entry head's review decision, and every clarification with the assayer —
 * three things that used to live on two disconnected pages (a Desk board with
 * no PDF, and a Validation page with a fake chat skin and no PDF either).
 *
 * Keyed by projectBranchId rather than a document or a case id, because a
 * branch's packet, its validation case, and its clarifications are the same
 * real-world unit of work at different moments — before a case exists (still
 * being typed in), while it is in review, and after it is approved or sent.
 * Whatever exists is shown; whatever doesn't yet is explained rather than
 * hidden as an error.
 */

interface DocRow {
  id: string; fileName: string; type: string; status: string; receivedAt: string | null;
}

interface CaseRow {
  id: string; status: string; remarks: string | null; correctionNotes: string | null;
  ocrResult: any | null;
  projectBranch?: { branch?: { name: string; branchCode: string } };
}

interface QueryRow {
  id: string; queryText: string; targetField: string | null; status: string;
  lastMessageAt?: string | null; createdAt: string;
}

const STATUS_TONE: Record<string, string> = {
  PENDING: 'var(--text-muted)', ASSIGNED: 'var(--accent)', OCR_PROCESSING: 'var(--accent)',
  HUMAN_REVIEW: 'var(--warning)', CORRECTION_REQUIRED: 'var(--danger)',
  APPROVED: 'var(--success)', SUBMITTED: 'var(--success)',
};

const label: React.CSSProperties = {
  fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)',
};
const panel: React.CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border-color)',
  borderRadius: '10px', overflow: 'hidden', minHeight: 0,
};

export const CaseWorkspace: React.FC<{ projectBranchId: string; onBack: () => void; onChanged?: () => void }> = ({
  projectBranchId, onBack, onChanged,
}) => {
  const roles = useCurrentRoles();
  const canDecide = roles.some((r) =>
    [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.DATA_ENTRY_HEAD, SystemRole.VALIDATION_MANAGER].includes(r));

  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [validationCase, setCase] = useState<CaseRow | null | undefined>(undefined);
  const [queries, setQueries] = useState<QueryRow[] | null>(null);
  const [selectedQuery, setSelectedQuery] = useState<string | null>(null);
  const [newQueryText, setNewQueryText] = useState('');
  const [showNewQuery, setShowNewQuery] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [pending, setPending] = useState<RegionCapture | null>(null);
  const [focus, setFocus] = useState<{ pageNumber: number; region: Region | null } | null>(null);

  const loadCase = useCallback(async () => {
    try {
      const list = await api.request<CaseRow[]>(`/validation?projectBranchId=${projectBranchId}&limit=1`);
      setCase(Array.isArray(list) && list.length > 0 ? list[0] : null);
    } catch (e) {
      setCase(null);
    }
  }, [projectBranchId]);

  const loadQueries = useCallback(async (caseId: string) => {
    api.request<QueryRow[]>(`/validation-queries/validation-case/${caseId}`)
      .then((r) => setQueries(Array.isArray(r) ? r : []))
      .catch(() => setQueries([]));
  }, []);

  useEffect(() => {
    api.request<DocRow[]>(`/documents/project-branch/${projectBranchId}`)
      .then((r) => setDocs(Array.isArray(r) ? r : []))
      .catch(() => setDocs([]));
    loadCase();
  }, [projectBranchId, loadCase]);

  useEffect(() => {
    if (validationCase?.id) loadQueries(validationCase.id);
    else setQueries(validationCase === null ? [] : null);
  }, [validationCase, loadQueries]);

  const returnedDoc = useMemo(
    () => docs?.find((d) => d.type === 'AUDITED_RETURN_PDF') ?? docs?.[0] ?? null,
    [docs],
  );

  useEffect(() => {
    if (!returnedDoc) { setFileUrl(null); return; }
    api.request<{ downloadUrl: string }>(`/documents/${returnedDoc.id}/download-token`)
      .then((r: any) => setFileUrl(r?.downloadUrl ? `/api/v1${r.downloadUrl}` : null))
      .catch((e) => setErr(`Could not open the document: ${(e as Error).message}`));
  }, [returnedDoc]);

  const decide = async (targetStatus: string) => {
    if (!validationCase) return;
    setBusy(true);
    setErr(null);
    try {
      await api.request(`/validation/${validationCase.id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus, notes: notes.trim() || undefined }),
      });
      setNotes('');
      await loadCase();
      onChanged?.();
    } catch (e) {
      setErr(userMessage(e));
    }
    setBusy(false);
  };

  const raiseQuery = async () => {
    if (!newQueryText.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      let caseId = validationCase?.id;
      if (!caseId) {
        // First question on a branch that has no case yet (still being worked) —
        // open one at PENDING so the clarification has somewhere to live.
        const created = await api.request<CaseRow>('/validation', {
          method: 'POST',
          body: JSON.stringify({ projectBranchId }),
        });
        caseId = (created as any).id;
        await loadCase();
      }
      const created = await api.request<QueryRow>('/validation-queries', {
        method: 'POST',
        body: JSON.stringify({ validationCaseId: caseId, queryText: newQueryText.trim() }),
      });
      setNewQueryText('');
      setShowNewQuery(false);
      await loadQueries(caseId!);
      setSelectedQuery((created as any).id);
    } catch (e) {
      setErr(userMessage(e));
    }
    setBusy(false);
  };

  const openCount = (queries ?? []).filter((q) => q.status !== 'RESOLVED').length;
  const status = validationCase?.status;
  const tone = status ? STATUS_TONE[status] ?? 'var(--text-muted)' : 'var(--text-muted)';
  const branchName = validationCase?.projectBranch?.branch?.name;
  const branchCode = validationCase?.projectBranch?.branch?.branchCode;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <button onClick={onBack} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <ArrowLeft size={14} /> Back to the board
        </button>
        {branchName && (
          <div style={{ fontSize: '13.5px', fontWeight: 700 }}>
            {branchName} <span style={{ fontFamily: 'monospace', fontWeight: 400, color: 'var(--text-muted)', fontSize: '12px' }}>{branchCode}</span>
          </div>
        )}
        {status && (
          <span style={{ fontSize: '11px', fontWeight: 700, color: tone, display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: tone }} />
            {status.replace(/_/g, ' ')}
          </span>
        )}
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(360px, 1fr)',
        gap: '12px', height: 'calc(100vh - 190px)', minHeight: '520px',
      }}>
        <section style={panel}>
          {!returnedDoc && docs !== null && (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>
              <FileWarning size={24} style={{ opacity: 0.4 }} />
              <div style={{ fontSize: '13px', marginTop: '10px' }}>No returned PDF has been uploaded for this branch yet.</div>
            </div>
          )}
          {returnedDoc && !fileUrl && !err && (
            <div style={{ padding: '14px', display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
              <Loader2 size={15} className="spin" /> Preparing document…
            </div>
          )}
          {err && !fileUrl && <div style={{ padding: '14px', color: 'var(--danger)', fontSize: '13px' }}>{err}</div>}
          {fileUrl && <PdfRegionViewer fileUrl={fileUrl} focus={focus} onCapture={setPending} />}
        </section>

        <section style={{ ...panel, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* Case decision — only present once a case exists, and only offered to
              the roles that make the call. */}
          {validationCase === undefined ? (
            <div style={{ padding: '14px' }}><Loader2 size={14} className="spin" /></div>
          ) : validationCase === null ? (
            <div style={{ padding: '11px 13px', fontSize: '12px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>
              No review case yet — still being worked. Raising a clarification below opens one.
            </div>
          ) : (
            <div style={{ padding: '11px 13px', borderBottom: '1px solid var(--border-color)' }}>
              {validationCase.correctionNotes && (
                <div style={{ fontSize: '12px', color: 'var(--danger)', marginBottom: '8px' }}>
                  <strong>Correction requested:</strong> {validationCase.correctionNotes}
                </div>
              )}
              {validationCase.ocrResult && (
                <details style={{ marginBottom: '8px' }}>
                  <summary style={{ ...label, cursor: 'pointer' }}>OCR extraction</summary>
                  <pre style={{ fontSize: '11px', margin: '6px 0 0', overflowX: 'auto', maxHeight: '90px', color: 'var(--text-secondary)' }}>
                    {JSON.stringify(validationCase.ocrResult, null, 2)}
                  </pre>
                </details>
              )}
              {canDecide && status !== 'SUBMITTED' && (
                <>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Notes (required if requesting a correction)"
                    rows={2}
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '7px 9px', fontSize: '12px',
                      borderRadius: '7px', background: 'var(--bg-input)', color: 'inherit',
                      border: '1px solid var(--border-color)', resize: 'vertical', marginBottom: '8px',
                    }}
                  />
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {status !== 'APPROVED' && (
                      <button onClick={() => decide('APPROVED')} disabled={busy} className="btn btn-primary"
                        style={{ fontSize: '11.5px', padding: '6px 11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Check size={12} /> Approve
                      </button>
                    )}
                    {(status === 'HUMAN_REVIEW') && (
                      <button onClick={() => decide('CORRECTION_REQUIRED')} disabled={busy || !notes.trim()} className="btn btn-secondary"
                        style={{ fontSize: '11.5px', padding: '6px 11px', display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--danger)', borderColor: 'var(--status-cancelled-bg)' }}>
                        <RotateCcw size={12} /> Request correction
                      </button>
                    )}
                    {status === 'APPROVED' && (
                      <button onClick={() => decide('SUBMITTED')} disabled={busy} className="btn btn-primary"
                        style={{ fontSize: '11.5px', padding: '6px 11px', display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--success)', borderColor: 'var(--success)' }}>
                        <SubmitIcon size={12} /> Submit to client
                      </button>
                    )}
                  </div>
                </>
              )}
              {status === 'SUBMITTED' && (
                <div style={{ fontSize: '12px', color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Check size={13} /> Sent to the client.
                </div>
              )}
            </div>
          )}

          {/* Clarifications */}
          <div style={{ padding: '9px 13px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={label}>Clarifications {openCount > 0 && `(${openCount} open)`}</span>
            <button onClick={() => setShowNewQuery((v) => !v)} className="btn btn-secondary"
              style={{ marginLeft: 'auto', fontSize: '11px', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <MessageSquarePlus size={12} /> New
            </button>
          </div>

          {showNewQuery && (
            <div style={{ padding: '9px 13px', borderBottom: '1px solid var(--border-color)', display: 'flex', gap: '6px' }}>
              <input
                value={newQueryText}
                onChange={(e) => setNewQueryText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') raiseQuery(); }}
                placeholder="What's unclear? e.g. gross weight on row 3…"
                style={{ flex: 1, padding: '7px 9px', fontSize: '12.5px', borderRadius: '7px', background: 'var(--bg-input)', color: 'inherit', border: '1px solid var(--border-color)' }}
              />
              <button onClick={raiseQuery} disabled={busy || !newQueryText.trim()} className="btn btn-primary" style={{ fontSize: '12px', padding: '7px 11px' }}>
                Raise
              </button>
            </div>
          )}

          {err && (
            <div style={{ padding: '7px 13px', fontSize: '11.5px', color: 'var(--danger)', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <AlertTriangle size={12} /> {err}
            </div>
          )}

          {!selectedQuery ? (
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 13px' }}>
              {queries === null && <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '10px 0' }}>Loading…</div>}
              {queries?.length === 0 && (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '10px 0' }}>None raised yet.</div>
              )}
              {queries?.map((q) => (
                <button
                  key={q.id}
                  onClick={() => setSelectedQuery(q.id)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', padding: '9px 10px', marginTop: '6px',
                    borderRadius: '8px', cursor: 'pointer', fontSize: '12.5px',
                    background: q.status === 'RESOLVED' ? 'var(--status-completed-bg)' : 'var(--status-pending-bg)',
                    border: `1px solid ${q.status === 'RESOLVED' ? 'var(--border-color)' : 'var(--status-pending-bg)'}`,
                    color: 'inherit',
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <MessageSquare size={12} style={{ color: q.status === 'RESOLVED' ? 'var(--text-muted)' : 'var(--warning)', flexShrink: 0 }} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.queryText}</span>
                  </div>
                  <div style={{ ...label, marginTop: '3px' }}>{q.status.toLowerCase()}{q.targetField ? ` · ${q.targetField}` : ''}</div>
                </button>
              ))}
            </div>
          ) : (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '7px 13px', borderBottom: '1px solid var(--border-color)' }}>
                <button onClick={() => setSelectedQuery(null)} className="btn btn-secondary" style={{ fontSize: '11px', padding: '4px 8px' }}>
                  ← All clarifications
                </button>
              </div>
              <ThreadPanel
                queryId={selectedQuery}
                status={queries?.find((q) => q.id === selectedQuery)?.status}
                pending={pending}
                onClearPending={() => setPending(null)}
                onFocusRegion={setFocus}
                onResolved={() => validationCase && loadQueries(validationCase.id)}
                onChanged={() => validationCase && loadQueries(validationCase.id)}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default CaseWorkspace;
