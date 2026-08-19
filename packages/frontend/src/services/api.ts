import { NotificationCategory } from '@fapoms/shared';
import { AppError, fromNetwork, fromResponse } from './errors';
import { clearSession, rememberForcedSignOut } from './session';
// Budgets and the direct-fetch helper live in a leaf module so `session.ts` can share them
// without closing an import cycle back through this file. See services/http.ts.
import { DEFAULT_TIMEOUT_MS, LONG_TIMEOUT_MS } from './http';
export { fetchWithTimeout, DEFAULT_TIMEOUT_MS, LONG_TIMEOUT_MS } from './http';

/**
 * Re-exported from shared, never re-declared.
 *
 * This was a local union of seven members while the shared enum had eight. The server sends a
 * preference row per category unconditionally, so every user received a `FEEDBACK` row the web
 * app's types said could not exist — `Record<NotificationCategory, …>` type-checked clean
 * against the short union, `CATEGORY_META['FEEDBACK']` came back undefined at runtime, and
 * dereferencing it threw during render. With no error boundary anywhere in this app, React
 * unmounted the whole root: the Preferences tab took the entire page blank for every user.
 *
 * A local copy of a shared enum does not just risk drift — it actively suppresses the error that
 * would have caught the drift.
 */
export { NotificationCategory } from '@fapoms/shared';
export type NotificationPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
export type NotificationDeliveryStatus = 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'SUPPRESSED';

export interface WebNotification {
  id: string;
  title: string;
  message: string;
  isRead: boolean;
  link: string | null;
  createdAt: string;
  category?: NotificationCategory;
  priority?: NotificationPriority;
  status?: NotificationDeliveryStatus;
  type?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

export interface NotificationPage {
  items: WebNotification[];
  total: number;
  unreadCount: number;
}

export interface NotificationQuery {
  category?: NotificationCategory;
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface NotificationPreference {
  category: NotificationCategory;
  inApp: boolean;
  push: boolean;
  email: boolean;
}

class ApiClient {
  private refreshPromise: Promise<boolean> | null = null;

  async request<T>(
    endpoint: string,
    options?: RequestInit & { raw?: boolean; withMeta?: boolean; timeoutMs?: number },
  ): Promise<T> {
    const token = localStorage.getItem('fapoms_token');
    const headers: Record<string, string> = {
      ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers as Record<string, string> || {}),
    };

    /**
     * One signal that carries both reasons a request should stop: the caller no longer wants the
     * answer, and the answer is taking too long.
     *
     * The caller's signal is React Query's — every `queryFn: ({ signal }) => api.request(url, { signal })`
     * hands it down — so navigating away, switching branch, or changing a filter now actually
     * cancels the request instead of leaving it to arrive later and overwrite newer state. That
     * last part is not hypothetical: the planning desk fired a fresh recommendation request on
     * every branch click, and a slow response for the branch you clicked first would land after
     * the fast one for the branch you clicked second and repaint the panel with the wrong
     * candidates.
     *
     * They are composed by hand rather than with `AbortSignal.any` so the client keeps working on
     * the older Chromium builds still deployed on some desks, and the abort *reason* is forwarded
     * so the catch below can tell "the caller cancelled" (nothing to report) from "we timed out"
     * (something to tell the operator).
     */
    const callerSignal = options?.signal ?? undefined;
    const controller = new AbortController();
    const timeoutMs = options?.timeoutMs
      ?? (options?.body instanceof FormData || options?.raw ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    const timer = setTimeout(
      () => controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError')),
      timeoutMs,
    );
    const forwardAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal) {
      if (callerSignal.aborted) forwardAbort();
      else callerSignal.addEventListener('abort', forwardAbort, { once: true });
    }
    try {
      return await this.send<T>(endpoint, options, headers, controller.signal, callerSignal, timeoutMs);
    } finally {
      // The budget covers the whole call including a token refresh and its retry, so the timer is
      // only cleared once that has all finished — and it is cleared on the failure path too, or a
      // long-lived tab accumulates one pending timer per request it ever made.
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', forwardAbort);
    }
  }

