import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import Constants from 'expo-constants';
import { AssignmentStatus, calculateHaversineDistance } from '@fapoms/shared';
import { readToken, writeToken, deleteToken, ALL_TOKEN_KEYS } from './token-store';
import { AssayerAssignment, AppNotification, AssayerExpense, ExpenseSummary, AssayerStatement, QueryMessage } from '../types/mobile-app';
import {
  getDefaultServerUrl,
  loadStoredServerUrl,
  saveServerUrl,
  clearServerUrl,
  normaliseServerUrl,
} from './server-config';

/** One row of the per-category notification preference set returned by the API. */
export interface NotificationPreference {
  category: string;
  inApp: boolean;
  push: boolean;
  email: boolean;
}


/**
 * Mutable, because the server address is now a device setting rather than a build-time
 * constant. Every call site below reads it inside a function body, so they all pick up a
 * change immediately. See services/server-config.ts for why this had to become configurable:
 * the old fallback (`10.0.2.2`) is an emulator-only alias that does not resolve on a real
 * phone, and the port was hardcoded in three places.
 */
let API_BASE_URL = getDefaultServerUrl();

/**
 * Apply any address the operator saved on this device. Call once during startup, before the
 * first request — until it resolves, the build-time default is used.
 */
export async function initApiBaseUrl(): Promise<string> {
  const stored = await loadStoredServerUrl();
  if (stored) API_BASE_URL = stored;
  return API_BASE_URL;
}

/** Point this install at a different backend, persisting the choice. */
export async function setApiBaseUrl(rawUrl: string): Promise<string> {
  const normalised = normaliseServerUrl(rawUrl);
  await saveServerUrl(normalised);
  API_BASE_URL = normalised;
  return normalised;
}

/** Forget the override and fall back to the built-in default. */
export async function resetApiBaseUrl(): Promise<string> {
  await clearServerUrl();
  API_BASE_URL = getDefaultServerUrl();
  return API_BASE_URL;
}

export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

/**
 * Assignment statuses are the shared enum's values verbatim on both sides of the wire.
 *
 * Two identity maps used to sit here — BACKEND_TO_MOBILE_STATUS and MOBILE_TO_BACKEND_STATUS
 * — mapping PENDING to PENDING and so on. They translated nothing, but the lookup fell back
 * to `|| 'PENDING'`, so any status not in the hand-maintained list was silently relabelled as
 * "Awaiting Response". CANCELLED was in one map and absent from the other, which is exactly
 * how a cancelled assignment came back to the app looking like new work.
 */
const isAssignmentStatus = (v: unknown): v is AssignmentStatus =>
  typeof v === 'string' && (Object.values(AssignmentStatus) as string[]).includes(v);

export class MobileApiService {
  static authToken: string | null = null;
  static refreshToken: string | null = null;
  /**
   * Refresh tokens are single-use and rotated on each call (the server issues a
   * new one and invalidates the old). If two requests expire around the same
   * moment, each independently calling `tryRefresh()` means the first consumes
   * and rotates the token while the second — already holding the now-stale
   * value — fails and gets treated as a dead session. Sharing one in-flight
   * refresh promise across all callers is what makes concurrent expiry safe.
   */
  private static refreshInFlight: Promise<boolean> | null = null;
  static currentUserId: string | null = null;
  static currentUserName: string | null = null;
  /** Set from the profile read during `validateSession`, so a restored session knows it too. */
  static mustChangePassword = false;

  /** Returns the API origin URL (e.g., http://localhost:3000) for resolving relative attachment URLs */
  static getApiOrigin(): string {
    // API_BASE_URL is like http://localhost:3000/api/v1 — strip /api/v1 suffix
    return API_BASE_URL.replace(/\/api\/v1$/, '');
  }

  /*
   * There is deliberately no `resolveAttachmentUrl` here any more.
   *
   * It built attachment links by appending `?token=<access JWT>` to the URL. That puts a bearer
   * credential where credentials must never go — into request logs, proxy logs, the OS share
   * sheet, the image cache, and anywhere the link is copied — and it had already stopped working
   * (the server rejects a plain JWT in the query string; see `getAttachmentUrl`). It had no
   * callers left. Removed rather than kept "just in case", because the case it would be reached
   * for is exactly the one it must not be used for. Attachments are opened through
   * `getAttachmentUrl`, which asks the server for a short-lived signed path.
   */

  static setAuthToken(token: string, userId?: string, userName?: string) {
    this.authToken = token;
    if (userId) this.currentUserId = userId;
    if (userName) this.currentUserName = userName;

    // Fire-and-forget: the in-memory values above are what the current session uses, and the
    // persisted copy only matters on the next launch.
    void writeToken('fapoms_assayer_token', token);
    if (userId) void writeToken('fapoms_assayer_userId', userId);
    if (userName) void writeToken('fapoms_assayer_userName', userName);
  }

  /**
   * Async because the OS keystore is async. The caller must await it before deciding whether
   * to show the login screen — the previous sync version could only ever read `localStorage`,
   * so on device it always returned null and the app always showed login.
   */
  static async restoreSession(): Promise<{ token: string; userId?: string; userName?: string } | null> {
    const [token, refreshToken, userId, userName] = await Promise.all([
      readToken('fapoms_assayer_token'),
      readToken('fapoms_assayer_refresh_token'),
      readToken('fapoms_assayer_userId'),
      readToken('fapoms_assayer_userName'),
    ]);
    if (!token) return null;

    this.authToken = token;
    if (refreshToken) this.refreshToken = refreshToken;
    this.currentUserId = userId || null;
    this.currentUserName = userName || null;
    return { token, userId: userId || undefined, userName: userName || undefined };
  }

  static clearSession() {
    this.authToken = null;
    this.refreshToken = null;
    this.currentUserId = null;
    this.currentUserName = null;
    this.mustChangePassword = false;
    ALL_TOKEN_KEYS.forEach((k) => void deleteToken(k));
  }

