import React, { useState, useEffect, useCallback, useRef } from 'react';
import { DocumentControlPanel } from './documents/DocumentControlPanel';
import type { OverviewData } from './documents/DocumentControlPanel';
import { BranchDocumentPanel } from './documents/BranchDocumentPanel';
import { DocumentModelLegend } from './documents/DocumentModelLegend';
import { DailyRunPanel } from './documents/DailyRunPanel';
import { CustomerMasterVersions } from './CustomerMasterVersions';
import { RefreshCw } from 'lucide-react';
import { AlertBanner, Select, useConfirm } from '../components/ui';
import { connectSocket, getSocket } from '../services/socket';
import { fetchWithTimeout } from '../services/http';
import { api } from '../services/api';
import { userMessage, AppError } from '../services/errors';
import { uploadSizeProblem } from '@fapoms/shared';

/**
 * The presigned PUT's own budget, longer than the API default because the file, not the network,
 * sets the pace: scanned audit paperwork runs to several megabytes and branch offices upload over
 * ADSL. Ten minutes covers the worst real case we have seen with room to spare, while still
 * guaranteeing the upload ends — which is the whole point, since the multipart fallback below
 * cannot run until this one gives up.
 */
const PRESIGNED_UPLOAD_TIMEOUT_MS = 600_000;

/**
 * Branch cards per page.
 *
 * The server clamps this to 100 whatever we ask for. The list used to arrive whole — 40,087 rows
 * and 17.0 MB of JSON for a screen that shows a couple of dozen cards.
 */
const BRANCH_PAGE_SIZE = 25;

/** Matches the global search box, so typing feels the same in both places. */
const BRANCH_SEARCH_DEBOUNCE_MS = 200;

/**
 * Opens a document download.
 *
 * The download endpoint is no longer public — it previously served bank customer paperwork to
 * anyone who could reach the API. It now requires a short-lived token bound to that one
 * document, so a bare `<a href>` (which cannot send our Authorization header) would just 401.
 * Exchange the session for a scoped token first, then open the signed URL.
 */
async function openDocumentDownload(documentId: string): Promise<void> {
  const { downloadUrl } = await api.request<{ downloadUrl: string }>(`/documents/${documentId}/download-token`);
  window.open(`/api/v1${downloadUrl}`, '_blank', 'noopener,noreferrer');
}

/**
 * Upload one document, preferring the presigned direct-to-storage path (POST
 * /documents/upload/presign → client PUT straight to object storage → POST
 * /documents/upload/finalize) so the file bytes never buffer through the API process.
 *
 * Falls back to the original multipart `/documents/upload` when the presigned path fails for a
 * *transport* reason — the local-disk storage driver (no presign), a storage endpoint the browser
 * cannot reach, or a bucket without CORS. The fallback guarantees this can never upload less
 * reliably than before; it only upgrades the transport when direct-to-storage is available.
 *
 * It deliberately does NOT retry when the server *rejected the file itself* (400: disallowed type,
 * over the size cap). Retrying a refusal through a second door was the whole problem: the multipart
 * route used to skip those checks, so a file the API had just refused was accepted on the next
 * request. Both routes validate now, so a blind retry would only turn one clear error into two
 * confusing ones — but keeping the distinction here means the client is not the thing standing
 * between a rejected file and storage.
 */
