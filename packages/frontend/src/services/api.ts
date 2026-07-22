class ApiClient {
  private isRefreshing = false;

  /**
   * Wrapper for API requests. Enforces direct calls to backend REST API.
   * Features automatic JWT token refresh.
   */
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
      const refreshToken = localStorage.getItem('fapoms_refresh_token');
      if (refreshToken && !this.isRefreshing) {
        this.isRefreshing = true;
        try {
          const refreshResponse = await fetch('/api/v1/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken }),
          });

          if (refreshResponse.ok) {
            const refreshData = await refreshResponse.json();
            if (refreshData.success && refreshData.data?.accessToken) {
              const newAccessToken = refreshData.data.accessToken;
              const newRefreshToken = refreshData.data.refreshToken;
              localStorage.setItem('fapoms_token', newAccessToken);
              if (newRefreshToken) {
                localStorage.setItem('fapoms_refresh_token', newRefreshToken);
              }
              this.isRefreshing = false;

              // Retry the original request with the new token
              const retryHeaders = {
                ...headers,
                Authorization: `Bearer ${newAccessToken}`,
              };
              response = await fetch(`/api/v1${endpoint}`, {
                ...options,
                headers: retryHeaders,
              });
            }
          }
        } catch (refreshErr) {
          console.error('Token refresh failed', refreshErr);
        } finally {
          this.isRefreshing = false;
        }
      }

      // If retry failed or no refresh token, reset session
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
}

export const api = new ApiClient();