  /**
   * Whether the stored session is still good.
   *
   * Three outcomes, not two. This used to return a bare boolean and treat *every* failure —
   * including a timeout or a dropped connection — as "your session is invalid", then call
   * `clearSession()` and destroy the tokens. An Android permission dialog pauses the app, so
   * the in-flight request times out, and the assayer was signed out simply for being asked
   * whether the app could use their location. The same happened on any brief signal loss at a
   * branch, which is where this app spends its life.
   *
   * Only an actual rejection from the server ends a session. Not being able to ask is not an
   * answer.
   */
  static async validateSession(): Promise<'valid' | 'invalid' | 'unreachable'> {
    const id = this.currentUserId;
    if (!id || !this.authToken) return 'invalid';
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/assayers/${id}/profile`, {}, 5000);
      if (response.ok) {
        /**
         * The profile is read anyway to decide whether the session is still good, so the answer
         * to "does this person still owe us a password change" comes free with it. Keeping it
         * lets a restored session be gated the same way a fresh sign-in is; the flag used to be
         * known only at login, so restarting the app walked straight past the requirement.
         */
        try {
          const body = await response.clone().json();
          const profile = body?.data ?? body;
          this.mustChangePassword = !!profile?.mustChangePassword;
        } catch {
          // A profile we cannot parse must not lock anyone out — leave the flag as it was.
        }
        return 'valid';
      }

      // fetchWithAuth already tried a token refresh before surfacing a 401/403, so an auth
      // failure here means the credentials are genuinely finished.
      if (response.status === 401 || response.status === 403) {
        this.clearSession();
        return 'invalid';
      }

      // A 5xx or anything else is the server having a bad moment, not the user being logged out.
      return 'unreachable';
    } catch {
      return 'unreachable';
    }
  }

  static getAuthToken(): string | null {
    return this.authToken;
  }

  static getCurrentUserId(): string | null {
    return this.currentUserId;
  }

  static getCurrentUserName(): string | null {
    return this.currentUserName;
  }

  static getBaseUrl(): string {
    return API_BASE_URL;
  }

  private static getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }
    return headers;
  }

  private static storeRefreshToken(token: string): void {
    this.refreshToken = token;
    void writeToken('fapoms_assayer_refresh_token', token);
  }

  /**
   * In-memory first, keystore second. Async so a cold start that has not yet run
   * `restoreSession` can still find the token biometric sign-in depends on.
   */
  private static async getRefreshToken(): Promise<string | null> {
    if (this.refreshToken) return this.refreshToken;
    const stored = await readToken('fapoms_assayer_refresh_token');
    if (stored) this.refreshToken = stored;
    return stored;
  }

  static async tryRefresh(): Promise<boolean> {
    // Join an already-running refresh instead of starting a second one that
    // would race the first for the same single-use token.
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh().finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  private static async doRefresh(): Promise<boolean> {
    // Awaited: `getRefreshToken` became async when tokens moved to the OS keystore. Without
    // this the call returned a Promise — truthy, so the guard below passed — and it was
    // serialised into the request body as `{}`. Every refresh failed, so a session died the
    // moment the 15-minute access token expired, and biometric sign-in never worked at all.
    const refreshToken = await this.getRefreshToken();
    if (!refreshToken) return false;
    try {
      const response = await this.fetchWithTimeout(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }, 20_000);
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success && data.data?.accessToken) {
        this.authToken = data.data.accessToken;
        // The rotated access token has to reach the keystore too, or a cold start after a
        // refresh would restore the stale one and immediately 401.
        void writeToken('fapoms_assayer_token', data.data.accessToken);
        if (data.data.refreshToken) {
          this.storeRefreshToken(data.data.refreshToken);
        }
        return true;
      }
      /**
       * Only a *rejected credential* ends the session.
       *
       * This used to clear the session on every non-2xx, which put a momentarily overloaded
       * server in the same bucket as a revoked token: a 502 from a restarting API, or a 503
       * while it was under load, signed the assayer out mid-job and sent them back to the login
       * screen — on a handset that may be in a vault with no signal to sign back in with. The
       * token was still perfectly valid; only the server was briefly unwell.
       *
       * 401/403 is the server saying "this refresh token is no good" — expired, revoked, or
       * already rotated away by a concurrent call that lost the race. That is genuinely over,
       * and holding the tokens would only keep failing.
       *
       * Anything else (5xx, 429, a proxy's HTML error page) is treated exactly like the network
       * failure in the `catch` below: return false, keep the tokens, let the next attempt try
       * again. Worst case the user sees one failed request instead of losing their session.
       */
      if (response.status === 401 || response.status === 403) {
        this.clearSession();
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * How long a single request may take, INCLUDING the body — React Native's fetch resolves only
   * after the whole response has arrived, so this bounds RTT + server time + transfer.
   *
   * It was 3 000 ms. On a 2G-class link (~40–60 kbps) the gzipped assignments list alone needs
   * 4–5 s, so every read timed out, on every attempt, and the readers below turned the abort
   * into "no data" — Earnings showed ₹0 and the badge showed 0, for a network problem. Fifteen
   * seconds is enough for the largest routine payload on a poor link and still short enough
   * that a dead server is noticed within a screen's patience. Callers with a real reason to
   * differ (health probe, uploads) pass their own.
   */
  static readonly DEFAULT_TIMEOUT_MS = 15_000;

  /**
   * True for the failures that mean "the server was never reached / never answered": the fetch
   * polyfill's TypeError (DNS, TCP, TLS, connection reset) and our own AbortError (timeout).
   * An HTTP status is not one of these — the server answered, however unhappily.
   */
  /**
   * Turn "the server did not answer" and "the server answered with an error" into an exception
   * a caller can catch and KEEP ITS PREVIOUS STATE on, instead of a value it might mistake for
   * data. The readers below used to return `[]` / zeros / `null` in both cases, so a 3-second
   * abort on a slow link emptied the Earnings screen and zeroed the notification badge — a
   * network problem presented as a fact about the assayer's money.
   */
  static unavailable(what: string, cause?: unknown): Error {
    const err = new Error(`${what} could not be loaded — no answer from the server.`);
    err.name = 'ServerUnavailableError';
    (err as { cause?: unknown }).cause = cause;
    return err;
  }

  static isTransportError(err: unknown): boolean {
    const name = (err as { name?: string } | null)?.name;
    return name === 'AbortError' || name === 'TypeError' || err instanceof TypeError;
  }

  static async fetchWithTimeout(
    url: string,
    options: RequestInit = {},
    timeoutMs = MobileApiService.DEFAULT_TIMEOUT_MS,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  /**
   * Authenticated request with a bounded budget, a 401→refresh→retry, and — for reads only —
   * a couple of quick retries on transport failure.
   *
   * GET is idempotent, so a request that never reached the server (or whose response never
   * came back) can be safely re-issued; a brief radio drop or a tunnel handoff often recovers
   * within a second. Mutations are NOT retried here: a POST that the server processed but whose
   * response was lost would be applied twice.
   */
  static async fetchWithAuth(
    url: string,
    options?: RequestInit,
    timeoutMs = MobileApiService.DEFAULT_TIMEOUT_MS,
  ): Promise<Response> {
    const method = (options?.method ?? 'GET').toUpperCase();
    const retriesLeft = method === 'GET' || method === 'HEAD' ? 2 : 0;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await this.fetchWithAuthOnce(url, options, timeoutMs);
      } catch (err) {
        if (attempt >= retriesLeft || !this.isTransportError(err)) throw err;
        attempt += 1;
        // Short, jittered: long enough for a dropped connection to come back, short enough
        // that a screen does not stall behind three full timeouts for one read.
        await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));
      }
    }
  }

  private static async fetchWithAuthOnce(url: string, options?: RequestInit, timeoutMs?: number): Promise<Response> {
    const cacheBust = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`;
    // A FormData body needs the browser to set the multipart boundary itself; forcing
    // application/json here (the default for JSON calls) corrupts the upload and makes the
    // server reject it with a 400 "no file content received". Keep the auth header though.
    const isForm =
      typeof FormData !== 'undefined' && typeof options?.body !== 'string' && options?.body instanceof FormData;
    const headers: Record<string, string> = {};
    if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;
    if (!isForm) headers['Content-Type'] = 'application/json';
    Object.assign(headers, options?.headers || {});
    let response = await this.fetchWithTimeout(cacheBust, { ...options, headers }, timeoutMs);
    if (response.status === 401) {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        // Rebuild the Authorization header from the NEW token before retrying. `headers` was
        // captured with the pre-refresh token, so retrying with it resent the stale token and
        // 401'd again — turning every access-token expiry into a full session loss (and, since
        // the refresh had already rotated the refresh token, an unrecoverable one) on the next
        // cold start.
        if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;
        response = await this.fetchWithTimeout(cacheBust, { ...options, headers }, timeoutMs);
      }
    }
    return response;
  }

  /**
   * Confirms an identifier before asking for a password.
   *
   * Previously downloaded the entire assayer roster from a public endpoint and
   * matched client-side — which is why that endpoint had to be public, exposing
   * every assayer's bcrypt hash and personal details to anyone who could reach
   * the API. The server now answers for one identifier and returns only a name.
   */
  static async verifyAssayerIdentity(identifier: string): Promise<{ verified: boolean; assayer?: any; error?: string }> {
    try {
      const response = await this.fetchWithTimeout(`${API_BASE_URL}/auth/verify-assayer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier }),
      }, 20_000);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        return { verified: false, error: data?.message || 'Unable to reach the server.' };
      }
      if (!data.data?.verified) {
        return { verified: false, error: 'That identifier was not recognised.' };
      }
      return { verified: true, assayer: data.data };
    } catch (err: any) {
      return { verified: false, error: err?.message || 'Network error.' };
    }
  }

  /**
   * Biometric login only resumes a session that already exists on this device from a
   * prior real password login — the server verifies the stored refresh token, not the
   * biometric prompt itself (that happens on-device, before this is ever called).
   */
  static async biometricLogin(): Promise<{ success: boolean; token?: string; user?: any; error?: string }> {
    // Awaited: `getRefreshToken` became async when tokens moved to the OS keystore. Without
    // this the call returned a Promise — truthy, so the guard below passed — and it was
    // serialised into the request body as `{}`. Every refresh failed, so a session died the
    // moment the 15-minute access token expired, and biometric sign-in never worked at all.
    const refreshToken = await this.getRefreshToken();
    if (!refreshToken) {
      return { success: false, error: 'No saved session found. Please sign in with your Assayer Code and password first.' };
    }

    try {
      const response = await this.fetchWithTimeout(`${API_BASE_URL}/auth/biometric-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }, 20_000);
      const data = await response.json().catch(() => ({}));

      if (response.ok && data.success && data.data?.accessToken) {
        const userPayload = data.data.user || {};
        const token = data.data.accessToken;
        const name = userPayload.name || userPayload.displayName || userPayload.username || 'Assayer';
        this.setAuthToken(token, userPayload.id, name);
        if (data.data.refreshToken) {
          this.storeRefreshToken(data.data.refreshToken);
        }
        return { success: true, token, user: userPayload };
      }

      return {
        success: false,
        error: data.message || 'Biometric session expired. Please sign in with your password.',
      };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error during biometric login.' };
    }
  }

  static async login(username: string, password: string): Promise<{ success: boolean; token?: string; user?: any; error?: string }> {
    try {
      const response = await this.fetchWithTimeout(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }, 20_000);
      const data = await response.json().catch(() => ({}));

      if (response.ok && data.success && data.data?.accessToken) {
        const userPayload = data.data.user || {};
        const token = data.data.accessToken;
        const name = userPayload.name || userPayload.displayName || userPayload.username || username;
        this.setAuthToken(token, userPayload.id, name);
        if (data.data.refreshToken) {
          this.storeRefreshToken(data.data.refreshToken);
        }
        return { success: true, token, user: userPayload };
      }

      return {
        success: false,
        error: data.message || 'Invalid credentials or unregistered Assayer Code.',
      };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error connecting to server.' };
    }
  }

  /**
   * Operational limits the server enforces and this app must render.
   *
   * `maxNegotiationRounds` is the one that matters here. The counter-offer button used to be
   * disabled at a hardcoded 3 while the server reads the cap from platform settings an admin can
   * change — and exceeding it does not just refuse the counter, it auto-declines the whole offer.
   * A stale copy on the phone either locks the assayer out of a negotiation the platform would
   * allow, or invites a tap that loses them the job.
   */
  static async getPlatformLimits(): Promise<{ maxNegotiationRounds: number; checkInGeofenceMeters: number; maxSingleExpenseClaim: number }> {
    // Shipped defaults, matching the server registry, so a failed lookup is never worse than the
    // hardcoded values this replaced.
    const fallback = { maxNegotiationRounds: 3, checkInGeofenceMeters: 2000, maxSingleExpenseClaim: 50_000 };
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/platform-settings/limits`);
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success && data.data) return { ...fallback, ...data.data };
      return fallback;
    } catch {
      return fallback;
    }
  }

  static async getAssayerProfile(assayerId: string): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/assayers/${assayerId}/profile`);
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success && data.data) {
        return { success: true, data: data.data };
      }
      return { success: false, error: data.message || 'Failed to fetch assayer profile' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error fetching profile' };
    }
  }

  /** Returns the authenticated assayer's own profile (used to sync live-sharing state). */
  static async getSelfProfile(): Promise<{ success: boolean; data?: any; error?: string }> {
    const id = this.currentUserId;
    if (!id) return { success: false, error: 'Not authenticated' };
    return this.getAssayerProfile(id);
  }

  /**
   * Save the signed-in assayer's own profile.
   *
   * Three things were wrong here. The path was `PUT /assayers/:id/profile`, which does not
   * exist — only `GET` does — so every save returned 404. The payload was the whole profile
   * screen state, including read-only statistics (earnings, completion counts, ratings) and
   * fields the server refuses to let an assayer self-edit, which would have been rejected
   * even against the correct route. And several field names did not match the backend at all
   * (`emergencyName` vs `emergencyContactName`).
   *
   * Only self-editable fields are sent now, under their real names, with the comma-separated
   * text inputs converted to the arrays the API expects.
   */
  /**
   * Change the signed-in assayer's own password.
   *
   * Backed by `POST /assayers/me/change-password`, which verifies the current password,
   * enforces a minimum length, and clears the forced-rotation flag on success.
   */
  /**
   * Per-category notification preferences for the signed-in assayer.
   *
   * The backend has always exposed these; nothing in the app used them, so notifications
   * were all-or-nothing — an assayer could not keep assignment offers while muting billing
   * updates. The server returns a full set with defaults for categories never explicitly set,
   * so the caller never has to reason about missing rows.
   */
  static async getNotificationPreferences(): Promise<NotificationPreference[]> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/notifications/preferences`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) return [];
      return Array.isArray(data.data) ? data.data : [];
    } catch {
      return [];
    }
  }

  /** Turn one channel on or off for one category. Returns the refreshed full set. */
  static async setNotificationPreference(
    category: string,
    patch: { inApp?: boolean; push?: boolean; email?: boolean },
  ): Promise<{ success: boolean; preferences?: NotificationPreference[]; error?: string }> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/notifications/preferences/${category}`, {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        return { success: false, error: data?.message || 'Could not save that preference.' };
      }
      return { success: true, preferences: Array.isArray(data.data) ? data.data : undefined };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error saving preference' };
    }
  }

  static async changeOwnPassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/assayers/me/change-password`, {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        return {
          success: false,
          error: Array.isArray(data?.message) ? data.message.join(', ') : (data?.message || 'Could not change your password.'),
        };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error changing password' };
    }
  }

  /**
   * The assayer confirms their base location on the map from their device GPS.
   *
   * Distinct from `updateAssayerProfile` on purpose: this hits the base-location route, which
   * stores the fix as a MANUAL pin the nightly geocoder never overwrites. Saving the same
   * coordinate through the generic profile update would leave it re-geocodable — the next sweep
   * would move the person back to the wrong place the roster had put them.
   */
  static async confirmBaseLocation(
    assayerId: string,
    latitude: number,
    longitude: number,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/assayers/${assayerId}/base-location`, {
        method: 'PUT',
        body: JSON.stringify({ latitude, longitude }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        return {
          success: false,
          error: Array.isArray(data?.message) ? data.message.join(', ') : (data?.message || 'Could not save your location.'),
        };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error saving your location' };
    }
  }

  static async updateAssayerProfile(assayerId: string, profileData: any): Promise<{ success: boolean; error?: string }> {
    const toArray = (v: any): string[] =>
      Array.isArray(v) ? v : String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

    const payload: Record<string, any> = {};
    const put = (key: string, value: any) => {
      if (value !== undefined && value !== null && value !== '') payload[key] = value;
    };

    put('phone', profileData.phone);
    put('alternatePhone', profileData.alternatePhone);
    put('email', profileData.email);
    put('address', profileData.address);
    put('city', profileData.city);
    put('district', profileData.district);
    put('state', profileData.state);
    put('pincode', profileData.pincode);
    // 0,0 is the "not known yet" marker in this app, not a real location off West Africa.
    if (profileData.latitude && profileData.longitude) {
      payload.latitude = Number(profileData.latitude);
      payload.longitude = Number(profileData.longitude);
    }
    put('emergencyContactName', profileData.emergencyName);
    put('emergencyContactPhone', profileData.emergencyPhone);
    put('emergencyContactRelation', profileData.emergencyRelation);
    if (profileData.skills) payload.skills = toArray(profileData.skills);
    if (profileData.languages) payload.languages = toArray(profileData.languages);
    if (profileData.preferredRegions) payload.preferredRegions = toArray(profileData.preferredRegions);
    if (profileData.experienceYears != null) payload.experienceYears = Number(profileData.experienceYears) || 0;

    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/assayers/${assayerId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        return {
          success: false,
          error: Array.isArray(data?.message) ? data.message.join(', ') : (data?.message || `Save failed (${response.status})`),
        };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error updating profile' };
    }
  }

  static async rejectAssignment(assignmentId: string, reason: string): Promise<{ success: boolean; error?: string }> {
    const ok = await this.updateAssignmentStatus(assignmentId, 'REJECTED', reason);
    return { success: ok, error: ok ? undefined : 'Failed to reject assignment' };
  }

  /**
   * The assayer's own availability: the days they are off and the hours they work.
   *
   * The scheduler already refuses to place an audit on a day the assayer is on leave
   * (ConstraintEvaluator.checkLeaves), so this is what lets a field worker stop the desk
   * offering them work while they are away — without phoning HR. Sent through the same
   * self-profile endpoint; the backend now lists these among the self-editable fields.
   */
  static async updateAvailability(
    assayerId: string,
    data: { leaves?: { startDate: string; endDate: string }[]; workingHours?: { start: string; end: string } },
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/assayers/${assayerId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
      const body = await response.json().catch(() => ({}));
      return { success: response.ok && body?.success !== false, error: body?.message };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error updating availability' };
    }
  }

  /**
   * Flag a problem on an assignment to the operations desk.
   *
   * The field app cannot cancel or reassign work — that stays with the desk. This is the
   * assayer's channel to raise a problem (can't attend, branch shut, safety concern) so the
   * desk gets a real signal to act on, instead of the assayer having to phone someone with
   * nothing recorded.
   */
  static async reportAssignmentIssue(
    assignmentId: string,
    category: string,
    note?: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/assignments/${assignmentId}/report-issue`, {
        method: 'POST',
        body: JSON.stringify({ category, note: note?.trim() || undefined }),
      });
      const data = await response.json().catch(() => ({}));
      return { success: response.ok && data?.success !== false, error: data?.message };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error reporting the issue' };
    }
  }

  static async submitExpense(
    assignmentId: string,
    expense: { category: string; amount: number; description?: string }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/assignments/${assignmentId}/expenses`, {
        method: 'POST',
        body: JSON.stringify(expense),
      });
      const data = await response.json().catch(() => ({}));
      return { success: response.ok && data?.success !== false, error: data?.message };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error submitting expense' };
    }
  }

  /**
   * Resumable upload for the audited-return PDF.
   *
   * `uploadCompletedAuditPdf` sends the whole file in one request and retries the *whole
   * file* on failure. A branch visit ends with a multi-megabyte scan uploaded over rural
   * mobile data, so a drop at 90% meant starting again — and the retry loop could burn four
   * full attempts before giving up. This opens a session, sends fixed-size chunks, and on
   * reconnect asks the server which chunks survived so it sends only the gaps.
   *
   * Falls back to the single-shot path when a session cannot be opened, so an older backend
   * (or a misconfigured object store) still uploads rather than failing outright.
   */
  static async uploadAuditPdfResumable(
    assessmentId: string,
    fileName: string,
    fileUri: string,
    assignmentId?: string,
    onProgress?: (percent: number) => void,
  ): Promise<{ success: boolean; documentUrl?: string; error?: string }> {
    const info = await FileSystem.getInfoAsync(fileUri, { size: true });
    if (!info.exists) return { success: false, error: 'The scanned file is no longer on the device.' };
    const fileSize = (info as any).size as number;

    let session: { uploadId: string; totalChunks: number; chunkSize: number } | null = null;
    try {
      const res = await this.fetchWithAuth(`${API_BASE_URL}/documents/upload/session`, {
        method: 'POST',
        body: JSON.stringify({ assessmentId, fileName, fileSize }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.success && data.data?.uploadId) session = data.data;
    } catch {
      // Fall through to the single-shot path below.
    }

    if (!session) {
      return this.uploadCompletedAuditPdf(assessmentId, fileName, { uri: fileUri }, assignmentId);
    }

    const { uploadId, totalChunks, chunkSize } = session;

    // Ask which chunks already exist before sending anything. On a fresh session this is
    // empty; on a resume it is what makes the whole exercise worthwhile.
    let missing: number[] = Array.from({ length: totalChunks }, (_, i) => i);
    try {
      const res = await this.fetchWithAuth(`${API_BASE_URL}/documents/upload/session/${uploadId}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.success && Array.isArray(data.data?.missingChunks)) {
        missing = data.data.missingChunks;
      }
    } catch {
      // Keep the full list — re-sending a chunk is safe, losing one is not.
    }

    for (const index of missing) {
      const position = index * chunkSize;
      const length = Math.min(chunkSize, fileSize - position);

      const chunkUrl = `${API_BASE_URL}/documents/upload/session/${uploadId}/chunk/${index}`;
      let sent = false;
      let lastChunkError = '';

      // Three attempts per chunk. A chunk is small, so a retry here costs seconds rather
      // than restarting the entire transfer.
      for (let attempt = 1; attempt <= 3 && !sent; attempt++) {
        let tempUri: string | null = null;
        try {
          const base64 = await FileSystem.readAsStringAsync(fileUri, {
            encoding: FileSystem.EncodingType.Base64,
            position,
            length,
          });

          if (Platform.OS === 'web') {
            // RN's Blob typings differ from the DOM's; on web this is the real browser Blob.
            const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
            const blob = new (globalThis as any).Blob([bytes]);
            const form = new FormData();
            (form as any).append('chunk', blob, `${fileName}.part${index}`);
            const res = await this.fetchWithAuth(chunkUrl, { method: 'PUT', body: form as any });
            sent = res.ok;
            if (!sent) lastChunkError = `HTTP ${res.status}`;
          } else {
            /**
             * Native goes through a temp file rather than FormData.
             *
             * React Native's FormData only accepts `{uri, name, type}` parts, not Blobs, and
             * `atob` is not dependable under Hermes. Staging the slice on disk lets
             * `uploadAsync` stream the raw bytes, which is also what the single-shot path does.
             *
             * The `.bin` extension and the explicit `mimeType` below are both load-bearing.
             *
             * expo-file-system's Android multipart builder resolves the part's content type as
             * `options.mimeType ?: URLConnection.guessContentTypeFromName(file.name)` into a
             * non-null Kotlin `String`. `guessContentTypeFromName` returns null for a name it
             * does not recognise, and the chunk file was named `chunk_<uploadId>_<index>` — no
             * extension, nothing to recognise. Assigning that null threw NullPointerException
             * inside the native module before a single byte went out.
             *
             * That is exactly what the server saw: a session opened, its status polled, and then
             * no chunk request ever arriving — three identical silent failures, then "Upload
             * stalled at part 1". Every scanned audit packet failed this way.
             */
            tempUri = `${FileSystem.cacheDirectory}chunk_${uploadId}_${index}.bin`;
            await FileSystem.writeAsStringAsync(tempUri, base64, {
              encoding: FileSystem.EncodingType.Base64,
            });
            const result = await FileSystem.uploadAsync(chunkUrl, tempUri, {
              httpMethod: 'PUT',
              uploadType: FileSystem.FileSystemUploadType.MULTIPART,
              fieldName: 'chunk',
              // A chunk is a byte range, not a document — the whole file's type is recorded on
              // the session, and the server reassembles these without consulting it.
              mimeType: 'application/octet-stream',
              headers: this.authToken ? { Authorization: `Bearer ${this.authToken}` } : undefined,
            });
            sent = result.status >= 200 && result.status < 300;
            if (!sent) lastChunkError = `HTTP ${result.status}`;
          }
        } catch (err: any) {
          // Previously `catch {}`. The native NPE above was thrown, discarded, and retried into
          // the same wall three times — the one detail that would have identified the fault was
          // the one thing being dropped.
          sent = false;
          lastChunkError = err?.message || 'unknown error';
        } finally {
          if (tempUri) await FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
        }
        if (!sent && attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
      }

      if (!sent) {
        return {
          success: false,
          error:
            `Upload stalled at part ${index + 1} of ${totalChunks}` +
            `${lastChunkError ? ` (${lastChunkError})` : ''}. ` +
            'Reconnect and retry — the parts already sent are kept.',
        };
      }
      onProgress?.(Math.round(((index + 1) / totalChunks) * 100));
    }

    try {
      const res = await this.fetchWithAuth(
        `${API_BASE_URL}/documents/upload/session/${uploadId}/complete`,
        { method: 'POST', body: JSON.stringify({ type: 'AUDITED_RETURN_PDF' }) },
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.success) {
        return { success: true, documentUrl: `/documents/${data.data?.id}/download` };
      }
      return { success: false, error: data?.message || 'The upload could not be finalised.' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error finalising the upload.' };
    }
  }

  /**
   * The assayer's financial statement, straight from the billing engine.
   *
   * `GET /billing-engine/assayers/:assayerId/statement` has always been open to the ASSAYER
   * role and was never called. The earnings screen instead summed `agreedBaseFee +
   * agreedTravelFee` across whatever assignments happened to be loaded — a figure that omits
   * TDS, ignores part-payments, counts on-hold work as earned, and silently drops anything
   * older than the current assignment fetch. This is the number finance actually holds.
   */
  static async getAssayerStatement(assayerId: string): Promise<AssayerStatement | null> {
    try {
      const response = await this.fetchWithAuth(
        `${API_BASE_URL}/billing-engine/assayers/${assayerId}/statement`,
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success || !data.data) throw this.unavailable('Statement');

      const d = data.data;
      const num = (v: any) => Number(v) || 0;
      return {
        totals: {
          earned: num(d.totals?.earned),
          paid: num(d.totals?.paid),
          outstanding: num(d.totals?.outstanding),
          awaitingApproval: num(d.totals?.awaitingApproval),
          onHoldOrDisputed: num(d.totals?.onHoldOrDisputed),
          payableCount: num(d.totals?.payableCount),
        },
        payables: (d.payables || []).map((p: any) => ({
          id: p.id,
          payableNumber: p.payableNumber,
          status: p.status,
          onHold: !!p.onHold,
          holdReason: p.holdReason ?? null,
          assignmentId: p.assignmentId,
          expenseId: p.expenseId ?? null,
          baseAmount: num(p.baseAmount),
          travelAmount: num(p.travelAmount),
          tdsAmount: num(p.tdsAmount),
          totalAmount: num(p.totalAmount),
          paidAmount: num(p.paidAmount),
          outstanding: num(p.outstanding),
          createdAt: p.createdAt,
        })),
        payments: (d.payments || []).map((pm: any) => ({
          id: pm.id,
          paymentReference: pm.paymentReference,
          method: pm.method,
          amount: num(pm.amount),
          paidDate: pm.paidDate,
          balanceAfter: pm.balanceAfter == null ? null : num(pm.balanceAfter),
          notes: pm.notes,
        })),
      };
    } catch (err) {
      // `null` meant "no statement"; a dropped connection is not that.
      throw err instanceof Error && err.name === 'ServerUnavailableError' ? err : this.unavailable('Statement', err);
    }
  }

  /**
   * A short-lived signed URL for viewing a chat attachment.
   *
   * The attachment route is `@Public()` but validates a signed HMAC token, and it rejects a
   * plain JWT in the query string — so the old `resolveAttachmentUrl` (since removed) and its
   * `?token=<jwt>` returned 403 and every attachment in the app was unopenable.
   * `attachment-token` is the endpoint built for exactly this and was called by nothing on
   * either surface.
   */
  static async getAttachmentUrl(s3Key: string): Promise<string | null> {
    if (!s3Key) return null;
    try {
      const res = await this.fetchWithAuth(
        `${API_BASE_URL}/validation-queries/attachment-token?key=${encodeURIComponent(s3Key)}`,
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) return null;
      const path = data.data?.downloadUrl;
      return path ? `${this.getApiOrigin()}${path}` : null;
    } catch {
      return null;
    }
  }

  /**
   * The full clarification thread for a query.
   *
   * The app used to render only `queryText` and `assayerResponse` — two frozen fields — and
   * POST a single `respond`. The desk, meanwhile, was using this endpoint and holding a real
   * back-and-forth conversation the assayer could not see: any follow-up after the first reply
   * was invisible on the phone. Both sides now read and write the same thread.
   */
  /**
   * `null` means "could not load", `[]` means "loaded, and there are none". They used to be the
   * same value, and the thread rendered a network failure as "No replies yet — answer below and
   * the desk will see it immediately": the desk may have sent three messages the assayer could
   * not see, and the screen told them to reply into the void. On a branch connection that is
   * the common case, not the edge.
   */
  static async getQueryMessages(queryId: string): Promise<QueryMessage[] | null> {
    try {
      const res = await this.fetchWithAuth(`${API_BASE_URL}/validation-queries/${queryId}/messages`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) return null;
      return (data.data || []).map((m: any) => ({
        id: m.id,
        authorType: m.authorType === 'ASSAYER' ? 'ASSAYER' : 'STAFF',
        authorId: m.authorId,
        authorName: m.authorName ?? null,
        body: m.body ?? null,
        attachments: (Array.isArray(m.attachments) ? m.attachments : [])
          // Pre-fix rows stored `[[]]` — an array of empty arrays — because the server DTO
          // stripped them. Filter those out rather than rendering a nameless empty card.
          .filter((a: any) => a && !Array.isArray(a) && (a.url || a.s3Key))
          .map((a: any) => ({
            url: a.url,
            fileName: a.fileName || 'Attachment',
            fileType: a.fileType || 'application/octet-stream',
            s3Key: a.s3Key,
          })),
        pageNumber: m.pageNumber ?? null,
        region: m.region ?? null,
        // The cropped snapshot of the marked cell. Read from a few candidate shapes so whichever
        // the backend lands on works: a ready signed URL, or an object key resolved to one the
        // same way attachments are. `region` may also carry the crop nested alongside its rect.
        // Backend (validation-query messages endpoint) returns a signed `snapshotUrl` and the raw
        // `snapshotPath` key; accept those alongside the other shapes so the marked-cell crop
        // actually renders rather than falling back to the page-number line.
        regionImageUrl: m.regionImageUrl ?? m.regionSnapshotUrl ?? m.snapshotUrl ?? m.region?.imageUrl ?? null,
        regionImageS3Key: m.regionImageS3Key ?? m.regionSnapshotS3Key ?? m.snapshotPath ?? m.region?.s3Key ?? null,
        createdAt: m.createdAt,
      }));
    } catch {
      return null;
    }
  }

  /** Appends a message. The server moves the query's status to match who spoke. */
  static async postQueryMessage(
    queryId: string,
    body: string,
    attachments: { url: string; fileName: string; fileType: string }[] = [],
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await this.fetchWithAuth(`${API_BASE_URL}/validation-queries/${queryId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: body || undefined, attachments }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.success) return { success: true };
      return { success: false, error: data?.message || 'The message could not be sent.' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error sending the message.' };
    }
  }

  /**
   * The signed-in assayer's own expense claims.
   *
   * `submitExpense` above has always existed, but nothing ever read the claims back — an
   * assayer could file a reimbursement and then had no way to see whether it was approved,
   * rejected or still sitting in the queue. Both endpoints scope to the caller's own record
   * server-side, so no id is passed.
   */
  static async getMyExpenses(
    status?: 'PENDING' | 'APPROVED' | 'REJECTED',
  ): Promise<AssayerExpense[]> {
    try {
      const qs = status ? `?status=${status}` : '';
      const response = await this.fetchWithAuth(`${API_BASE_URL}/expenses/mine${qs}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) throw this.unavailable('Expense claims');
      return (data.data || []).map((e: any) => ({
        id: e.id,
        assignmentId: e.assignmentId,
        branchName:
          e.assignment?.projectBranch?.branchName || e.assignment?.branchName || 'Unknown branch',
        category: e.category,
        amount: Number(e.amount) || 0,
        description: e.description || '',
        status: e.status,
        receiptUrl: e.receiptUrl,
        createdAt: e.createdAt,
      }));
    } catch (err) {
      // Unreachable is not "no claims": throw, and let the screen keep what it last knew.
      throw err instanceof Error && err.name === 'ServerUnavailableError' ? err : this.unavailable('Expense claims', err);
    }
  }

  /** Claim totals, for the earnings screen. */
  static async getMyExpenseSummary(): Promise<ExpenseSummary> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/expenses/mine/summary`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success || !data.data) throw this.unavailable('Expense summary');
      const d = data.data;
      return {
        pending: Number(d.pending) || 0,
        approved: Number(d.approved) || 0,
        rejected: Number(d.rejected) || 0,
        totalClaimed: Number(d.totalClaimed) || 0,
      };
    } catch (err) {
      // Zeros would read as "nothing claimed"; a network failure is not that.
      throw err instanceof Error && err.name === 'ServerUnavailableError' ? err : this.unavailable('Expense summary', err);
    }
  }

  // Removed: getAssayerBilling, getAssayerBillingEngineEntries and getAssayerLedger.
  //
  // None of the three were called anywhere in the app, and two pointed at endpoints that have
  // never existed — `/billing/assayer/:id` and `/ledger/assayer/:id` both 404. The earnings
  // screen derives its figures from assignment fees and expense claims instead. If a real
  // statement view is wanted later, the working endpoints are
  // `GET /billing-engine/assayers/:assayerId/statement` and
  // `GET /billing-engine/ledger/:entityType/:entityId`.

  static async getBranchDocuments(projectBranchId: string): Promise<{
    success: boolean;
    data?: any[];
    /** Why there is nothing to download yet, so the app can say so precisely. */
    readiness?: { state: 'READY' | 'PREPARING' | 'NONE'; message: string; awaitingDispatchCount: number; lastDispatchedAt: string | null };
    error?: string;
  }> {
    try {
      // Dispatch-gated view: returns only paperwork operations has actually released,
      // plus a `readiness` block explaining what to expect when nothing is available yet.
      const response = await this.fetchWithAuth(`${API_BASE_URL}/documents/project-branch/${projectBranchId}/assayer-view`);
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success) {
        return { success: true, data: data.data, readiness: data.meta?.readiness };
      }
      return { success: false, error: data.message || 'Failed to fetch branch documents' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error fetching documents' };
    }
  }

  /**
   * The assayer's work list.
   *
   * **Throws** when the list could not be fetched, and returns `[]` only when the server really
   * says there is nothing. Those two are not the same fact and must not share a return value.
   *
   * This used to catch everything and `return []`. `AssignmentContext` already had the right
   * behaviour for a failed refresh — keep the cached list, set `stale`, let the UI say the data
   * is from cache — inside a `catch` that could therefore never run. The context instead took
   * the empty array as truth, cleared the screen and set `stale = false`: an assayer standing in
   * a vault with no signal was told, confidently, that they had no work today. Same shape as the
   * unreachable "we could not get your location" text: correct handling, made unreachable by a
   * swallow one layer down.
   */
  /**
   * One place that turns a server assignment row into the app's model, shared by the live list
   * and the paged history so the two can never disagree about what a job looks like.
   */
  private static mapAssignmentRows(rows: any[]): AssayerAssignment[] {
    return (rows || []).map((item: any, idx: number) => {
        const branch = item.projectBranch?.branch;
        const project = item.projectBranch?.project;
        return {
          id: item.id,
          assignmentCode: item.assignmentNumber || '',
          projectBranchId: item.projectBranchId || item.projectBranch?.id || '',
          branchName: branch?.name || '',
          branchCode: branch?.branchCode || '',
          bankName: project?.client?.name || '',
          branchAddress: branch?.address || '',
          // `null`, not 0. 0,0 is Null Island, and the navigation sheet used to route there for a
          // branch that simply had no pin yet. The sheet already handles a null destination.
          latitude: branch?.latitude != null ? Number(branch.latitude) : null,
          longitude: branch?.longitude != null ? Number(branch.longitude) : null,
          scheduledDate: item.scheduledDate || '',
          sequenceOrder: idx + 1,
          // The server sends the count; it no longer ships the customer ROWS, which carried
          // bank customers' account numbers and pledged weights into a plaintext cache file for
          // jobs finished months ago, and which nothing on screen ever read.
          estimatedCustomerCount: item.customerCount || item.projectBranch?.packetCount || 15,
          estimatedAuditHours: branch?.estimatedDurationHours != null ? Number(branch.estimatedDurationHours) : 0,
          // Unknown statuses surface as-is rather than being rewritten to PENDING; a status
          // the app does not recognise is a bug to see, not one to disguise as new work.
          status: isAssignmentStatus(item.status) ? item.status : item.status || AssignmentStatus.PENDING,
          proposedFee: item.proposedFee != null ? Number(item.proposedFee) : 0,
          // Null, not an invented 1200 — see utils/fees.ts. The server resolves this from the
          // assayer's commercial profile, so a missing value means "unknown", not "₹1200".
          // `undefined`, not `null`: the model treats the field as optional, and extracting this
          // mapper is what surfaced the mismatch the inline version had been widening away.
          // The agreed fee, and nothing else. `standardBaseFee` (the assayer's profile rate) and
          // `agreedTravelFee` (from a `travelAllowance` field the server never sends, so always
          // 0) were both dropped: a payout is booked from the agreed or proposed fee alone, and
          // a display fallback to any other figure shows a worker money they will not be paid.
          agreedBaseFee: item.agreedFee != null ? Number(item.agreedFee) : 0,
          // The quote breakdown recorded when the offer was priced. Grounding for display —
          // "includes ₹X travel by bus" — never added to totals: proposedFee already holds it.
          quotedTravelFee: item.quotedTravelFee != null ? Number(item.quotedTravelFee) : null,
          quotedTransportMode: item.quotedTransportMode ?? null,
          quotedDistanceKm: item.quotedDistanceKm != null ? Number(item.quotedDistanceKm) : null,
          distanceKm: (() => {
            const assayer = item.assayer;
            if (assayer && assayer.latitude != null && assayer.longitude != null && branch && branch.latitude != null && branch.longitude != null) {
              return Math.round(calculateHaversineDistance(
                Number(assayer.latitude), Number(assayer.longitude),
                Number(branch.latitude), Number(branch.longitude),
              ));
            }
            return undefined;
          })(),
          documentReadiness: item.documentReadiness ?? { state: 'NONE', dispatchedCount: 0, message: '' },
          negotiationCount: item.negotiationCount != null ? Number(item.negotiationCount) : 0,
          remarks: item.remarks || '',
          queries: item.queries || [],
          // `amount` arrives as a decimal string ("180.00") — Postgres numerics serialise that
          // way. The earnings screen sums these with `+`, so leaving them as strings would
          // concatenate rather than add ("0" + "180.00" = "0180.00") and show a nonsense total.
          expenses: (item.expenses || []).map((e: any) => ({ ...e, amount: Number(e.amount) || 0 })),
        };
      });
  }

  /**
   * Older, settled work — the part of the book `scope=active` deliberately leaves behind.
   *
   * Paged with an opaque cursor rather than an offset, so a page boundary cannot repeat or skip
   * a job as newer ones arrive. `nextCursor` is null once there is nothing older.
   */
  static async getAssayerAssignmentHistory(
    assayerId: string,
    before?: string,
    limit = 20,
  ): Promise<{ items: AssayerAssignment[]; nextCursor: string | null }> {
    const params = new URLSearchParams({ scope: 'history', limit: String(limit) });
    if (before) params.set('before', before);
    const response = await this.fetchWithAuth(
      `${API_BASE_URL}/assignments/assayer/${assayerId}?${params.toString()}`,
    );
    if (!response.ok) throw this.unavailable('Job history');
    const data = await response.json();
    return {
      items: this.mapAssignmentRows(data.items || []),
      nextCursor: data.meta?.hasMore ? (data.meta.nextCursor ?? null) : null,
    };
  }

  /**
   * The work list.
   *
   * `scope=active` is what the app runs on: everything in flight plus recently settled work, so
   * the schedule's short history and the earnings totals still have what they need. It replaces
   * a request that returned the assayer's entire career — every completed, rejected and
   * cancelled job ever — on a list the app refetches on twelve socket events, every five
   * minutes, after every mutation and twice on a cold start. Older work is paged through
   * `getAssayerAssignmentHistory`.
   */
  static async getAssayerAssignments(assayerId?: string): Promise<AssayerAssignment[]> {
    // Not a failure: there is genuinely nobody to fetch for yet.
    if (!assayerId) return [];
    try {
      const response = await this.fetchWithAuth(
        `${API_BASE_URL}/assignments/assayer/${assayerId}?scope=active`,
      );
      if (!response.ok) {
        throw new Error(`Assignments request failed with ${response.status}.`);
      }
      const data = await response.json();
      const rawItems = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : (data?.items || []));

      return MobileApiService.mapAssignmentRows(rawItems);
    } catch (error) {
      // Re-thrown, not swallowed. The caller decides what an unreachable server looks like on
      // screen; this layer's job is to be honest that it could not answer.
      console.warn('Could not load assignments:', error);
      throw error instanceof Error ? error : new Error('Could not load assignments.');
    }
  }

  static async updateAssignmentStatus(
    assignmentId: string,
    status: AssayerAssignment['status'],
    reason?: string,
    /**
     * What the assayer is asking for the journey.
     *
     * A counter-offer is about travel, not the audit fee — the fee comes from the rate card and
     * is not the assayer's to move. This used to send the whole fee, and the server carved
     * travel back out at the quoted figure, so everything asked for landed in the base.
     */
    counterTravelFee?: number,
  ): Promise<boolean> {
    const backendStatus = counterTravelFee !== undefined ? 'COUNTER_OFFER' : status;
    const body: any = { targetStatus: backendStatus };
    if (reason) body.reason = reason;
    if (counterTravelFee !== undefined) body.counterTravelFee = counterTravelFee;
    const response = await this.fetchWithAuth(`${API_BASE_URL}/assignments/${assignmentId}/transition`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.ok;
  }

  /**
   * `accuracy` is the GPS uncertainty radius in metres, sent so the server can record how
   * trustworthy the fix was. A check-in accurate to 8 m and one accurate to 2 km are very
   * different pieces of evidence, and without this they were indistinguishable.
   */
  static async checkInBranch(
    assignmentId: string,
    lat: number,
    lng: number,
    accuracy?: number,
    syncToken?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const response = await this.fetchWithAuth(`${API_BASE_URL}/assignments/${assignmentId}/check-in`, {
      method: 'POST',
      body: JSON.stringify({ lat, lng, accuracy, syncToken, timestamp: new Date().toISOString() }),
    });
    const resData = await response.json().catch(() => ({}));
    return {
      success: response.ok && resData.success !== false,
      // The human sentence, not the machine code. The server refuses check-ins with a code
      // ("NOT_SCHEDULED_TODAY", "TOO_FAR_FROM_BRANCH") *and* a message explaining what to do;
      // surfacing the code put "TOO_FAR_FROM_BRANCH" in the assayer's toast.
      error: resData.message || resData.error,
    };
  }

  /**
   * Push "where are they now" to the server.
   *
   * Resolves `true` on success and **throws** on failure, rather than the older
   * swallow-and-return-`false`. That shape silently disabled the degraded-tracking indicator:
   * `LocationContext` pushes with `.then(reset failures).catch(increment failures)`, and a
   * promise that always resolves means the counter was reset on every push and the `.catch` was
   * unreachable. An assayer whose position feed was failing — the feed a travel claim is later
   * checked against — was told nothing, and neither was the desk.
   *
   * Callers that genuinely do not care whether it landed should say so with `.catch(() => {})`
   * at the call site, where the decision is visible.
   */
  static async updateLiveLocation(lat: number, lng: number): Promise<boolean> {
    const id = this.currentUserId;
    // Not an error: no session means nothing to push yet. The caller treats this as "nothing
    // happened", which must not count as a failure against the degraded-tracking threshold.
    if (!id) return false;

    const response = await this.fetchWithAuth(`${API_BASE_URL}/assayers/${id}/live-location`, {
      method: 'PUT',
      // `trailSelfManaged` tells the server not to mirror this into the movement trail: this
      // build queues its own fixes and uploads them through `uploadLocationPings`, so mirroring
      // would store the same position twice under two different clocks.
      body: JSON.stringify({ latitude: lat, longitude: lng, trailSelfManaged: true }),
    });
    if (!response.ok) {
      throw new Error(`Live position rejected by the server (HTTP ${response.status}).`);
    }
    return true;
  }

  /**
   * Upload a batch of recorded positions to the movement trail.
   *
   * Separate from `updateLiveLocation`, which answers "where are they now" and overwrites. This
   * one appends history, and it takes a batch because the fixes worth having are the ones taken
   * where there was no signal to send them — they are queued on the device and flushed when the
   * network returns. Re-sending a batch is safe: the server dedupes on (assayer, recordedAt), so a
   * retry cannot inflate the distance the trail is later measured for.
   *
   * Returns true only when the server has durably accepted the batch, because the caller keeps the
   * fixes queued on anything else.
   */
  static async uploadLocationPings(pings: unknown[]): Promise<boolean> {
    const id = this.currentUserId;
    if (!id || pings.length === 0) return false;
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/assayers/${id}/location-pings`, {
        method: 'POST',
        body: JSON.stringify({ pings }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Turns live-location sharing on/off for the current assayer (default OFF). */
  static async setLiveTracking(enabled: boolean): Promise<boolean> {
    const id = this.currentUserId;
    if (!id) return false;
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/assayers/${id}/live`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Uploads an assayer government identity document (Aadhaar, PAN, Driving Licence)
   * during self-onboarding.
   */
  static async uploadGovernmentDocument(
    documentType: string,
    documentNumber: string,
    expiryDate?: string,
    filePaths?: string[],
    remarks?: string,
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const id = this.currentUserId;
    if (!id) return { success: false, error: 'Not authenticated' };
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/assayers/${id}/government-document`, {
        method: 'POST',
        body: JSON.stringify({
          documentType,
          documentNumber,
          expiryDate,
          filePaths: filePaths || [],
          remarks,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success !== false) {
        return { success: true, data: data.data };
      }
      return { success: false, error: data.message || 'Upload failed' };
    } catch (err: any) {
      return { success: false, error: err.message || 'Network error' };
    }
  }

  /**
   * Uploads the assayer's completed audit PDF as raw binary.
   *
   * Previously this sent base64 inside a JSON body, which inflates every upload by 33% and
   * required the whole file as a JS string on the device first — on a rural 2G link that is
   * minutes of extra transfer per scan, and on a low-end handset the in-memory copy could
   * fail the upload outright.
   *
   * All three sources end up as binary on the wire:
   *   - `uri`    (document picker)  streamed straight off disk
   *   - `blob`   (web file input)   sent as multipart
   *   - `base64` (in-app scanner)   staged to a temp file first, so even though the scanner
   *                                 can only hand us base64, we never *transmit* base64
   *
   * Retries with exponential backoff, since field connections drop transiently and a single
   * failure used to force the assayer to redo the upload by hand.
   */
  static async uploadCompletedAuditPdf(
    targetId: string,
    fileName: string,
    source: { uri?: string; blob?: any; base64?: string } | string | undefined,
    assignmentId?: string,
  ): Promise<{ success: boolean; documentUrl?: string; error?: string }> {
    // A bare string is legacy base64 from older call sites.
    const src = typeof source === 'string' ? { base64: source } : source || {};

    const url =
      `${API_BASE_URL}/documents/mobile-upload-binary` +
      `?assessmentId=${encodeURIComponent(targetId)}` +
      (assignmentId ? `&assignmentId=${encodeURIComponent(assignmentId)}` : '');

    const MAX_ATTEMPTS = 4;
    let lastError = 'Upload failed';
    let tempUri: string | null = null;

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const ok = await this.sendBinaryUpload(url, fileName, src, () => tempUri, (u) => { tempUri = u; });
          if (ok.done) return ok.result;
          lastError = ok.error || lastError;
          if (ok.fatal) return { success: false, error: lastError };
        } catch (err: any) {
          lastError = err?.message || 'Network error during upload';
        }

        if (attempt < MAX_ATTEMPTS) {
          // 1s, 2s, 4s — rides out a brief signal loss without stalling the user.
          await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        }
      }
      return { success: false, error: `${lastError} (after ${MAX_ATTEMPTS} attempts)` };
    } finally {
      if (tempUri) {
        await FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
      }
    }
  }

  /** One upload attempt. Split out so the retry loop above stays readable. */
  private static async sendBinaryUpload(
    url: string,
    fileName: string,
    src: { uri?: string; blob?: any; base64?: string },
    getTemp: () => string | null,
    setTemp: (u: string) => void,
  ): Promise<{ done: boolean; fatal?: boolean; error?: string; result?: any }> {
    const isWeb = Platform.OS === 'web';

    if (isWeb) {
      // On web, FormData with a Blob is already binary — no base64 needed on the wire.
      let blob = src.blob;
      if (!blob && src.base64) {
        // React Native's Blob typings differ from the DOM's; on web this runs against the
        // real browser Blob, so cast rather than fight the RN type surface.
        const bytes = Uint8Array.from(atob(src.base64), (c) => c.charCodeAt(0));
        blob = new (globalThis as any).Blob([bytes], { type: 'application/pdf' });
      }
      if (!blob) return { done: false, fatal: true, error: 'No file content to upload.' };

      const form = new FormData();
      (form as any).append('file', blob, fileName);
      const response = await this.fetchWithAuth(url, { method: 'POST', body: form as any });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success) {
        return { done: true, result: { success: true, documentUrl: `/documents/${data.data?.id}/download` } };
      }
      return {
        done: false,
        fatal: response.status >= 400 && response.status < 500 && ![401, 408, 429].includes(response.status),
        error: data.message || `Upload failed (${response.status})`,
      };
    }

    // Native: resolve to a file URI so the bytes stream from disk instead of through memory.
    let uri = src.uri || getTemp();
    if (!uri && src.base64) {
      const staged = `${FileSystem.cacheDirectory}upload_${Date.now()}_${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
      await FileSystem.writeAsStringAsync(staged, src.base64, { encoding: FileSystem.EncodingType.Base64 });
      setTemp(staged);
      uri = staged;
    }
    if (!uri) return { done: false, fatal: true, error: 'No file content to upload.' };

    const result = await FileSystem.uploadAsync(url, uri, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'file',
      // Derived from the filename rather than asserted. This was hardcoded to
      // 'application/pdf', so ML Kit's JPEG captures were stored as PDFs — the live document
      // table contains rows named *.pdf with mime_type application/pdf that no PDF reader can
      // open, because the bytes are JPEG.
      mimeType: /\.(jpe?g)$/i.test(fileName) ? 'image/jpeg'
        : /\.png$/i.test(fileName) ? 'image/png'
        : 'application/pdf',
      parameters: { fileName },
      headers: this.getHeaders() as Record<string, string>,
    });

    const data = JSON.parse(result.body || '{}');
    if (result.status >= 200 && result.status < 300 && data.success) {
      return { done: true, result: { success: true, documentUrl: `/documents/${data.data?.id}/download` } };
    }
    return {
      done: false,
      fatal: result.status >= 400 && result.status < 500 && ![401, 408, 429].includes(result.status),
      error: data.message || `Upload failed (${result.status})`,
    };
  }

  /**
   * Resolves a browser-openable download URL for a document.
   *
   * The document download endpoint is no longer public — it previously exposed bank customer
   * paperwork to anyone who could reach the API. It now requires a short-lived token bound to
   * that one document, because `Linking.openURL()` hands the URL to the OS browser, which
   * cannot send our Authorization header. So we exchange the authenticated session for a
   * scoped token first, then open the signed URL.
   */
  /**
   * A failure here used to collapse to a bare `null`, so the screen showed the
   * same "check your connection" message whether the real cause was an expired
   * session, the document not being dispatched yet, or a genuine network drop —
   * none of which "check your connection" is the right advice for. `fetchWithAuth`
   * already retries once after a token refresh, so a 401 that still comes back
   * here means the refresh itself failed and the session is genuinely over.
   */
  static async getDocumentDownloadUrl(documentId: string): Promise<
    { ok: true; url: string } | { ok: false; reason: 'SESSION_EXPIRED' | 'NOT_AVAILABLE' | 'NETWORK'; message: string }
  > {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/documents/${documentId}/download-token`);
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        return { ok: false, reason: 'SESSION_EXPIRED', message: 'Your session has expired. Please log out and sign in again.' };
      }
      if (!response.ok || !data?.success || !data?.data?.token) {
        return { ok: false, reason: 'NOT_AVAILABLE', message: data?.message || 'This document is not available to download right now.' };
      }
      return { ok: true, url: `${this.getBaseUrl()}/documents/${documentId}/download?token=${data.data.token}` };
    } catch {
      return { ok: false, reason: 'NETWORK', message: 'Could not reach the server. Check your connection and try again.' };
    }
  }

  static async getAssayerQueries(assayerId: string): Promise<any[]> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/validation-queries/assayer/${assayerId}`);
      if (!response.ok) return [];
      const data = await response.json();
      return data.data || data.items || [];
    } catch {
      return [];
    }
  }

  // ── Feedback & collaboration channel ────────────────────────────────────────
  // The assayer's side of the two-way feedback channel with the product team. The
  // server scopes /feedback/mine to the caller's assayer id from the token, so no id
  // is passed. Mirrors the validation-query methods above.

  /** The feedback threads this assayer has raised, newest activity first. */
  static async getMyFeedback(): Promise<any[]> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/feedback/mine`);
      if (!response.ok) return [];
      const data = await response.json();
      return data.data || [];
    } catch {
      return [];
    }
  }

  static async getFeedbackThread(id: string): Promise<any | null> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/feedback/${id}`);
      if (!response.ok) return null;
      const data = await response.json();
      return data.data || null;
    } catch {
      return null;
    }
  }

  static async getFeedbackMessages(id: string): Promise<any[]> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/feedback/${id}/messages`);
      if (!response.ok) return [];
      const data = await response.json();
      return data.data || [];
    } catch {
      return [];
    }
  }

  /**
   * Attach a photo or a file to a report.
   *
   * The same shape as `uploadChatAttachment` and pointed at the feedback route, which applies
   * the same type allowlist, size ceiling and malware scan as every other upload. The reply is
   * the descriptors the report carries; the bytes never travel with the report itself.
   *
   * Returns `[]` rather than throwing on failure — an attachment that will not upload must not
   * cost the assayer the report they have already written. The caller says so and lets them
   * send it without.
   */
  static async uploadFeedbackAttachments(assets: any[]): Promise<any[]> {
    if (!assets?.length) return [];
    try {
      const formData = new FormData();
      for (const file of assets) {
        if (Platform.OS === 'web') {
          formData.append('files', file.file ?? file);
        } else {
          formData.append('files', {
            uri: file.uri,
            name: file.name || file.fileName || `feedback_${Date.now()}`,
            type: file.mimeType || file.type || 'application/octet-stream',
          } as any);
        }
      }
      const headers: Record<string, string> = {};
      if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;

      const response = await this.fetchWithTimeout(`${API_BASE_URL}/feedback/attachments`, {
        method: 'POST', headers, body: formData,
      }, 60_000);
      if (!response.ok) return [];
      const data = await response.json().catch(() => ({}));
      return data?.data ?? [];
    } catch {
      return [];
    }
  }

  static async createFeedback(input: { title?: string; body: string; category?: string; appContext?: Record<string, unknown>; attachments?: any[] }): Promise<{ success: boolean; id?: string; error?: string }> {
    try {
      const res = await this.fetchWithAuth(`${API_BASE_URL}/feedback`, { method: 'POST', body: JSON.stringify(input) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.success) return { success: true, id: data?.data?.id };
      return { success: false, error: data?.message || 'The feedback could not be sent.' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error sending feedback.' };
    }
  }

  static async postFeedbackMessage(id: string, body: string): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await this.fetchWithAuth(`${API_BASE_URL}/feedback/${id}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.success) return { success: true };
      return { success: false, error: data?.message || 'The message could not be sent.' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error sending the message.' };
    }
  }

  /**
   * Upload a chat attachment file to server disk storage using multipart/form-data.
   * Returns a lightweight URL reference instead of storing multi-MB base64 in DB.
   */
  static async uploadChatAttachment(file: any): Promise<any[] | null> {
    try {
      const formData = new FormData();
      if (Platform.OS === 'web') {
        formData.append('files', file);
      } else {
        formData.append('files', {
          uri: file.uri,
          name: file.name || file.fileName || `mobile_upload_${Date.now()}`,
          type: file.mimeType || file.type || 'application/octet-stream',
        } as any);
      }

      const token = this.authToken;
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await this.fetchWithTimeout(`${API_BASE_URL}/validation-queries/upload-attachment`, {
        method: 'POST',
        headers,
        body: formData,
      }, 60_000);

      if (response.ok) {
        const data = await response.json();
        return data?.data || null;
      }
      return null;
    } catch {
      return null;
    }
  }

  static async getNotifications(): Promise<AppNotification[]> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/notifications`);
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success) {
        return (data.data || []).map((n: any) => ({
          id: n.id,
          title: n.title,
          message: n.message,
          isRead: n.isRead,
          link: n.link || null,
          createdAt: n.createdAt,
          assignmentId: n.link?.startsWith('/assignments/') ? n.link.replace('/assignments/', '') : undefined,
          // Kept rather than discarded: the list picks its icon from this, not from English
          // words in an operator-editable title. See AppNotification.type.
          type: n.type ?? undefined,
        }));
      }
      throw this.unavailable('Notifications');
    } catch (err) {
      // An empty list zeroes the badge; a network failure must not. The hook keeps its state.
      throw err instanceof Error && err.name === 'ServerUnavailableError' ? err : this.unavailable('Notifications', err);
    }
  }

  static async markNotificationRead(notificationId: string): Promise<boolean> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/notifications/${notificationId}/read`, {
        method: 'POST',
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** The reverse — swipe-to-unread on the notification list. */
  static async markNotificationUnread(notificationId: string): Promise<boolean> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/notifications/${notificationId}/unread`, {
        method: 'POST',
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Clear the whole unread list in one call.
   *
   * `/notifications/read-all` has existed on the backend the whole time with nothing on the
   * handset calling it. Without it the only way to clear the bell is to open every item one at
   * a time — and an assayer coming back from a week in the field opens the app to a badge in the
   * dozens (24 on the test handset), so in practice the badge is simply never cleared and stops
   * carrying information.
   */
  static async markAllNotificationsRead(): Promise<boolean> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/notifications/read-all`, {
        method: 'POST',
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
