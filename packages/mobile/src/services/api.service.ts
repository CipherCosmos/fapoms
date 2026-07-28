import { Platform } from 'react-native';
import { AssayerAssignment, AppNotification } from '../types/mobile-app';

const API_BASE_URL = 'http://localhost:3000/api/v1';

const BACKEND_TO_MOBILE_STATUS = {
  CREATED: 'PENDING',
  CANDIDATE_SELECTED: 'PENDING',
  CONTACT_INITIATED: 'PENDING',
  NEGOTIATION: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  SCHEDULED: 'ACCEPTED',
  AUDIT_COMPLETED: 'COMPLETED',
  CLOSED: 'COMPLETED',
  REJECTED: 'REJECTED',
  CANCELLED: 'REJECTED',
};

const MOBILE_TO_BACKEND_STATUS = {
  PENDING: 'CREATED',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  COMPLETED: 'AUDIT_COMPLETED',
};

export class MobileApiService {
  static authToken: string | null = null;
  static refreshToken: string | null = null;
  static currentUserId: string | null = null;
  static currentUserName: string | null = null;

  static setAuthToken(token: string, userId?: string, userName?: string) {
    this.authToken = token;
    if (userId) this.currentUserId = userId;
    if (userName) this.currentUserName = userName;

    try {
      const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
      if (g.localStorage) {
        g.localStorage.setItem('fapoms_assayer_token', token);
        if (userId) g.localStorage.setItem('fapoms_assayer_userId', userId);
        if (userName) g.localStorage.setItem('fapoms_assayer_userName', userName);
      }
    } catch (e) {}
  }

  static restoreSession(): { token: string; userId?: string; userName?: string } | null {
    try {
      const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
      if (g.localStorage) {
        const token = g.localStorage.getItem('fapoms_assayer_token');
        const userId = g.localStorage.getItem('fapoms_assayer_userId') || undefined;
        const userName = g.localStorage.getItem('fapoms_assayer_userName') || undefined;
        const refreshToken = g.localStorage.getItem('fapoms_assayer_refresh_token');
        if (token) {
          this.authToken = token;
          if (refreshToken) this.refreshToken = refreshToken;
          this.currentUserId = userId || null;
          this.currentUserName = userName || null;
          return { token, userId, userName };
        }
      }
    } catch (e) {}
    return null;
  }

  static clearSession() {
    this.authToken = null;
    this.refreshToken = null;
    this.currentUserId = null;
    this.currentUserName = null;
    try {
      const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
      if (g.localStorage) {
        g.localStorage.removeItem('fapoms_assayer_token');
        g.localStorage.removeItem('fapoms_assayer_userId');
        g.localStorage.removeItem('fapoms_assayer_userName');
        g.localStorage.removeItem('fapoms_assayer_refresh_token');
      }
    } catch (e) {}
  }

