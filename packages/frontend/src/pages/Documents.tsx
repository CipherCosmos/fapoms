import React, { useState, useEffect, useCallback } from 'react';
import { DocumentControlPanel } from './documents/DocumentControlPanel';
import type { OverviewData } from './documents/DocumentControlPanel';
import { BranchDocumentPanel } from './documents/BranchDocumentPanel';
import { DocumentModelLegend } from './documents/DocumentModelLegend';
import { DailyRunPanel } from './documents/DailyRunPanel';
import { CustomerMasterVersions } from './CustomerMasterVersions';
import { RefreshCw } from 'lucide-react';
import { AlertBanner } from '../components/ui';
import { connectSocket, getSocket } from '../services/socket';
import { fetchWithTimeout } from '../services/http';

/**
 * The presigned PUT's own budget, longer than the API default because the file, not the network,
 * sets the pace: scanned audit paperwork runs to several megabytes and branch offices upload over
 * ADSL. Ten minutes covers the worst real case we have seen with room to spare, while still
 * guaranteeing the upload ends — which is the whole point, since the multipart fallback below
 * cannot run until this one gives up.
 */
const PRESIGNED_UPLOAD_TIMEOUT_MS = 600_000;

/**
 * These four wrappers predate the shared API client and duplicate it — badly. They are kept for
 * now because replacing them is a behaviour change (the client refreshes on 401; these do not, so
 * a session that expires mid-session here surfaces as a bare "Request failed" instead of a silent
 * re-auth), and that deserves its own change rather than riding along with a timeout fix.
 *
 * What they must not keep doing is hang. Every one of them was a bare `fetch` with no budget, so
 * a stalled connection left the document list spinning with no error and no end — the exact defect
 * this page's own `PRESIGNED_UPLOAD_TIMEOUT_MS` exists to prevent one call below. They now go
 * through `fetchWithTimeout` and inherit the default budget, which closes the hang without
 * pretending the duplication has been dealt with.
 */
async function apiGet<T>(endpoint: string): Promise<T> {
  const token = localStorage.getItem('fapoms_token');
  const res = await fetchWithTimeout(`/api/v1${endpoint}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Request failed: ${endpoint}`);
  }
  const json = await res.json();
  return json.data as T;
}

/**
 * Opens a document download.
 *
 * The download endpoint is no longer public — it previously served bank customer paperwork to
 * anyone who could reach the API. It now requires a short-lived token bound to that one
 * document, so a bare `<a href>` (which cannot send our Authorization header) would just 401.
 * Exchange the session for a scoped token first, then open the signed URL.
 */
async function openDocumentDownload(documentId: string): Promise<void> {
  const { downloadUrl } = await apiGet<{ downloadUrl: string }>(`/documents/${documentId}/download-token`);
  window.open(`/api/v1${downloadUrl}`, '_blank', 'noopener,noreferrer');
}

