import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { UploadCloud, AlertTriangle, CheckCircle2, Clock, Send, ArrowRightCircle } from 'lucide-react';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { counted } from '../../utils/plural';
import { UPLOAD_LIMIT_HINT, businessDateKey, isBackgroundJobInFlight, type BackgroundJobScope, type BackgroundJobSummary } from '@fapoms/shared';
import { useBackgroundJob } from '../../hooks/useBackgroundJob';
import { BackgroundJobPanel } from '../../components/jobs/BackgroundJobPanel';
// The day's steps live with every other document word — see documents/vocabulary.ts.
import { DAILY_RUN_STEP as ACTION_META } from './vocabulary';

/**
 * What still has to happen for a branch on this audit date. Ordered as the day
 * actually runs, so the board reads left-to-right as work moves.
 */

export interface DailyRunBranch {
  projectBranchId: string;
  branchId: string;
  branchName: string;
  solId: string | null;
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
  /** The audit date the batch was for — so a result is shown only on its own date's board. */
  auditDate?: string | null;
  versionNumber: number;
  uniqueAccountsCount: number;
  duplicateAccountsCount: number;
  status: string;
  accepted: boolean;
  blockReason: string | null;
  unmatchedCount: number;
  unmatchedAccounts: Array<{ accountNumber: string; solId: string | null; reason: string }>;
}

/**
 * What filing a day's packets did, file by file — the result of the GENERATED_DOCUMENT_BATCH job.
 * Files the server could not place with certainty are listed, never filed against a guess.
 */
interface PacketBatchOutcome {
  auditDate: string;
  created: Array<{ documentId: string; fileName: string; branchName: string }>;
  unmatched: Array<{ fileName: string; reason: string }>;
  failed: Array<{ fileName: string; reason: string }>;
}

/** A finished job's details, when it is the one this board is showing (same audit date). */
function finishedDetails<T extends { auditDate?: string | null }>(
  job: BackgroundJobSummary | null,
  auditDate: string,
  dismissed: string | null,
): T | null {
  if (!job || job.status !== 'SUCCEEDED' || job.id === dismissed) return null;
  const details = job.result?.details as T | undefined;
  if (!details || (details.auditDate ?? null) !== auditDate) return null;
  return details;
}

/**
 * Calls `onSettled` when a job this page has watched while in flight finishes — never for a job
 * that had already finished when the page loaded (a refresh restores its result silently).
 */