async function uploadDocumentSmart(assessmentId: string, type: string, file: File): Promise<any> {
  // Refused here, before any of the three transports below is attempted. The server enforces the
  // same ceiling and is still the authority — but it can only say no *after* the bytes have been
  // pushed to it, which on an office link is several minutes of watching a spinner to be told the
  // file was never going to be accepted. The limit is also written next to the file pickers, so
  // this is the second line, not the only one. `MAX_UPLOAD_MB` comes from @fapoms/shared, the same
  // constant the API's cap defaults to.
  const tooBig = uploadSizeProblem(file);
  if (tooBig) throw new AppError(tooBig, undefined, 400);

  const contentType = file.type || 'application/octet-stream';
  try {
    const presign = await api.request<{ uploadUrl?: string; objectKey?: string }>('/documents/upload/presign', {
      method: 'POST',
      body: JSON.stringify({ fileName: file.name, contentType }),
    });
    if (!presign?.uploadUrl || !presign?.objectKey) throw new Error('presign unavailable');

    // Bounded on the long budget: this is a multi-megabyte PUT to object storage, so it is slow
    // by nature — but it is also the one hop that does not touch our API, which means a bucket
    // that accepts the connection and stalls (wrong region, missing CORS preflight, a proxy that
    // blackholes PUT) is invisible to every timeout we already had. Worse, the fallback to the
    // multipart upload below lives in this function's `catch`, so a hang did not merely delay the
    // upload — it prevented the retry path that exists precisely for storage being unavailable.
    const put = await fetchWithTimeout(presign.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: file,
      timeoutMs: PRESIGNED_UPLOAD_TIMEOUT_MS,
    });
    if (!put.ok) throw new Error(`storage PUT failed (${put.status})`);

    return await api.request('/documents/upload/finalize', {
      method: 'POST',
      body: JSON.stringify({
        objectKey: presign.objectKey,
        assessmentId,
        type,
        fileName: file.name,
        contentType,
      }),
    });
  } catch (err) {
    // 4xx from our own API = the file or the request was refused on its merits. Surface it; a
    // second attempt down the multipart route would be refused identically.
    if (err instanceof AppError && err.status && err.status >= 400 && err.status < 500) throw err;

    const formData = new FormData();
    formData.append('file', file);
    return api.request(
      `/documents/upload?assessmentId=${encodeURIComponent(assessmentId)}&type=${encodeURIComponent(type)}`,
      { method: 'POST', body: formData },
    );
  }
}

