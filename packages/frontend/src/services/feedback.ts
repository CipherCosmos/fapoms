import { api } from './api';
import type { FeedbackCategory, FeedbackSeverity, FeedbackStatus } from '@fapoms/shared';
import { MAX_FEEDBACK_ATTACHMENTS } from '@fapoms/shared';

/**
 * Typed API layer for the feedback & collaboration channel.
 *
 * Reporter functions (`createFeedback`, `getMyFeedback`) work for any signed-in
 * user; team functions (`getQueue`, `getStats`, `getDigest`, `triage`, …) require a
 * super-administrator token (FEEDBACK_TEAM_ROLES) and 403 otherwise. Mirrors `services/planning.ts`:
 * plain functions over `api.request`, response shapes owned here.
 */

export interface FeedbackThread {
  id: string;
  reporterUserId: string | null;
  reporterAssayerId: string | null;
  reporterName: string;
  reporterRole: string | null;
  title: string;
  category: FeedbackCategory;
  severity: FeedbackSeverity;
  status: FeedbackStatus;
  assignedToUserId: string | null;
  area: string | null;
  appContext: Record<string, unknown> | null;
  lastMessageAt: string | null;
  firstRespondedAt: string | null;
  voteCount: number;
  hasVoted?: boolean;
  aiMeta: {
    suggestedCategory?: FeedbackCategory;
    suggestedSeverity?: FeedbackSeverity;
    confidence?: number;
    keywords?: string[];
    duplicateCandidateIds?: string[];
  } | null;
  duplicateOfId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  duplicateCandidates?: FeedbackThread[];
}

export interface FeedbackMessage {
  id: string;
  feedbackThreadId: string;
  authorType: 'REPORTER' | 'TEAM' | 'SYSTEM';
  authorName: string | null;
  body: string | null;
  attachments: FeedbackAttachment[] | null;
  isInternal: boolean;
  isRead: boolean;
  createdAt: string;
}

/**
 * A file attached to a report.
 *
 * `url` is issued by the upload route and posted back verbatim — the server refuses any other
 * shape, so a report cannot carry a link to somewhere the server did not put a file. Fetching
 * it needs the session: the download is scoped to whoever may read the report it hangs off.
 */
/** The server refuses a sixth; the picker says so before anything is uploaded. */
export const MAX_FEEDBACK_FILES = MAX_FEEDBACK_ATTACHMENTS;

/**
 * What the file picker offers.
 *
 * Narrower than the server's allowlist on purpose — a picker that offers everything and then
 * rejects most of it wastes the choice. The server still decides.
 */
export const FEEDBACK_ACCEPT = 'image/*,application/pdf,.csv,.xlsx';

/** Bytes as something a person reads. */
export const formatFileSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export interface FeedbackAttachment {
  url: string;
  fileName: string;
  fileType: string;
  storageKey?: string;
  size?: number;
}

export interface CreateFeedbackInput {
  title?: string;
  body: string;
  category?: FeedbackCategory;
  area?: string;
  appContext?: Record<string, unknown>;
  attachments?: FeedbackAttachment[];
}

export interface FeedbackStats {
  total: number;
  open: number;
  untriaged: number;
  unassigned: number;
  criticalOpen: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
}

export interface FeedbackDigest {
  openCount: number;
  topThemes: { term: string; weight: number; count: number; threadIds: string[] }[];
  aging: { id: string; title: string; category: FeedbackCategory; severity: FeedbackSeverity; status: FeedbackStatus; ageDays: number; reporterName: string }[];
  criticalOpen: { id: string; title: string; status: FeedbackStatus; reporterName: string }[];
}

export interface TeamQueueParams {
  page?: number;
  limit?: number;
  status?: FeedbackStatus | '';
  category?: FeedbackCategory | '';
  severity?: FeedbackSeverity | '';
  assignedToUserId?: string; // 'me' | 'none' | uuid
  search?: string;
  sort?: 'recent' | 'impact';
}

export interface FeedbackAttentionItem {
  id: string;
  title: string;
  severity: FeedbackSeverity;
  category: FeedbackCategory;
  ageHours: number;
  reporterName: string;
  assignedToUserId: string | null;
}

export interface FeedbackAttention {
  firstResponseOverdue: FeedbackAttentionItem[];
  resolutionOverdue: FeedbackAttentionItem[];
}

export interface TriageInput {
  category?: FeedbackCategory;
  severity?: FeedbackSeverity;
  status?: FeedbackStatus;
  assignedToUserId?: string | null;
  duplicateOfId?: string | null;
  note?: string;
}

// ── Reporter ────────────────────────────────────────────────────────────────
export const createFeedback = (input: CreateFeedbackInput) =>
  api.request<FeedbackThread>('/feedback', { method: 'POST', body: JSON.stringify(input) });