function useJobSettled(job: BackgroundJobSummary | null, onSettled: (job: BackgroundJobSummary) => void) {
  const seen = useRef(new Map<string, BackgroundJobSummary['status']>());
  const callback = useRef(onSettled);
  callback.current = onSettled;
  useEffect(() => {
    if (!job) return;
    const previous = seen.current.get(job.id);
    seen.current.set(job.id, job.status);
    if (previous && isBackgroundJobInFlight(previous) && !isBackgroundJobInFlight(job.status)) {
      callback.current(job);
    }
  }, [job]);
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
  return businessDateKey(d);
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
  /**
   * Whoever can see this tab at all includes CLIENT_USER (an external bank account, via
   * `canReadCustomerMaster` on the page above) — these two default to `true` only so an older
   * caller that hasn't been updated to pass them still renders as it always did, not because
   * everyone is actually meant to dispatch or push to OCR.
   */
  canDispatch?: boolean;
  canSendToOcr?: boolean;
  /**
   * Upload and download, by the same rule (document-actions.ts): the upload routes are ADMIN,
   * OPERATIONS, DESK and the download token also DESK_OPERATOR — never AUDITOR or CLIENT_USER.
   * Omitted: offered, as before.
   */
  canUpload?: boolean;
  canDownload?: boolean;
}> = ({ projectId, onDispatch, onSendToOcr, onDownload, onError, onSuccess, canDispatch = true, canSendToOcr = true, canUpload = true, canDownload = true }) => {
  const [auditDate, setAuditDate] = useState(tomorrowISO());
  const [run, setRun] = useState<DailyRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<Set<string>>(new Set());
  /**
   * The client batch's reconciliation, and the day's packets, each run as a background job on the
   * server (`CUSTOMER_MASTER_IMPORT`, `GENERATED_DOCUMENT_BATCH`). The page reads them back from
   * `GET /jobs` on mount, so a refresh — or a hard refresh — mid-run shows the progress again, and
   * a finished run's report again; nothing is kept in the browser.
   */
  const jobScope = useMemo<BackgroundJobScope>(() => ({ type: 'PROJECT', id: projectId }), [projectId]);
  const batchImport = useBackgroundJob('CUSTOMER_MASTER_IMPORT', jobScope, { endpoint: '/customer-master/upload' });
  const packetBatch = useBackgroundJob('GENERATED_DOCUMENT_BATCH', jobScope, { endpoint: '/documents/upload-generated-batch' });
  /** The result a person dismissed (by job id), so it stays dismissed while they work. */
  const [dismissedRecon, setDismissedRecon] = useState<string | null>(null);
  const [dismissedPackets, setDismissedPackets] = useState<string | null>(null);
  const recon = finishedDetails<ReconOutcome>(batchImport.job, auditDate, dismissedRecon);
  const packets = finishedDetails<PacketBatchOutcome>(packetBatch.job, auditDate, dismissedPackets);
  const importBusy = batchImport.upload.phase === 'uploading' || batchImport.active.length > 0;
  const packetsBusy = packetBatch.upload.phase === 'uploading' || packetBatch.active.length > 0;

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

  useEffect(() => { void load(); }, [load]);

  const withActing = async (key: string, fn: () => Promise<void>) => {
    setActing((s) => new Set(s).add(key));
    try { await fn(); await load(); } finally {
      setActing((s) => { const n = new Set(s); n.delete(key); return n; });
    }
  };

  /**
   * Send the client batch; the reconciliation happens in the background.
   *
   * Reconciling a daily file walks every row against this client's branches by SOL ID and then
   * registers a version. The server answers 202 as soon as the file is stored; the job's progress
   * shows below and in the Jobs tray, and the page can be left or refreshed in the meantime.
   */
  const uploadBatch = async (file: File) => {
    await batchImport.start(file, { projectId, auditDate });
  };

  /** Report a reconciliation this page watched finish — the true outcome, not a flat toast. */
  useJobSettled(batchImport.job, (job) => {
    if (job.status === 'SUCCEEDED') {
      const report = job.result?.details as ReconOutcome | undefined;
      const fileName = job.inputFileName ?? 'the file';
      if (report?.accepted) {
        onSuccess(
          `Client batch "${fileName}" accepted — v${report.versionNumber}, ${counted(report.uniqueAccountsCount, 'account')}` +
          (report.unmatchedCount > 0 ? `, ${counted(report.unmatchedCount, 'row')} matched no branch (see below)` : '') + '.',
        );
      } else if (report) {
        // A rejection is a failure, and must read as one — not a success toast.
        onError(`Client batch "${fileName}" was rejected. ${report.blockReason ?? ''}`.trim());
      }
    } else if (job.status === 'FAILED') {
      onError(job.error ?? 'The client batch could not be reconciled.');
    }
    void load();
  });

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
   * The external application returns the whole day's packets at once, so they are uploaded together
   * and matched to branches by filename — in the background: the server stores the set and answers
   * at once, then scans and files each packet. Files it could not place with certainty are reported
   * back rather than filed against a guess; they are uploaded one by one on their branch below.
   */
  const uploadGeneratedBatch = async (files: FileList) => {
    await packetBatch.start(Array.from(files), {
      projectId,
      auditDate,
      customerMasterVersionId: run?.batch?.id ?? null,
    });
  };

  useJobSettled(packetBatch.job, (job) => {
    if (job.status === 'SUCCEEDED') onSuccess(job.result?.summary || 'Packets filed.');
    else if (job.status === 'FAILED') onError(job.error ?? 'The packets could not be filed.');
    void load();
  });

  const s = run?.summary;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Date picker — the run is identified by its audit date, not a version number. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', fontWeight: 600 }}>Audit date</label>
        <input
          type="date" value={auditDate} onChange={(e) => setAuditDate(e.target.value)}
          title="Pick which audit date's daily run to show"
          style={{ padding: '7px 10px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 'var(--text-sm)' }}
        />
        <button onClick={() => setAuditDate(tomorrowISO())} title="Jump back to tomorrow's audit date" className="btn btn-secondary" style={{ fontSize: 'var(--text-2xs)', padding: '6px 11px' }}>
          Tomorrow
        </button>
        {loading && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Loading…</span>}
      </div>

      {/* Step 1 — the client's file for this date. */}
      <div style={{
        background: 'var(--bg-secondary)',
        border: `1px solid ${run?.batch ? 'var(--border-color)' : 'var(--status-cancelled-bg)'}`,
        borderRadius: 'var(--radius-md)', padding: 15,
      }}>
        <div style={{ fontSize: 'var(--text-3xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.7px', color: 'var(--text-muted)', marginBottom: 9 }}>
          Step 1 · Client customer master file
        </div>
        {run?.batch ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <CheckCircle2 size={17} color="var(--success)" />
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{run.batch.fileName}</div>
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                v{run.batch.versionNumber} · {run.batch.totalRows} rows · {run.batch.uniqueAccounts} accounts
                {run.batch.duplicateAccounts > 0 && <span style={{ color: 'var(--warning)' }}> · {run.batch.duplicateAccounts} duplicates</span>}
                {' · '}covers {s?.inBatch} of {s?.scheduledBranches} scheduled branches
              </div>
            </div>
            <span style={{ fontSize: 'var(--text-3xs)', fontWeight: 700, padding: '3px 9px', borderRadius: 'var(--radius-sm)', background: 'var(--status-completed-bg)', color: 'var(--success)' }}>
              {run.batch.status}
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}>
            <AlertTriangle size={17} color="var(--danger)" />
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--danger)' }}>No client data received for this date</div>
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                Nothing can be generated until the client sends the customer master file for {auditDate}.
              </div>
            </div>
            {canUpload && <FileUploadButton label="Upload client file" busy={importBusy} onFile={uploadBatch} />}
          </div>
        )}
        {/* The upload, then the reconciliation while it runs — restored after a refresh. */}
        <div style={{ marginTop: batchImport.upload.phase !== 'idle' || batchImport.active.length > 0 ? 10 : 0 }}>
          <BackgroundJobPanel handle={batchImport} showFinished={false} />
        </div>
        {s && s.unexpectedBranchesInBatch > 0 && (
          <div style={{ marginTop: 9, fontSize: 'var(--text-2xs)', color: 'var(--warning)' }}>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: recon.accepted ? 'var(--warning)' : 'var(--danger)', fontWeight: 700, fontSize: 'var(--text-sm)', marginBottom: 6 }}>
            <AlertTriangle size={15} />
            {recon.accepted
              ? `Accepted with exceptions — ${counted(recon.unmatchedCount, 'account row')} matched no branch`
              : 'Batch rejected — nothing was generated'}
          </div>
          {!recon.accepted && recon.blockReason && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 8 }}>{recon.blockReason}</div>
          )}
          {recon.unmatchedCount > 0 && (
            <>
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', marginBottom: 6 }}>
                These {counted(recon.unmatchedCount, 'account row')} matched no branch — fix the branch code in the file, or ignore them and generate the rest.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {recon.unmatchedAccounts.map((u, i) => (
                  <div key={`${u.accountNumber}-${i}`} style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)' }}>
                    <strong>{u.accountNumber}</strong>
                    {u.solId ? ` · ${u.solId}` : ''} — {u.reason}
                  </div>
                ))}
              </div>
              {recon.unmatchedCount > recon.unmatchedAccounts.length && (
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: 4 }}>
                  …and {counted(recon.unmatchedCount - recon.unmatchedAccounts.length, 'more row')} not listed.
                </div>
              )}
            </>
          )}
          <button onClick={() => setDismissedRecon(batchImport.job?.id ?? null)} title="Dismiss this batch result message" style={{ marginTop: 8, background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 'var(--text-2xs)', cursor: 'pointer', padding: 0 }}>
            Dismiss
          </button>
        </div>
      )}

      {/* Step 2 — the branches, each with its one next action. */}
      {run && run.branches.length === 0 && (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
          No branches are scheduled for {auditDate}.
        </div>
      )}

      {run && run.branches.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 9, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 'var(--text-3xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.7px', color: 'var(--text-muted)' }}>
              Step 2 · {run.branches.length} branch{run.branches.length === 1 ? '' : 'es'} scheduled for this date
            </div>
            {canUpload && s && s.toGenerate > 0 && (
              <label style={{
                marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', fontSize: 'var(--text-2xs)', fontWeight: 600,
                background: 'var(--status-pending-bg)', color: 'var(--accent-primary)',
                border: '1px solid var(--status-pending-bg)', borderRadius: 'var(--radius-sm)',
                cursor: packetsBusy ? 'wait' : 'pointer',
              }}>
                <UploadCloud size={12} />
                {packetsBusy ? 'Filing packets…' : `Upload all ${s.toGenerate} packets together`}
                {/* Said before the file dialog opens, not after a batch has crawled up and been
                    refused. One oversized packet in a batch fails only that packet. */}
                <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>· {UPLOAD_LIMIT_HINT}</span>
                <input type="file" multiple accept=".pdf" style={{ display: 'none' }} disabled={packetsBusy}
                  onChange={(e) => { const f = e.target.files; if (f?.length) void uploadGeneratedBatch(f); e.target.value = ''; }} />
              </label>
            )}
          </div>

          {/* The packets' upload, then the filing while it runs — restored after a refresh. */}
          <div style={{ marginBottom: packetBatch.upload.phase !== 'idle' || packetBatch.active.length > 0 ? 10 : 0 }}>
            <BackgroundJobPanel handle={packetBatch} showFinished={false} />
          </div>

          {packets && (packets.unmatched.length > 0 || packets.failed.length > 0) && (
            <div style={{ background: 'var(--status-pending-bg)', border: '1px solid var(--status-pending-bg)', borderRadius: 'var(--radius-md)', padding: 12, marginBottom: 10 }}>
              {packets.unmatched.length > 0 && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--warning)', fontWeight: 700, fontSize: 'var(--text-xs)', marginBottom: 6 }}>
                    <AlertTriangle size={14} />
                    {packets.unmatched.length} file(s) could not be matched to a branch — upload these individually below
                  </div>
                  {packets.unmatched.map((u) => (
                    <div key={u.fileName} style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', padding: '2px 0' }}>
                      <strong>{u.fileName}</strong> — {u.reason}
                    </div>
                  ))}
                </>
              )}
              {packets.failed.length > 0 && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--danger)', fontWeight: 700, fontSize: 'var(--text-xs)', margin: packets.unmatched.length > 0 ? '8px 0 6px' : '0 0 6px' }}>
                    <AlertTriangle size={14} />
                    {packets.failed.length} file(s) were not filed
                  </div>
                  {packets.failed.map((f) => (
                    <div key={f.fileName} style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', padding: '2px 0' }}>
                      <strong>{f.fileName}</strong> — {f.reason}
                    </div>
                  ))}
                </>
              )}
              <button onClick={() => setDismissedPackets(packetBatch.job?.id ?? null)} title="Dismiss the unmatched files list" style={{ marginTop: 6, background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 'var(--text-2xs)', cursor: 'pointer', padding: 0 }}>
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
                    <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{b.branchName}</div>
                    <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                      {b.inBatch
                        ? `${b.customerCount} customers · ${b.packetCount} packets`
                        : 'not in the client file'}
                      {b.solId ? ` · ${b.solId}` : ''}
                    </div>
                  </div>

                  <span title={meta.hint} style={{
                    fontSize: 'var(--text-3xs)', fontWeight: 700, padding: '3px 9px', borderRadius: 'var(--radius-sm)',
                    background: meta.bg, color: meta.color, whiteSpace: 'nowrap',
                  }}>{meta.label}</span>

                  {/* Exactly one action, matching nextAction — no menu of mostly-invalid buttons. */}
                  {b.nextAction === 'GENERATE_PDF' && canUpload && (
                    <FileUploadButton label="Upload packet" busy={busy} onFile={(f) => uploadPacket(b, f)} />
                  )}
                  {b.nextAction === 'DISPATCH' && b.pdf && canDispatch && (
                    <button onClick={() => withActing(b.projectBranchId, () => onDispatch([b.pdf!.id]))} disabled={busy} title={`Send audit packet for ${b.branchName} to the assayer`}
                      className="btn btn-primary" style={{ padding: '4px 10px', fontSize: 'var(--text-2xs)', display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Send size={11} /> {busy ? '…' : 'Send'}
                    </button>
                  )}
                  {b.nextAction === 'AWAITING_ASSAYER_RETURN' && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                      <Clock size={12} /> waiting
                    </span>
                  )}
                  {b.nextAction === 'SEND_TO_OCR' && b.pdf && canSendToOcr && (
                    <button onClick={() => withActing(b.projectBranchId, () => onSendToOcr(b.pdf!.id))} disabled={busy} title={`Send ${b.branchName} return for text scanning`}
                      className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 'var(--text-2xs)', display: 'flex', alignItems: 'center', gap: 5, color: 'var(--accent)', borderColor: 'var(--status-pending-bg)' }}>
                      <ArrowRightCircle size={11} /> {busy ? '…' : 'Send for scanning'}
                    </button>
                  )}
                  {b.pdf && canDownload && (
                    <button onClick={() => onDownload(b.pdf!.id)} title={`Download paperwork file for ${b.branchName}`} className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 'var(--text-2xs)' }}>
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
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', fontSize: 'var(--text-2xs)', fontWeight: 600,
    background: 'var(--status-pending-bg)', color: 'var(--accent-primary)', border: '1px solid var(--status-pending-bg)',
    borderRadius: 'var(--radius-sm)', cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap',
  }}>
    <UploadCloud size={12} />
    {busy ? 'Uploading…' : label}
    <input type="file" style={{ display: 'none' }} disabled={busy}
      onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
  </label>
);
