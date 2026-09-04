import { api } from './api';

/**
 * A sign-in session as the sessions/devices screen sees it — no secrets, just where and what.
 * Mirrors the backend `SessionView` (session.service.ts).
 */
export interface SessionView {
  id: string;
  ipAddress: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  loginMethod: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  active: boolean;
  current: boolean;
}

/** The caller's own sessions (self-service devices screen). */
export function getMySessions(): Promise<SessionView[]> {
  return api.request<SessionView[]>('/sessions/me');
}

/** Any user's sessions — administrators only (login history / incident response). */
export function getUserSessions(userId: string): Promise<SessionView[]> {
  return api.request<SessionView[]>(`/sessions?userId=${encodeURIComponent(userId)}`);
}

/** Revoke one session — sign that device out. */
export function revokeSession(sessionId: string): Promise<unknown> {
  return api.request(`/sessions/${sessionId}`, { method: 'DELETE' });
}