export const Documents: React.FC = () => {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  const [overviewLoading, setOverviewLoading] = useState(false);
  // Grouped-by-branch is the default: it's what answers "where is this branch's
  // paperwork" without a branch's name appearing once per file. The flat view is
  // kept for auditing everything by pipeline stage regardless of which branch it
  // belongs to. There used to be four tabs (Control / Upload & Dispatch / Data
  // Entry Queue / All Documents) — the latter two were separate disconnected
  // screens for actions that now happen inline on the branch card that needs
  // them, and "All Documents" duplicated this same flat view with a plainer,
  // less informative table.
  // The daily run leads: the client's file arrives per audit date and drives that
  // day's work, so that is the view someone opens this page to act on. The
  // branch and file views remain for looking across dates.
  const [view, setView] = useState<'daily' | 'branch' | 'flat' | 'versions'>('daily');
  const [projectId, setProjectId] = useState<string>('');
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);

  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Both lists in this payload — branches and documents — are pages of the same filtered query,
  // and only one of the two views is on screen at a time. So there is one search, one stage and
  // one page number here, and whichever view is showing reads and writes them.
  const [branchPage, setBranchPage] = useState(1);
  const [branchSearch, setBranchSearch] = useState('');
  const [branchStage, setBranchStage] = useState('ALL');
  const [branchTotal, setBranchTotal] = useState(0);

  /**
   * The live branch window, readable from a callback that was bound once.
   *
   * `loadOverview` is handed to the socket listeners at mount and must keep a stable identity —
   * rebuilding it per keystroke would tear down and re-subscribe three socket handlers on every
   * character typed. So it reads the query through this ref rather than through its own closure,
   * the same way `Branches.tsx` reads its global scope.
   */
  const branchQueryRef = useRef({ page: 1, search: '', stage: 'ALL' });

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    try {
      const { page, search, stage } = branchQueryRef.current;
      const params = new URLSearchParams({ page: String(page), limit: String(BRANCH_PAGE_SIZE) });
      if (search.trim()) params.set('search', search.trim());
      if (stage !== 'ALL') params.set('stage', stage);
      // withMeta, because the branch array is a page and `meta.pagination.total` is the only
      // figure that says how big the set actually is.
      const res = await api.request<{ data: OverviewData; meta?: { pagination?: { total?: number } } }>(
        `/documents/operations/overview?${params.toString()}`,
        { withMeta: true },
      );
      setOverview(res.data);
      setBranchTotal(res.meta?.pagination?.total ?? res.data?.branches?.length ?? 0);
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  /**
   * Refetch when the branch window moves.
   *
   * Debounced on the same 200 ms as the global search box, because `search` changes on every
   * keystroke and each one is now a real request. The cleanup also collapses React's
   * double-invoked mount effect into a single load — this page was firing the overview twice.
   */
  useEffect(() => {
    branchQueryRef.current = { page: branchPage, search: branchSearch, stage: branchStage };
    const t = setTimeout(() => { loadOverview(); }, BRANCH_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [branchPage, branchSearch, branchStage, loadOverview]);

  // Any change to what is being searched invalidates the page number: staying on page 5 of a
  // filter that now matches three branches shows an empty list.
  const changeBranchSearch = useCallback((v: string) => { setBranchSearch(v); setBranchPage(1); }, []);
  const changeBranchStage = useCallback((v: string) => { setBranchStage(v); setBranchPage(1); }, []);

  useEffect(() => {
    // The daily run is scoped to one project's schedule for a date.
    api.request<Array<{ id: string; name: string }>>('/projects')
      .then((list) => {
        setProjects(list || []);
        if (list?.length) setProjectId((cur) => cur || list[0].id);
      })
      .catch((e) => setError(userMessage(e)));
  }, []);

  useEffect(() => {
    // No initial load here — the branch-window effect above owns that, and calling it from both
    // is what made this page fetch the overview twice on mount.
    connectSocket();
    const socket = getSocket();
    if (socket) {
      socket.on('document:uploaded', loadOverview);
      socket.on('document:status-changed', loadOverview);
      socket.on('document:received', loadOverview);
    }
    return () => {
      const s = getSocket();
      if (s) {
        s.off('document:uploaded', loadOverview);
        s.off('document:status-changed', loadOverview);
        s.off('document:received', loadOverview);
      }
    };
  }, [loadOverview]);

  /** Releases one or many documents, then refreshes the console. */
  const handleDispatchMany = async (ids: string[]) => {
    // "Updates the paperwork workflow" was true but told the user nothing they could act
    // on. Say what dispatch actually means to them: the files leave the desk.
    const ok = await confirm({
      title: ids.length === 1 ? 'Send this document out?' : `Send ${ids.length} documents out?`,
      message:
        ids.length === 1
          ? 'The document will be marked as sent and moves to the next stage of the paperwork.'
          : `${ids.length} documents will be marked as sent and move to the next stage of the paperwork.`,
      confirmLabel: ids.length === 1 ? 'Send document' : `Send ${ids.length} documents`,
      reversibleNote: 'You can still mark them received later.',
    });
    if (!ok) return;
    setBusyKey('batch-dispatch');
    setError(null);
    setSuccessMsg(null);
    try {
      const result = await api.request<any>('/documents/dispatch-batch', {
        method: 'POST',
        body: JSON.stringify({ documentIds: ids }),
      });
      setSuccessMsg(result?.message || 'Documents dispatched.');
      await loadOverview();
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusyKey(null);
    }
  };

  /** Uploads a missing file directly onto the branch that needs it — the action
   *  that used to require leaving this screen for a separate project/branch
   *  picker form, entirely disconnected from the branch you were looking at. */
  const handleUploadForBranch = async (projectBranchId: string, type: string, file: File) => {
    setError(null);
    setSuccessMsg(null);
    try {
      await uploadDocumentSmart(projectBranchId, type, file);
      setSuccessMsg(`"${file.name}" uploaded.`);
      await loadOverview();
    } catch (err) {
      setError(userMessage(err));
    }
  };

  const handleMarkReceived = async (docId: string) => {
    const ok = await confirm({
      title: 'Mark this document as received?',
      message: 'The document will be recorded as back with the desk, and the branch moves to the next stage.',
      confirmLabel: 'Mark as received',
      reversible: true,
    });
    if (!ok) return;
    setError(null);
    setSuccessMsg(null);
    try {
      const result = await api.request<any>(`/documents/${docId}/receive`, { method: 'POST' });
      setSuccessMsg(result?.message || 'Marked as received.');
      await loadOverview();
    } catch (err) {
      setError(userMessage(err));
    }
  };

  const handleSendToOcr = async (docId: string) => {
    // "External OCR application" is engineering vocabulary. To the person clicking, the
    // fact that matters is that the scanned pages are being sent away to be read into
    // text — so say that, and name the destination as the scanning software.
    const ok = await confirm({
      title: 'Send this document for scanning?',
      message:
        'The document goes to the separate scanning software, which reads the printed pages into text. It comes back here once that finishes.',
      confirmLabel: 'Send for scanning',
      reversible: true,
    });
    if (!ok) return;
    setError(null);
    setSuccessMsg(null);
    try {
      await api.request(`/documents/${docId}/send-external-ocr`, { method: 'POST' });
      setSuccessMsg('Sent to the scanning software.');
      await loadOverview();
    } catch (err) {
      setError(userMessage(err));
    }
  };

  const handleUploadExcel = async (assessmentId: string, file: File) => {
    setError(null);
    setSuccessMsg(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      await api.request(`/documents/upload-excel?assessmentId=${assessmentId}`, { method: 'POST', body: formData });
      setSuccessMsg('Excel report uploaded.');
      await loadOverview();
    } catch (err) {
      setError(userMessage(err));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {confirmDialog}
      {/* Header */}
      <div style={{ background: 'linear-gradient(90deg, var(--status-pending-bg) 0%, var(--status-completed-bg) 100%)', border: '1px solid var(--status-pending-bg)', padding: '14px 20px', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
          <span style={{ backgroundColor: 'var(--accent)', color: 'var(--on-accent)', fontSize: '11px', fontWeight: 800, padding: '4px 8px', borderRadius: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Document Management
          </span>
          <div>
            <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
              Branch Paperwork Tracking
            </h3>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Every branch's files in one place — upload, dispatch, receive and process without switching screens
            </span>
          </div>
        </div>
        <button onClick={loadOverview} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {error && <AlertBanner type="error" message={error} onClose={() => setError(null)} />}
      {successMsg && <AlertBanner type="success" message={successMsg} onClose={() => setSuccessMsg(null)} />}

      {overviewLoading && !overview ? (
        <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>Loading document control…</div>
      ) : overview ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <DocumentModelLegend />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={() => setView('daily')} className={view === 'daily' ? 'btn btn-primary' : 'btn btn-secondary'} style={{ fontSize: 12, padding: '6px 12px' }}>
              Daily Run
            </button>
            <button onClick={() => setView('branch')} className={view === 'branch' ? 'btn btn-primary' : 'btn btn-secondary'} style={{ fontSize: 12, padding: '6px 12px' }}>
              By Branch
            </button>
            <button onClick={() => setView('flat')} className={view === 'flat' ? 'btn btn-primary' : 'btn btn-secondary'} style={{ fontSize: 12, padding: '6px 12px' }}>
              All Files
            </button>
            <button onClick={() => setView('versions')} className={view === 'versions' ? 'btn btn-primary' : 'btn btn-secondary'} style={{ fontSize: 12, padding: '6px 12px' }}>
              Customer Master
            </button>
            {view === 'daily' && projects.length > 1 && (
              <Select
                compact
                value={projectId}
                onChange={setProjectId}
                options={projects.map((p) => ({ value: p.id, label: p.name }))}
                style={{ marginLeft: 4 }}
              />
            )}
          </div>
          {view === 'versions' ? (
            <CustomerMasterVersions />
          ) : view === 'daily' ? (
            <DailyRunPanel
              projectId={projectId}
              onDispatch={handleDispatchMany}
              onSendToOcr={handleSendToOcr}
              onDownload={(id) => { openDocumentDownload(id).catch((e) => setError(userMessage(e))); }}
              onError={setError}
              onSuccess={setSuccessMsg}
            />
          ) : view === 'branch' ? (
            <BranchDocumentPanel
              branches={overview.branches || []}
              neverPrepared={overview.neverPrepared || []}
              total={branchTotal}
              neverPreparedTotal={overview.totals?.neverPrepared ?? 0}
              page={branchPage}
              pageSize={BRANCH_PAGE_SIZE}
              onPageChange={setBranchPage}
              search={branchSearch}
              onSearchChange={changeBranchSearch}
              stage={branchStage}
              onStageChange={changeBranchStage}
              loading={overviewLoading}
              pipeline={overview.pipeline || []}
              busy={busyKey === 'batch-dispatch'}
              onDispatch={handleDispatchMany}
              onDownload={(id) => { openDocumentDownload(id).catch((e) => setError(userMessage(e))); }}
              onUpload={handleUploadForBranch}
              onMarkReceived={handleMarkReceived}
              onSendToOcr={handleSendToOcr}
              onUploadExcel={handleUploadExcel}
            />
          ) : (
            <DocumentControlPanel
              data={overview}
              busy={busyKey === 'batch-dispatch'}
              onDispatch={handleDispatchMany}
              onDownload={(id) => { openDocumentDownload(id).catch((e) => setError(userMessage(e))); }}
              search={branchSearch}
              onSearchChange={changeBranchSearch}
              stage={branchStage}
              onStageChange={changeBranchStage}
              onPageChange={setBranchPage}
            />
          )}
        </div>
      ) : null}
    </div>
  );
};