async function apiPost(endpoint: string, body?: any): Promise<any> {
  const token = localStorage.getItem('fapoms_token');
  const res = await fetchWithTimeout(`/api/v1${endpoint}`, {
    method: 'POST',
    headers: {
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Request failed: ${endpoint}`);
  }
  const json = await res.json();
  return json.data;
}

async function apiUpload(endpoint: string, formData: FormData): Promise<any> {
  const token = localStorage.getItem('fapoms_token');
  const res = await fetchWithTimeout(`/api/v1${endpoint}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Upload failed: ${endpoint}`);
  }
  const json = await res.json();
  return json.data;
}

/**
 * Like apiUpload but returns the whole response envelope, not just `data`.
 * The batch-packet upload reports per-file outcomes (what was filed, what could
 * not be matched) alongside a summary message, and the caller needs both.
 */
async function apiUploadRaw(endpoint: string, formData: FormData): Promise<any> {
  const token = localStorage.getItem('fapoms_token');
  const res = await fetchWithTimeout(`/api/v1${endpoint}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `Upload failed: ${endpoint}`);
  return json;
}

/**
 * Upload one document, preferring the presigned direct-to-storage path (POST
 * /documents/upload/presign → client PUT straight to object storage → POST
 * /documents/upload/finalize) so the file bytes never buffer through the API process.
 *
 * Falls back to the original multipart `/documents/upload` on ANY failure of the presigned path
 * — the local-disk storage driver (no presign), a storage endpoint the browser cannot reach, or
 * a bucket without CORS. The fallback guarantees this can never upload *less* reliably than
 * before; it only upgrades the transport when direct-to-storage is actually available.
 */
async function uploadDocumentSmart(assessmentId: string, type: string, file: File): Promise<any> {
  const contentType = file.type || 'application/octet-stream';
  try {
    const presign = await apiPost('/documents/upload/presign', { fileName: file.name, contentType });
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

    return await apiPost('/documents/upload/finalize', {
      objectKey: presign.objectKey,
      assessmentId,
      type,
      fileName: file.name,
      contentType,
    });
  } catch {
    const formData = new FormData();
    formData.append('file', file);
    return apiUpload(
      `/documents/upload?assessmentId=${encodeURIComponent(assessmentId)}&type=${encodeURIComponent(type)}`,
      formData,
    );
  }
}

export const Documents: React.FC = () => {
  const [overview, setOverview] = useState<OverviewData | null>(null);
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

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    try {
      setOverview(await apiGet<OverviewData>('/documents/operations/overview'));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  useEffect(() => {
    // The daily run is scoped to one project's schedule for a date.
    apiGet<Array<{ id: string; name: string }>>('/projects')
      .then((list) => {
        setProjects(list || []);
        if (list?.length) setProjectId((cur) => cur || list[0].id);
      })
      .catch((e: any) => setError(e.message));
  }, []);

  useEffect(() => {
    loadOverview();
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
    if (!window.confirm(`Dispatch ${ids.length} document(s)? This updates the paperwork workflow.`)) return;
    setBusyKey('batch-dispatch');
    setError(null);
    setSuccessMsg(null);
    try {
      const result = await apiPost('/documents/dispatch-batch', { documentIds: ids });
      setSuccessMsg(result?.message || 'Documents dispatched.');
      await loadOverview();
    } catch (err: any) {
      setError(err.message);
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
    } catch (err: any) {
      setError(err.message || 'Upload failed.');
    }
  };

  const handleMarkReceived = async (docId: string) => {
    if (!window.confirm('Mark this document as received?')) return;
    setError(null);
    setSuccessMsg(null);
    try {
      const result = await apiPost(`/documents/${docId}/receive`);
      setSuccessMsg(result?.message || 'Marked as received.');
      await loadOverview();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSendToOcr = async (docId: string) => {
    if (!window.confirm('Send this document to the external OCR application?')) return;
    setError(null);
    setSuccessMsg(null);
    try {
      await apiPost(`/documents/${docId}/send-external-ocr`);
      setSuccessMsg('Marked as sent to the external OCR application.');
      await loadOverview();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleUploadExcel = async (assessmentId: string, file: File) => {
    setError(null);
    setSuccessMsg(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      await apiUpload(`/documents/upload-excel?assessmentId=${assessmentId}`, formData);
      setSuccessMsg('Excel report uploaded.');
      await loadOverview();
    } catch (err: any) {
      setError(err.message || 'Upload failed.');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
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
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}
                style={{ padding: '6px 10px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 12, marginLeft: 4 }}>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
          </div>
          {view === 'versions' ? (
            <CustomerMasterVersions embedded />
          ) : view === 'daily' ? (
            <DailyRunPanel
              projectId={projectId}
              apiGet={apiGet}
              apiUpload={apiUpload}
              apiUploadRaw={apiUploadRaw}
              onDispatch={handleDispatchMany}
              onSendToOcr={handleSendToOcr}
              onDownload={(id) => { openDocumentDownload(id).catch(e => setError(e.message)); }}
              onError={setError}
              onSuccess={setSuccessMsg}
            />
          ) : view === 'branch' ? (
            <BranchDocumentPanel
              branches={overview.branches || []}
              neverPrepared={overview.neverPrepared || []}
              pipeline={overview.pipeline || []}
              busy={busyKey === 'batch-dispatch'}
              onDispatch={handleDispatchMany}
              onDownload={(id) => { openDocumentDownload(id).catch(e => setError(e.message)); }}
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
              onDownload={(id) => { openDocumentDownload(id).catch(e => setError(e.message)); }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
};
