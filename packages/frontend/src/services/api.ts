class ApiClient {
  private refreshPromise: Promise<boolean> | null = null;

  async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    let token = localStorage.getItem('fapoms_token');
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers || {}),
    };

    let response = await fetch(`/api/v1${endpoint}`, {
      ...options,
      headers,
    });

    if (response.status === 401 || response.status === 403) {
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
        response = await fetch(`/api/v1${endpoint}`, {
          ...options,
          headers: retryHeaders,
        });
      }

      if (response.status === 401 || response.status === 403) {
        localStorage.removeItem('fapoms_token');
        localStorage.removeItem('fapoms_refresh_token');
        window.location.href = '/login';
        throw new Error('Unauthorized');
      }
    }

    if (response.ok) {
      const res = await response.json();
      return res.data as T;
    }

    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || `API Endpoint ${endpoint} returned status ${response.status}`);
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
