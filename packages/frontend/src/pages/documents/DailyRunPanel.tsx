import React, { useState, useEffect, useCallback } from 'react';
import { UploadCloud, AlertTriangle, CheckCircle2, Clock, Send, ArrowRightCircle } from 'lucide-react';

/**
 * What still has to happen for a branch on this audit date. Ordered as the day
 * actually runs, so the board reads left-to-right as work moves.
 */
const ACTION_META: Record<string, { label: string; color: string; hint: string }> = {
  AWAITING_CLIENT_DATA: { label: 'No client data', color: '#ef4444', hint: 'This branch is scheduled today but is not in the client\'s file.' },
  GENERATE_PDF: { label: 'Generate packet', color: '#a78bfa', hint: 'Client data is in. Produce the audit PDF in the external app, then upload it here.' },
  DISPATCH: { label: 'Send to assayer', color: '#60a5fa', hint: 'Packet is ready but the assayer cannot see it until it is sent.' },
  AWAITING_ASSAYER_RETURN: { label: 'With assayer', color: '#f59e0b', hint: 'Sent. Waiting for the scanned paperwork to come back.' },
  SEND_TO_OCR: { label: 'Send to OCR', color: '#38bdf8', hint: 'Paperwork is back. Push it to the external OCR application.' },
  IN_PROGRESS: { label: 'In processing', color: '#22c55e', hint: 'With OCR / data entry.' },
};

export interface DailyRunBranch {
  projectBranchId: string;
  branchId: string;
  branchName: string;
  branchCode: string | null;
  inBatch: boolean;
  customerCount: number;
  packetCount: number;
  pdf: {
    id: string; fileName: string; status: string;
    dispatchedAt: string | null; receivedAt: string | null;
    sentToExternalOcrAt: string | null; fromThisBatch: boolean;
  } | null;
  nextAction: keyof typeof ACTION_META;
}

export interface DailyRun {
  projectId: string;
  auditDate: string;
  batch: {
    id: string; versionNumber: number; fileName: string; status: string;
    totalRows: number; uniqueAccounts: number; duplicateAccounts: number;
    uploadedAt: string; approvedAt: string | null;
  } | null;
  summary: {
    scheduledBranches: number; inBatch: number; awaitingClientData: number;
    toGenerate: number; toDispatch: number; awaitingReturn: number;
    toSendToOcr: number; unexpectedBranchesInBatch: number;
  };
  branches: DailyRunBranch[];
}

const tomorrowISO = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

/**
 * One audit date's run, top to bottom.
 *
 * The client sends a single file the day before covering every branch scheduled
 * for that date. This board is organised around that: the batch at the top, then
 * each branch in it with the one thing that still has to happen for it. It
 * replaces having to infer a day's progress from a flat list of files that had no
 * concept of an audit date or of which run a PDF belonged to.
 */
