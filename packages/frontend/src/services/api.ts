import { fromNetwork, fromResponse } from './errors';

export type NotificationCategory =
  | 'ASSIGNMENT' | 'VALIDATION' | 'DOCUMENT' | 'PLANNING' | 'WORKFORCE' | 'BILLING' | 'SYSTEM';
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

  async request<T>(endpoint: string, options?: RequestInit & { raw?: boolean; withMeta?: boolean }): Promise<T> {
    let token = localStorage.getItem('fapoms_token');
    const headers: Record<string, string> = {
      ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers as Record<string, string> || {}),
    };

    // A dropped connection previously surfaced as a raw `TypeError: Failed to
    // fetch`, which reads as a crash. Offline is a normal condition for field
    // staff on mobile data, not an error state to panic about.
    let response: Response;
    try {
      response = await fetch(`/api/v1${endpoint}`, { ...options, headers });
    } catch (netErr) {
      const appErr = fromNetwork(netErr);
      console.error(`[api] ${options?.method ?? 'GET'} ${endpoint} -> network:`, appErr.technical);
      throw appErr;
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
          response = await fetch(`/api/v1${endpoint}`, { ...options, headers: retryHeaders });
        } catch (netErr) {
          throw fromNetwork(netErr);
        }
      }

      if (response.status === 401) {
        localStorage.removeItem('fapoms_token');
        localStorage.removeItem('fapoms_refresh_token');
        localStorage.removeItem('fapoms_user_cache');
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

    const res = await response.json();
    if ((options as any)?.withMeta) {
      return res as T;
    }
    return res.data as T;
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

      const refreshResponse = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

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