  /**
   * The request itself, split out only so `request` can own the timeout's lifetime in one
   * `finally` rather than repeating `clearTimeout` down every early-return and throw path.
   */
  private async send<T>(
    endpoint: string,
    options: (RequestInit & { raw?: boolean; withMeta?: boolean }) | undefined,
    headers: Record<string, string>,
    signal: AbortSignal,
    callerSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<T> {
    // A dropped connection previously surfaced as a raw `TypeError: Failed to
    // fetch`, which reads as a crash. Offline is a normal condition for field
    // staff on mobile data, not an error state to panic about.
    let response: Response;
    try {
      response = await fetch(`/api/v1${endpoint}`, { ...options, headers, signal });
    } catch (netErr) {
      throw this.abortAwareNetworkError(netErr, endpoint, options?.method, callerSignal, signal, timeoutMs);
    }

    // 403 Forbidden from RolesGuard/PermissionsGuard means user IS authenticated
    // but lacks the required role/permission — do NOT attempt token refresh, throw immediately
    if (response.status === 403) {
      const errorData = await response.json().catch(() => ({}));
      throw fromResponse(403, errorData);
    }

    if (response.status === 401) {
      if (!this.refreshPromise) {
        this.refreshPromise = this.doRefresh();
      }

      const refreshSuccess = await this.refreshPromise;

      if (refreshSuccess) {
        const newToken = localStorage.getItem('fapoms_token');
        const retryHeaders = {
          ...headers,
          Authorization: `Bearer ${newToken}`,
        };
        try {
          response = await fetch(`/api/v1${endpoint}`, { ...options, headers: retryHeaders, signal });
        } catch (netErr) {
          throw this.abortAwareNetworkError(netErr, endpoint, options?.method, callerSignal, signal, timeoutMs);
        }
      }

      if (response.status === 401) {
        /**
         * The refresh was tried and did not save us, so the session really is over.
         *
         * Two things are recorded before the teardown, and both have to happen *before*
         * `clearSession()` and the navigation, because `location.replace` reloads the page and
         * nothing in memory survives it:
         *
         *  1. Where the person was. This handler bypasses the router entirely, so App.tsx's
         *     `RememberAndRedirectToLogin` — the only other writer of the return path — never
         *     runs. Without this write the destination was lost, and appeared to work only when
         *     a stale value from an earlier bounce happened to still be there.
         *  2. Whether a *save* was in flight. A GET that 401s loses nothing; a POST/PUT/PATCH/
         *     DELETE that 401s means the person's typed work did not reach the server and the
         *     form it was typed into is about to be destroyed by the reload. This app has no
         *     mechanism to hold that draft across a reload, so the honest and achievable fix is
         *     to say so plainly on the login screen rather than let them find out later.
         */
        const method = (options?.method ?? 'GET').toUpperCase();
        const wasSaving = method !== 'GET' && method !== 'HEAD';
        rememberForcedSignOut(
          wasSaving ? 'expired_save' : 'expired',
          `${window.location.pathname}${window.location.search}`,
        );
        // Same teardown as an explicit logout, so the two paths cannot drift apart again.
        clearSession();
        if (window.location.pathname !== '/login') {
          window.location.replace('/login');
        }
        throw new Error('Unauthorized session expired');
      }
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      // Endpoint paths and status codes mean nothing to the people using this
      // system; fromResponse() turns both into a sentence with a next step, and
      // keeps the original text on the error for the console.
      const appErr = fromResponse(response.status, errorData);
      console.error(`[api] ${options?.method ?? 'GET'} ${endpoint} -> ${response.status}:`, appErr.technical);
      throw appErr;
    }

    if ((options as any)?.raw) {
      return response.blob() as unknown as T;
    }

    /**
     * A successful response need not carry a body.
     *
     * `DELETE` handlers answer `204 No Content`, and calling `.json()` on an empty body throws
     * `Unexpected end of JSON input`. The delete had already succeeded on the server, but the
     * caller saw that raw parser message as its error and skipped its own refresh — so the record
     * stayed on screen next to a JavaScript error, and the natural response was to try again.
     */
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as unknown as T;
    }

    const res = await response.json();
    if ((options as any)?.withMeta) {
      return res as T;
    }

    /**
     * Envelope-tolerant, in one place.
     *
     * Most controllers answer `{ success: true, data: … }`, but a number of them return the
     * value directly (the pricing quote, for one). This used to be an unconditional
     * `res.data`, which is `undefined` for the bare ones — so page after page grew its own
     * workaround: two private `unwrap()` helpers and four `Array.isArray(res) ? res : res.data`
     * ternaries, each solving the same problem slightly differently and each a place for the
     * next reader to wonder which shape an endpoint really returns.
     *
     * Both keys are required before unwrapping, so a bare payload that happens to carry a
     * `data` field of its own is passed through untouched.
     */
    const enveloped =
      res !== null &&
      typeof res === 'object' &&
      !Array.isArray(res) &&
      'success' in res &&
      'data' in res;
    return (enveloped ? (res as any).data : res) as T;
  }