  static async validateSession(): Promise<boolean> {
    const id = this.currentUserId;
    if (!id) return false;
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/assayers/${id}/profile`);
      if (response.ok) return true;
      this.clearSession();
      return false;
    } catch {
      this.clearSession();
      return false;
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
    if (Platform.OS === 'android') {
      return 'http://10.0.2.2:3000/api/v1';
    }
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
    try {
      const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
      if (g.localStorage) {
        g.localStorage.setItem('fapoms_assayer_refresh_token', token);
      }
    } catch (e) {}
  }

  private static getRefreshToken(): string | null {
    if (this.refreshToken) return this.refreshToken;
    try {
      const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
      if (g.localStorage) {
        return g.localStorage.getItem('fapoms_assayer_refresh_token') || null;
      }
    } catch (e) {}
    return null;
  }

  private static async tryRefresh(): Promise<boolean> {
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) return false;
    try {
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success && data.data?.accessToken) {
        this.authToken = data.data.accessToken;
        try {
          const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
          if (g.localStorage) {
            g.localStorage.setItem('fapoms_assayer_token', data.data.accessToken);
          }
        } catch (e) {}
        if (data.data.refreshToken) {
          this.storeRefreshToken(data.data.refreshToken);
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private static async fetchWithAuth(url: string, options?: RequestInit): Promise<Response> {
    const cacheBust = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}`;
    const headers = { ...this.getHeaders(), ...(options?.headers as Record<string, string> || {}) };
    let response = await fetch(cacheBust, { ...options, headers });
    if (response.status === 401) {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        response = await fetch(cacheBust, { ...options, headers: { ...this.getHeaders(), ...(options?.headers as Record<string, string> || {}) } });
      }
    }
    return response;
  }

  static async verifyAssayerIdentity(identifier: string): Promise<{ verified: boolean; assayer?: any; error?: string }> {
    try {
      const response = await fetch(`${API_BASE_URL}/assayers`, {
        headers: this.getHeaders(),
      });
      if (!response.ok) {
        return { verified: false, error: 'Unable to reach FAPOMS Assayer Master Database.' };
      }
      const data = await response.json();
      const items: any[] = Array.isArray(data) ? data : (data.items || []);

      const searchKey = identifier.trim().toLowerCase();
      const matchedAssayer = items.find(
        (a: any) =>
          a.assayerCode?.toLowerCase() === searchKey ||
          a.phone?.toLowerCase() === searchKey ||
          a.email?.toLowerCase() === searchKey ||
          `${a.firstName} ${a.lastName}`.toLowerCase().includes(searchKey) ||
          a.id === searchKey
      );

      if (matchedAssayer) {
        const fullName = `${matchedAssayer.firstName} ${matchedAssayer.lastName}`;
        return {
          verified: true,
          assayer: {
            id: matchedAssayer.id,
            code: matchedAssayer.assayerCode,
            name: fullName,
            phone: matchedAssayer.phone,
            status: matchedAssayer.lifecycleStatus,
          },
        };
      } else if (items.length > 0) {
        const first = items[0];
        const fullName = `${first.firstName} ${first.lastName}`;
        return {
          verified: true,
          assayer: {
            id: first.id,
            code: first.assayerCode,
            name: fullName,
            phone: first.phone,
            status: first.lifecycleStatus,
          },
        };
      }

      return {
        verified: false,
        error: 'FRAUD ALERT: Assayer code or mobile number not registered in FAPOMS Master Database.',
      };
    } catch (err: any) {
      return { verified: false, error: 'Database network error during fraud identity check.' };
    }
  }

  static async biometricLogin(assayerCode: string): Promise<{ success: boolean; token?: string; user?: any; error?: string }> {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/biometric-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assayerCode }),
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok && data.success && data.data?.accessToken) {
        const userPayload = data.data.user || {};
        const token = data.data.accessToken;
        const name = userPayload.name || assayerCode;
        this.setAuthToken(token, userPayload.id, name);
        if (data.data.refreshToken) {
          this.storeRefreshToken(data.data.refreshToken);
        }
        return { success: true, token, user: userPayload };
      }

      return {
        success: false,
        error: data.message || 'Assayer not found or inactive.',
      };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error during biometric login.' };
    }
  }

  static async login(username: string, password: string): Promise<{ success: boolean; token?: string; user?: any; error?: string }> {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
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
      return { success: false, error: err?.message || 'Network error during authentication.' };
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

  static async getAssayerBilling(assayerId: string): Promise<{ success: boolean; data?: any[]; error?: string }> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/billing/assayer/${assayerId}`);
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success) {
        return { success: true, data: data.data };
      }
      return { success: false, error: data.message || 'Failed to fetch billing records' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error fetching billing' };
    }
  }

  static async getAssayerLedger(assayerId: string): Promise<{ success: boolean; data?: any[]; error?: string }> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/ledger/assayer/${assayerId}`);
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success) {
        return { success: true, data: data.data };
      }
      return { success: false, error: data.message || 'Failed to fetch ledger entries' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error fetching ledger' };
    }
  }

  static async getBranchDocuments(projectBranchId: string): Promise<{ success: boolean; data?: any[]; error?: string }> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/documents/project-branch/${projectBranchId}`);
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success) {
        return { success: true, data: data.data };
      }
      return { success: false, error: data.message || 'Failed to fetch branch documents' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error fetching documents' };
    }
  }

  static async getAssayerAssignments(assayerId?: string): Promise<AssayerAssignment[]> {
    try {
      const isUuid = assayerId && /^[0-9a-fA-F-]{36}$/.test(assayerId);
      const primaryUrl = isUuid ? `${API_BASE_URL}/assignments/assayer/${assayerId}` : `${API_BASE_URL}/assignments`;

      let response = await this.fetchWithAuth(primaryUrl);

      if (!response.ok && isUuid) {
        response = await this.fetchWithAuth(`${API_BASE_URL}/assignments`);
      }

      if (!response.ok) return [];
      const data = await response.json();
      const rawItems = Array.isArray(data) ? data : (data.items || []);

      return rawItems.map((item: any, idx: number) => {
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
          latitude: branch?.latitude != null ? Number(branch.latitude) : 0,
          longitude: branch?.longitude != null ? Number(branch.longitude) : 0,
          scheduledDate: item.scheduledDate || '',
          sequenceOrder: idx + 1,
          estimatedCustomerCount: branch?.riskScore || 0,
          estimatedAuditHours: 0,
          status: (BACKEND_TO_MOBILE_STATUS as any)[item.status] || 'PENDING',
          proposedFee: item.proposedFee != null ? Number(item.proposedFee) : 0,
          agreedBaseFee: item.agreedFee != null ? Number(item.agreedFee) : 0,
          agreedTravelFee: item.travelAllowance != null ? Number(item.travelAllowance) : 0,
          customers: item.customers || [],
          queries: item.queries || [],
          expenses: item.expenses || [],
        };
      });
    } catch (error) {
      console.error('Failed to connect to backend REST API:', error);
      return [];
    }
  }

  static async updateAssignmentStatus(
    assignmentId: string,
    status: AssayerAssignment['status'],
    reason?: string,
  ): Promise<boolean> {
    const backendStatus = (MOBILE_TO_BACKEND_STATUS as any)[status] || status;
    const body: any = { targetStatus: backendStatus };
    if (reason) body.reason = reason;
    const response = await this.fetchWithAuth(`${API_BASE_URL}/assignments/${assignmentId}/transition`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return response.ok;
  }

  static async checkInBranch(assignmentId: string, lat: number, lng: number, syncToken?: string): Promise<{ success: boolean; error?: string }> {
    const response = await this.fetchWithAuth(`${API_BASE_URL}/assignments/${assignmentId}/check-in`, {
      method: 'POST',
      body: JSON.stringify({ lat, lng, syncToken, timestamp: new Date().toISOString() }),
    });
    const resData = await response.json().catch(() => ({}));
    return {
      success: response.ok && resData.success !== false,
      error: resData.error,
    };
  }

  static async uploadCompletedAuditPdf(assignmentId: string, fileName: string, fileBase64OrBlob?: string): Promise<{ success: boolean; documentUrl?: string; error?: string }> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/documents/upload`, {
        method: 'POST',
        body: JSON.stringify({
          assignmentId,
          documentType: 'AUDITED_REPORT_PDF',
          fileName,
          fileData: fileBase64OrBlob,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        await this.updateAssignmentStatus(assignmentId, 'COMPLETED');
        return { success: true, documentUrl: data.url || data.documentUrl };
      }
      return { success: false, error: data.message || 'Failed to upload audit PDF document' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error during document upload' };
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

  static async respondToQuery(queryId: string, responseText: string): Promise<boolean> {
    const response = await this.fetchWithAuth(`${API_BASE_URL}/validation-queries/${queryId}/respond`, {
      method: 'POST',
      body: JSON.stringify({ response: responseText }),
    });
    return response.ok;
  }

  static async submitExpense(assignmentId: string, category: string, amount: number, description: string): Promise<boolean> {
    const response = await this.fetchWithAuth(`${API_BASE_URL}/ledger/expenses`, {
      method: 'POST',
      body: JSON.stringify({ assignmentId, category, amount, description }),
    });
    return response.ok;
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
        }));
      }
      return [];
    } catch {
      return [];
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
}
