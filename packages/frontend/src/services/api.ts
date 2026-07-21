class ApiClient {
  /**
   * Wrapper for API requests. Enforces direct calls to backend REST API.
   * There are no mock modes or offline fallbacks allowed.
   */
  async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const token = localStorage.getItem('fapoms_token');
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers || {}),
    };

    const response = await fetch(`/api/v1${endpoint}`, {
      ...options,
      headers,
    });

    if (response.status === 401 || response.status === 403) {
      // Automatic session reset on token expiration
      localStorage.removeItem('fapoms_token');
      window.location.href = '/login';
      throw new Error('Unauthorized');
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