  /**
   * Turns a failed `fetch` into the right kind of failure — which depends on who stopped it.
   *
   * Three outcomes hide behind one `TypeError`/`AbortError`:
   *  - The CALLER cancelled (React Query dropped the query because the component unmounted or the
   *    key changed). Nobody is waiting for this answer and nothing went wrong, so the original
   *    abort is rethrown untouched: React Query recognises it as a cancellation and leaves the
   *    cache and the error state alone. Wrapping it in an AppError instead would paint a red
   *    "could not reach the server" banner on a screen the operator just navigated away from.
   *  - WE gave up (the timeout fired). That is worth telling someone about, and it is a different
   *    sentence from "you are offline" — the connection was fine, the answer never came.
   *  - Genuine network failure, which `fromNetwork` already words for a non-technical reader.
   */
  private abortAwareNetworkError(
    netErr: unknown,
    endpoint: string,
    method: string | undefined,
    callerSignal: AbortSignal | undefined,
    signal: AbortSignal,
    timeoutMs: number,
  ): unknown {
    if (callerSignal?.aborted) return netErr;
    if (signal.aborted) {
      const appErr = new AppError(
        'The server took too long to respond. Please try again.',
        `Aborted after ${timeoutMs}ms`,
      );
      console.error(`[api] ${method ?? 'GET'} ${endpoint} -> timeout after ${timeoutMs}ms`);
      return appErr;
    }
    const appErr = fromNetwork(netErr);
    console.error(`[api] ${method ?? 'GET'} ${endpoint} -> network:`, appErr.technical);
    return appErr;
  }

  /** @deprecated use getNotificationPage — kept for the couple of call sites not yet migrated. */
  async getNotifications(): Promise<WebNotification[]> {
    try {
      const page = await this.getNotificationPage({ limit: 50 });
      return page.items;
    } catch {
      return [];
    }
  }

  async getNotificationPage(query: NotificationQuery = {}): Promise<NotificationPage> {
    const params = new URLSearchParams();
    if (query.category) params.set('category', query.category);
    if (query.unreadOnly) params.set('unreadOnly', 'true');
    params.set('limit', String(query.limit ?? 25));
    params.set('offset', String(query.offset ?? 0));

    const res = await this.request<{ data: WebNotification[]; meta: { total: number; unreadCount: number } }>(
      `/notifications?${params.toString()}`, { withMeta: true },
    );
    return { items: res.data ?? [], total: res.meta?.total ?? 0, unreadCount: res.meta?.unreadCount ?? 0 };
  }

  async getUnreadNotificationCount(): Promise<number> {
    try {
      const res = await this.request<{ count: number } | { data: { count: number } }>('/notifications/unread-count');
      return (res as any)?.count ?? (res as any)?.data?.count ?? 0;
    } catch {
      return 0;
    }
  }

  async markNotificationRead(id: string): Promise<boolean> {
    try {
      await this.request(`/notifications/${id}/read`, { method: 'POST' });
      return true;
    } catch {
      return false;
    }
  }

  async markAllNotificationsRead(): Promise<number> {
    const res = await this.request<{ updated: number } | { data: { updated: number } }>('/notifications/read-all', { method: 'POST' });
    return (res as any)?.updated ?? (res as any)?.data?.updated ?? 0;
  }

  async getNotificationPreferences(): Promise<NotificationPreference[]> {
    return this.request<NotificationPreference[]>('/notifications/preferences');
  }

  async setNotificationPreference(
    category: NotificationCategory,
    updates: Partial<Pick<NotificationPreference, 'inApp' | 'push' | 'email'>>,
  ): Promise<NotificationPreference> {
    return this.request<NotificationPreference>(`/notifications/preferences/${category}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  private async doRefresh(): Promise<boolean> {
    try {
      const refreshToken = localStorage.getItem('fapoms_refresh_token');
      if (!refreshToken) return false;

      /**
       * The refresh gets a timeout of its own because it is the one request everything else
       * queues behind: `refreshPromise` is shared, so a refresh that never settles leaves every
       * 401'd call in the app awaiting it forever, and the session neither recovers nor ends.
       */
      const refreshController = new AbortController();
      const refreshTimer = setTimeout(() => refreshController.abort(), DEFAULT_TIMEOUT_MS);
      let refreshResponse: Response;
      try {
        refreshResponse = await fetch('/api/v1/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
          signal: refreshController.signal,
        });
      } finally {
        clearTimeout(refreshTimer);
      }

      if (refreshResponse.ok) {
        const refreshData = await refreshResponse.json();
        if (refreshData.success && refreshData.data?.accessToken) {
          localStorage.setItem('fapoms_token', refreshData.data.accessToken);
          if (refreshData.data.refreshToken) {
            localStorage.setItem('fapoms_refresh_token', refreshData.data.refreshToken);
          }
          return true;
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      this.refreshPromise = null;
    }
  }
}

export const api = new ApiClient();