export const DailyRunPanel: React.FC<{
  projectId: string;
  apiGet: <T,>(e: string) => Promise<T>;
  apiUpload: (e: string, f: FormData) => Promise<any>;
  apiUploadRaw: (e: string, f: FormData) => Promise<any>;
  onDispatch: (ids: string[]) => Promise<void>;
  onSendToOcr: (docId: string) => Promise<void>;
  onDownload: (docId: string) => void;
  onError: (m: string) => void;
  onSuccess: (m: string) => void;
}> = ({ projectId, apiGet, apiUpload, apiUploadRaw, onDispatch, onSendToOcr, onDownload, onError, onSuccess }) => {
  const [auditDate, setAuditDate] = useState(tomorrowISO());
  const [run, setRun] = useState<DailyRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<Set<string>>(new Set());
  const [unmatched, setUnmatched] = useState<Array<{ fileName: string; reason: string }>>([]);

  const load = useCallback(async () => {
    if (!projectId || !auditDate) return;
    setLoading(true);
    try {
      setRun(await apiGet<DailyRun>(`/customer-master/projects/${projectId}/daily-run?auditDate=${auditDate}`));
    } catch (e: any) {
      onError(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, auditDate, apiGet, onError]);

  useEffect(() => { load(); }, [load]);

  const withActing = async (key: string, fn: () => Promise<void>) => {
    setActing((s) => new Set(s).add(key));
    try { await fn(); await load(); } finally {
      setActing((s) => { const n = new Set(s); n.delete(key); return n; });
    }
  };

  const uploadBatch = async (file: File) => {
    await withActing('batch', async () => {
      try {
        await apiUpload(`/customer-master/upload?projectId=${projectId}&auditDate=${auditDate}`, (() => {
          const fd = new FormData(); fd.append('file', file); return fd;
        })());
        onSuccess(`Client batch "${file.name}" uploaded and reconciled.`);
      } catch (e: any) { onError(e.message); }
    });
  };

  const uploadPacket = async (branch: DailyRunBranch, file: File) => {
    await withActing(branch.projectBranchId, async () => {
      try {
        const batchParam = run?.batch ? `&customerMasterVersionId=${run.batch.id}` : '';
        await apiUpload(
          `/documents/upload?assessmentId=${branch.projectBranchId}&type=PRE_FIELD_AUDIT_PDF${batchParam}`,
          (() => { const fd = new FormData(); fd.append('file', file); return fd; })(),
        );
        onSuccess(`Audit packet uploaded for ${branch.branchName}.`);
      } catch (e: any) { onError(e.message); }
    });
  };

  /**
   * The external application returns the whole day's packets at once, so they are
   * uploaded together and matched to branches by filename. Files the server could
   * not place with certainty are reported back rather than filed against a guess.
   */
  const uploadGeneratedBatch = async (files: FileList) => {
    await withActing('bulk', async () => {
      try {
        const fd = new FormData();
        Array.from(files).forEach((f) => fd.append('files', f));
        const batchParam = run?.batch ? `&customerMasterVersionId=${run.batch.id}` : '';
        const res = await apiUploadRaw(
          `/documents/upload-generated-batch?projectId=${projectId}&auditDate=${auditDate}${batchParam}`, fd,
        );
        setUnmatched(res?.data?.unmatched ?? []);
        onSuccess(res?.message || 'Packets uploaded.');
      } catch (e: any) { onError(e.message); }
    });
  };

  const s = run?.summary;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Date picker — the run is identified by its audit date, not a version number. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>Audit date</label>
        <input
          type="date" value={auditDate} onChange={(e) => setAuditDate(e.target.value)}
          style={{ padding: '7px 10px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 13 }}
        />
        <button onClick={() => setAuditDate(tomorrowISO())} className="btn btn-secondary" style={{ fontSize: 11.5, padding: '6px 11px' }}>
          Tomorrow
        </button>
        {loading && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</span>}
      </div>

      {/* Step 1 — the client's file for this date. */}
      <div style={{
        background: 'var(--bg-secondary)',
        border: `1px solid ${run?.batch ? 'var(--border-color)' : 'rgba(239,68,68,0.4)'}`,
        borderRadius: 'var(--radius-md)', padding: 15,
      }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.7px', color: 'var(--text-muted)', marginBottom: 9 }}>
          Step 1 · Client customer master file
        </div>
        {run?.batch ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <CheckCircle2 size={17} color="#22c55e" />
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{run.batch.fileName}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                v{run.batch.versionNumber} · {run.batch.totalRows} rows · {run.batch.uniqueAccounts} accounts
                {run.batch.duplicateAccounts > 0 && <span style={{ color: '#f59e0b' }}> · {run.batch.duplicateAccounts} duplicates</span>}
                {' · '}covers {s?.inBatch} of {s?.scheduledBranches} scheduled branches
              </div>
            </div>
            <span style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 'var(--radius-sm)', background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}>
              {run.batch.status}
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}>
            <AlertTriangle size={17} color="#ef4444" />
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#ef4444' }}>No client data received for this date</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                Nothing can be generated until the client sends the customer master file for {auditDate}.
              </div>
            </div>
            <FileUploadButton label="Upload client file" busy={acting.has('batch')} onFile={uploadBatch} />
          </div>
        )}
        {s && s.unexpectedBranchesInBatch > 0 && (
          <div style={{ marginTop: 9, fontSize: 11.5, color: '#f59e0b' }}>
            {s.unexpectedBranchesInBatch} branch(es) in the client file are not scheduled for this date.
          </div>
        )}
      </div>

      {/* Step 2 — the branches, each with its one next action. */}
      {run && run.branches.length === 0 && (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
          No branches are scheduled for {auditDate}.
        </div>
      )}

      {run && run.branches.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 9, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.7px', color: 'var(--text-muted)' }}>
              Step 2 · {run.branches.length} branch{run.branches.length === 1 ? '' : 'es'} scheduled for this date
            </div>
            {s && s.toGenerate > 0 && (
              <label style={{
                marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', fontSize: 11.5, fontWeight: 600,
                background: 'rgba(99,102,241,0.1)', color: 'var(--accent-primary)',
                border: '1px solid rgba(99,102,241,0.4)', borderRadius: 'var(--radius-sm)',
                cursor: acting.has('bulk') ? 'wait' : 'pointer',
              }}>
                <UploadCloud size={12} />
                {acting.has('bulk') ? 'Filing packets…' : `Upload all ${s.toGenerate} packets together`}
                <input type="file" multiple accept=".pdf" style={{ display: 'none' }} disabled={acting.has('bulk')}
                  onChange={(e) => { const f = e.target.files; if (f?.length) uploadGeneratedBatch(f); e.target.value = ''; }} />
              </label>
            )}
          </div>

          {unmatched.length > 0 && (
            <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: 'var(--radius-md)', padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#f59e0b', fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>
                <AlertTriangle size={14} />
                {unmatched.length} file(s) could not be matched to a branch — upload these individually below
              </div>
              {unmatched.map((u) => (
                <div key={u.fileName} style={{ fontSize: 11.5, color: 'var(--text-secondary)', padding: '2px 0' }}>
                  <strong>{u.fileName}</strong> — {u.reason}
                </div>
              ))}
              <button onClick={() => setUnmatched([])} style={{ marginTop: 6, background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer', padding: 0 }}>
                Dismiss
              </button>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {run.branches.map((b) => {
              const meta = ACTION_META[b.nextAction] ?? { label: b.nextAction, color: '#94a3b8', hint: '' };
              const busy = acting.has(b.projectBranchId);
              return (
                <div key={b.projectBranchId} style={{
                  background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                  borderLeft: `3px solid ${meta.color}`, borderRadius: 'var(--radius-md)',
                  padding: '11px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{b.branchName}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {b.inBatch
                        ? `${b.customerCount} customers · ${b.packetCount} packets`
                        : 'not in the client file'}
                      {b.branchCode ? ` · ${b.branchCode}` : ''}
                    </div>
                  </div>

                  <span title={meta.hint} style={{
                    fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 'var(--radius-sm)',
                    background: `${meta.color}22`, color: meta.color, whiteSpace: 'nowrap',
                  }}>{meta.label}</span>

                  {/* Exactly one action, matching nextAction — no menu of mostly-invalid buttons. */}
                  {b.nextAction === 'GENERATE_PDF' && (
                    <FileUploadButton label="Upload packet" busy={busy} onFile={(f) => uploadPacket(b, f)} />
                  )}
                  {b.nextAction === 'DISPATCH' && b.pdf && (
                    <button onClick={() => withActing(b.projectBranchId, () => onDispatch([b.pdf!.id]))} disabled={busy}
                      className="btn btn-primary" style={{ padding: '4px 10px', fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Send size={11} /> {busy ? '…' : 'Send'}
                    </button>
                  )}
                  {b.nextAction === 'AWAITING_ASSAYER_RETURN' && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)' }}>
                      <Clock size={12} /> waiting
                    </span>
                  )}
                  {b.nextAction === 'SEND_TO_OCR' && b.pdf && (
                    <button onClick={() => withActing(b.projectBranchId, () => onSendToOcr(b.pdf!.id))} disabled={busy}
                      className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 5, color: '#38bdf8', borderColor: 'rgba(56,189,248,0.4)' }}>
                      <ArrowRightCircle size={11} /> {busy ? '…' : 'Send to OCR'}
                    </button>
                  )}
                  {b.pdf && (
                    <button onClick={() => onDownload(b.pdf!.id)} className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 11.5 }}>
                      Download
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

const FileUploadButton: React.FC<{ label: string; busy: boolean; onFile: (f: File) => void }> = ({ label, busy, onFile }) => (
  <label style={{
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', fontSize: 11.5, fontWeight: 600,
    background: 'rgba(99,102,241,0.1)', color: 'var(--accent-primary)', border: '1px solid rgba(99,102,241,0.4)',
    borderRadius: 'var(--radius-sm)', cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap',
  }}>
    <UploadCloud size={12} />
    {busy ? 'Uploading…' : label}
    <input type="file" style={{ display: 'none' }} disabled={busy}
      onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
  </label>
);