export const getMyFeedback = () => api.request<FeedbackThread[]>('/feedback/mine');

export interface SimilarFeedback {
  id: string;
  title: string;
  category: FeedbackCategory;
  severity: FeedbackSeverity;
  status: FeedbackStatus;
  voteCount: number;
  hasVoted: boolean;
}

/** Open items similar to draft text — offer a vote instead of a duplicate. */
export const getSimilarFeedback = (text: string) =>
  api.request<SimilarFeedback[]>(`/feedback/similar?text=${encodeURIComponent(text)}`);

// ── Team ──────────────────────────────────────────────────────────────────────
export const getQueue = (params: TeamQueueParams = {}) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  // withMeta returns the { data, meta } envelope at runtime; the client's generic types the
  // data payload, so bridge through unknown to name the wrapper the caller actually receives.
  return api.request<FeedbackThread[]>(`/feedback?${qs.toString()}`, { withMeta: true }) as unknown as Promise<{
    data: FeedbackThread[];
    meta: { pagination: { page: number; limit: number; total: number } };
  }>;
};

export const getStats = () => api.request<FeedbackStats>('/feedback/stats');
export const getDigest = () => api.request<FeedbackDigest>('/feedback/digest');
export const getAssignees = () => api.request<{ id: string; name: string }[]>('/feedback/assignees');
export const getAttention = () => api.request<FeedbackAttention>('/feedback/attention');

export const triageFeedback = (id: string, input: TriageInput) =>
  api.request<FeedbackThread>(`/feedback/${id}/triage`, { method: 'POST', body: JSON.stringify(input) });

export const resolveFeedback = (id: string, note?: string) =>
  api.request<FeedbackThread>(`/feedback/${id}/resolve`, { method: 'POST', body: JSON.stringify({ note }) });

export const reopenFeedback = (id: string) =>
  api.request<FeedbackThread>(`/feedback/${id}/reopen`, { method: 'POST' });

// ── Shared (reporter own / team) ────────────────────────────────────────────
export const getThread = (id: string) => api.request<FeedbackThread>(`/feedback/${id}`);
export const getMessages = (id: string) => api.request<FeedbackMessage[]>(`/feedback/${id}/messages`);

export const postMessage = (id: string, body: string, isInternal = false, attachments?: FeedbackAttachment[]) =>
  api.request<FeedbackMessage>(`/feedback/${id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body, isInternal, attachments }),
  });

/**
 * Send one file to the server and get back the descriptor a report carries.
 *
 * XHR rather than `fetch`, for one reason: `fetch` cannot report upload progress. Without it
 * the composer could only show a spinner, and on the connections this runs over — a phone on a
 * branch link, an office pushing a screenshot through a tunnel — a multi-megabyte upload is a
 * minute of a frozen-looking dialog with nothing to say how far along it is or any way to stop.
 * That is exactly what people described as the app hanging.
 *
 * One file per call so a failure is attributable and the others still land, and so progress is
 * per-file rather than one bar for the batch.
 */
export const uploadFeedbackAttachment = (
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<FeedbackAttachment> =>
  new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('files', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/v1/feedback/attachments');
    const token = localStorage.getItem('fapoms_token');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    // No Content-Type: the browser sets it with the multipart boundary, and overriding it
    // makes the body unparseable on the server.

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let payload: any = {};
      try { payload = JSON.parse(xhr.responseText || '{}'); } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300 && payload?.data?.[0]) {
        resolve(payload.data[0] as FeedbackAttachment);
        return;
      }
      // The server's message names the limit and the allowed types — far more use than a code.
      const message = Array.isArray(payload?.message) ? payload.message[0] : payload?.message;
      reject(new Error(message || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('The upload could not reach the server.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });

    xhr.send(form);
  });

/**
 * Fetch an attachment and hand it to the browser as a download.
 *
 * Not a plain `<a href>`: the route needs the Authorization header, so the bytes come through
 * `api.request` and are handed over as a blob. The server sends every attachment as
 * `application/octet-stream` with `nosniff`, so nothing a reporter uploads can execute in the
 * app's own origin.
 */
export const downloadFeedbackAttachment = async (attachment: FeedbackAttachment): Promise<void> => {
  const blob = await api.request<Blob>(attachment.url.replace(/^\/api\/v1/, ''), { raw: true });
  const href = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = href;
    a.download = attachment.fileName || 'attachment';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoked on the next tick — Safari has not started reading the blob when click() returns.
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }
};

export const markThreadRead = (id: string) =>
  api.request<{ updated: number }>(`/feedback/${id}/messages/read`, { method: 'POST' });

export const voteFeedback = (id: string) =>
  api.request<{ voted: boolean; voteCount: number }>(`/feedback/${id}/vote`, { method: 'POST' });
