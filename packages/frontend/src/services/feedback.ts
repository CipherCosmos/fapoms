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
  attachments: { url: string; fileName: string; fileType: string }[] | null;
  isInternal: boolean;
  isRead: boolean;
  createdAt: string;
}

export interface CreateFeedbackInput {
  title?: string;
  body: string;
  category?: FeedbackCategory;
  area?: string;
  appContext?: Record<string, unknown>;
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

export const postMessage = (id: string, body: string, isInternal = false) =>
  api.request<FeedbackMessage>(`/feedback/${id}/messages`, { method: 'POST', body: JSON.stringify({ body, isInternal }) });

export const markThreadRead = (id: string) =>
  api.request<{ updated: number }>(`/feedback/${id}/messages/read`, { method: 'POST' });

export const voteFeedback = (id: string) =>
  api.request<{ voted: boolean; voteCount: number }>(`/feedback/${id}/vote`, { method: 'POST' });
