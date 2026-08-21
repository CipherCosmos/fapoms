import { api } from './api';
import type { FeedbackCategory, FeedbackSeverity, FeedbackStatus } from '@fapoms/shared';

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
export const MAX_FEEDBACK_FILES = 5;

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
 * Send files to the server and get back the descriptors a report or reply carries.
 *
 * Multipart, so `api.request` must not set a JSON content type — the browser supplies the
 * multipart boundary itself and overriding it makes the body unparseable.
 */
export const uploadFeedbackAttachments = async (files: File[]): Promise<FeedbackAttachment[]> => {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  return api.request<FeedbackAttachment[]>('/feedback/attachments', { method: 'POST', body: form });
};

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
