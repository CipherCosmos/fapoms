import React, { useState, useEffect, useCallback } from 'react';
import { UploadCloud, AlertTriangle, CheckCircle2, Clock, Send, ArrowRightCircle } from 'lucide-react';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { counted } from '../../utils/plural';
import { UPLOAD_LIMIT_HINT } from '@fapoms/shared';

/**
 * What still has to happen for a branch on this audit date. Ordered as the day
 * actually runs, so the board reads left-to-right as work moves.
 */
const ACTION_META: Record<string, { label: string; color: string; bg: string; hint: string }> = {
  AWAITING_CLIENT_DATA: { label: 'No client data', color: 'var(--danger)', bg: 'var(--status-cancelled-bg)', hint: 'This branch is scheduled today but is not in the client\'s file.' },
  GENERATE_PDF: { label: 'Generate packet', color: 'var(--accent)', bg: 'var(--status-pending-bg)', hint: 'Client data is in. Produce the audit PDF in the external app, then upload it here.' },
  DISPATCH: { label: 'Send to assayer', color: 'var(--accent)', bg: 'var(--status-pending-bg)', hint: 'Packet is ready but the assayer cannot see it until it is sent.' },
  AWAITING_ASSAYER_RETURN: { label: 'With assayer', color: 'var(--warning)', bg: 'var(--status-pending-bg)', hint: 'Sent. Waiting for the scanned paperwork to come back.' },
  SEND_TO_OCR: { label: 'Send to OCR', color: 'var(--accent)', bg: 'var(--status-pending-bg)', hint: 'Paperwork is back. Push it to the external OCR application.' },
  IN_PROGRESS: { label: 'In processing', color: 'var(--success)', bg: 'var(--status-completed-bg)', hint: 'With OCR / data entry.' },
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

/**
 * What the reconciliation actually did with the client's file — the true outcome, not a flat
 * "uploaded and reconciled" toast. `accepted` is false when the thresholds rejected the batch;
 * `unmatchedAccounts` are the rows that tied to no branch, which the desk must fix or knowingly
 * ignore before anything is generated.
 */
interface ReconOutcome {
  versionNumber: number;
  uniqueAccountsCount: number;
  duplicateAccountsCount: number;
  status: string;
  accepted: boolean;
  blockReason: string | null;
  unmatchedCount: number;
  unmatchedAccounts: Array<{ accountNumber: string; branchCode: string | null; reason: string }>;
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
 *
 * Calls the shared API client directly rather than taking fetch helpers as props. The parent used
 * to inject its own `apiGet`/`apiUpload`/`apiUploadRaw`, which is how this panel ended up on a
 * private copy of the client that could not refresh an expired token — the injection point was the
 * thing that let a second implementation exist at all.
 */
export const DailyRunPanel: React.FC<{
  projectId: string;
  onDispatch: (ids: string[]) => Promise<void>;
  onSendToOcr: (docId: string) => Promise<void>;
  onDownload: (docId: string) => void;
  onError: (m: string) => void;
  onSuccess: (m: string) => void;
}> = ({ projectId, onDispatch, onSendToOcr, onDownload, onError, onSuccess }) => {
  const [auditDate, setAuditDate] = useState(tomorrowISO());
  const [run, setRun] = useState<DailyRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<Set<string>>(new Set());
  const [unmatched, setUnmatched] = useState<Array<{ fileName: string; reason: string }>>([]);
  const [recon, setRecon] = useState<ReconOutcome | null>(null);

  const load = useCallback(async () => {
    if (!projectId || !auditDate) return;
    setLoading(true);
    try {
      setRun(await api.request<DailyRun>(`/customer-master/projects/${projectId}/daily-run?auditDate=${auditDate}`));
    } catch (e) {
      onError(userMessage(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, auditDate, onError]);

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
        // The reconciliation report, not a fire-and-forget POST. It carries the true outcome
        // (accepted vs rejected + why) and the account rows that matched no branch, so the toast
        // can tell the truth and the exceptions can be shown instead of hidden behind a flat
        // "uploaded and reconciled" that lied on a rejection.
        const report = await api.request<ReconOutcome>(
          `/customer-master/upload?projectId=${projectId}&auditDate=${auditDate}`,
          { method: 'POST', body: (() => { const fd = new FormData(); fd.append('file', file); return fd; })() },
        );
        setRecon(report);
        if (report.accepted) {
          onSuccess(
            `Client batch "${file.name}" accepted — v${report.versionNumber}, ${counted(report.uniqueAccountsCount, 'account')}` +
            (report.unmatchedCount > 0 ? `, ${counted(report.unmatchedCount, 'row')} matched no branch (see below)` : '') + '.',
          );
        } else {
          // A rejection is a failure, and must read as one — not a success toast.
          onError(`Client batch "${file.name}" was rejected. ${report.blockReason ?? ''}`.trim());
        }
      } catch (e) { onError(userMessage(e)); }
    });
  };

  const uploadPacket = async (branch: DailyRunBranch, file: File) => {
    await withActing(branch.projectBranchId, async () => {
      try {
        const batchParam = run?.batch ? `&customerMasterVersionId=${run.batch.id}` : '';
        await api.request(
          `/documents/upload?assessmentId=${branch.projectBranchId}&type=PRE_FIELD_AUDIT_PDF${batchParam}`,
          { method: 'POST', body: (() => { const fd = new FormData(); fd.append('file', file); return fd; })() },
        );
        onSuccess(`Audit packet uploaded for ${branch.branchName}.`);
      } catch (e) { onError(userMessage(e)); }
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
        // `withMeta` because this is the one call on the page that needs the envelope itself: the
        // per-file outcomes are in `data`, the summary sentence the operator reads is the
        // envelope's own `message`, and unwrapping to `data` would drop the latter.
        const res = await api.request<{
          data?: { unmatched?: Array<{ fileName: string; reason: string }> };
          message?: string;
        }>(
          `/documents/upload-generated-batch?projectId=${projectId}&auditDate=${auditDate}${batchParam}`,
          { method: 'POST', body: fd, withMeta: true },
        );
        setUnmatched(res?.data?.unmatched ?? []);
        onSuccess(res?.message || 'Packets uploaded.');
      } catch (e) { onError(userMessage(e)); }
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
        border: `1px solid ${run?.batch ? 'var(--border-color)' : 'var(--status-cancelled-bg)'}`,
        borderRadius: 'var(--radius-md)', padding: 15,
      }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.7px', color: 'var(--text-muted)', marginBottom: 9 }}>
          Step 1 · Client customer master file
        </div>
        {run?.batch ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <CheckCircle2 size={17} color="var(--success)" />
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{run.batch.fileName}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                v{run.batch.versionNumber} · {run.batch.totalRows} rows · {run.batch.uniqueAccounts} accounts
                {run.batch.duplicateAccounts > 0 && <span style={{ color: 'var(--warning)' }}> · {run.batch.duplicateAccounts} duplicates</span>}
                {' · '}covers {s?.inBatch} of {s?.scheduledBranches} scheduled branches
              </div>
            </div>
            <span style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 'var(--radius-sm)', background: 'var(--status-completed-bg)', color: 'var(--success)' }}>
              {run.batch.status}
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}>
            <AlertTriangle size={17} color="var(--danger)" />
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger)' }}>No client data received for this date</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                Nothing can be generated until the client sends the customer master file for {auditDate}.
              </div>
            </div>
            <FileUploadButton label="Upload client file" busy={acting.has('batch')} onFile={uploadBatch} />
          </div>
        )}
        {s && s.unexpectedBranchesInBatch > 0 && (
          <div style={{ marginTop: 9, fontSize: 11.5, color: 'var(--warning)' }}>
            {counted(s.unexpectedBranchesInBatch, 'branch', 'branches')} in the client file are not scheduled for this date.
          </div>
        )}
      </div>

      {/* The reconciliation exceptions from the most recent upload: the true outcome, and the
          account rows that tied to no branch. Shown until dismissed so a rejection or a pile of
          unmatched rows cannot be missed the way the old flat toast let them be. */}
      {recon && (!recon.accepted || recon.unmatchedCount > 0) && (
        <div style={{
          background: recon.accepted ? 'var(--status-pending-bg)' : 'var(--status-cancelled-bg)',
          border: `1px solid ${recon.accepted ? 'var(--status-pending-bg)' : 'var(--status-cancelled-bg)'}`,
          borderRadius: 'var(--radius-md)', padding: 13,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: recon.accepted ? 'var(--warning)' : 'var(--danger)', fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
            <AlertTriangle size={15} />
            {recon.accepted
              ? `Accepted with exceptions — ${counted(recon.unmatchedCount, 'account row')} matched no branch`
              : 'Batch rejected — nothing was generated'}
          </div>
          {!recon.accepted && recon.blockReason && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>{recon.blockReason}</div>
          )}
          {recon.unmatchedCount > 0 && (
            <>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 6 }}>
                These {counted(recon.unmatchedCount, 'account row')} matched no branch — fix the branch code in the file, or ignore them and generate the rest.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {recon.unmatchedAccounts.map((u, i) => (
                  <div key={`${u.accountNumber}-${i}`} style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                    <strong>{u.accountNumber}</strong>
                    {u.branchCode ? ` · ${u.branchCode}` : ''} — {u.reason}
                  </div>
                ))}
              </div>
              {recon.unmatchedCount > recon.unmatchedAccounts.length && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  …and {counted(recon.unmatchedCount - recon.unmatchedAccounts.length, 'more row')} not listed.
                </div>
              )}
            </>
          )}
          <button onClick={() => setRecon(null)} style={{ marginTop: 8, background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer', padding: 0 }}>
            Dismiss
          </button>
        </div>
      )}

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
                background: 'var(--status-pending-bg)', color: 'var(--accent-primary)',
                border: '1px solid var(--status-pending-bg)', borderRadius: 'var(--radius-sm)',
                cursor: acting.has('bulk') ? 'wait' : 'pointer',
              }}>
                <UploadCloud size={12} />
                {acting.has('bulk') ? 'Filing packets…' : `Upload all ${s.toGenerate} packets together`}
                {/* Said before the file dialog opens, not after a batch has crawled up and been
                    refused. One oversized packet in a batch fails only that packet. */}
                <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>· {UPLOAD_LIMIT_HINT}</span>
                <input type="file" multiple accept=".pdf" style={{ display: 'none' }} disabled={acting.has('bulk')}
                  onChange={(e) => { const f = e.target.files; if (f?.length) uploadGeneratedBatch(f); e.target.value = ''; }} />
              </label>
            )}
          </div>

          {unmatched.length > 0 && (
            <div style={{ background: 'var(--status-pending-bg)', border: '1px solid var(--status-pending-bg)', borderRadius: 'var(--radius-md)', padding: 12, marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--warning)', fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>
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
              const meta = ACTION_META[b.nextAction] ?? { label: b.nextAction, color: 'var(--text-muted)', bg: 'var(--status-draft-bg)', hint: '' };
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
                    background: meta.bg, color: meta.color, whiteSpace: 'nowrap',
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
                      className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 5, color: 'var(--accent)', borderColor: 'var(--status-pending-bg)' }}>
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
  <label title={UPLOAD_LIMIT_HINT} style={{
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', fontSize: 11.5, fontWeight: 600,
    background: 'var(--status-pending-bg)', color: 'var(--accent-primary)', border: '1px solid var(--status-pending-bg)',
    borderRadius: 'var(--radius-sm)', cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap',
  }}>
    <UploadCloud size={12} />
    {busy ? 'Uploading…' : label}
    <input type="file" style={{ display: 'none' }} disabled={busy}
      onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
  </label>
);
