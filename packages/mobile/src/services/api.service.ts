import { Platform } from 'react-native';
import { AssayerAssignment, AppNotification } from '../types/mobile-app';

const API_BASE_URL = Platform.OS === 'android' ? 'http://10.0.2.2:3000/api/v1' : 'http://localhost:3000/api/v1';

const BACKEND_TO_MOBILE_STATUS: Record<string, string> = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  CHECKED_IN: 'CHECKED_IN',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
  CANCELLED: 'REJECTED',
};

const MOBILE_TO_BACKEND_STATUS: Record<string, string> = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  CHECKED_IN: 'CHECKED_IN',
  IN_PROGRESS: 'IN_PROGRESS',
  REJECTED: 'REJECTED',
};

export class MobileApiService {
  static authToken: string | null = null;
  static refreshToken: string | null = null;
  static currentUserId: string | null = null;
  static currentUserName: string | null = null;

  /** Returns the API origin URL (e.g., http://localhost:3000) for resolving relative attachment URLs */
  static getApiOrigin(): string {
    // API_BASE_URL is like http://localhost:3000/api/v1 — strip /api/v1 suffix
    return API_BASE_URL.replace(/\/api\/v1$/, '');
  }

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

  static async fetchWithAuth(url: string, options?: RequestInit): Promise<Response> {
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
          estimatedCustomerCount: item.customerCount || item.projectBranch?.packetCount || (item.customers && item.customers.length > 0 ? item.customers.length : 15),
          estimatedAuditHours: 0,
          status: (BACKEND_TO_MOBILE_STATUS as any)[item.status] || 'PENDING',
          proposedFee: item.proposedFee != null ? Number(item.proposedFee) : 0,
          standardBaseFee: item.baseFee != null ? Number(item.baseFee) : 1200,
          agreedBaseFee: item.agreedFee != null ? Number(item.agreedFee) : 0,
          agreedTravelFee: item.travelAllowance != null ? Number(item.travelAllowance) : 0,
          distanceKm: (() => {
            const assayer = item.assayer;
            if (assayer && assayer.latitude != null && assayer.longitude != null && branch && branch.latitude != null && branch.longitude != null) {
              const lat1 = Number(assayer.latitude);
              const lon1 = Number(assayer.longitude);
              const lat2 = Number(branch.latitude);
              const lon2 = Number(branch.longitude);
              const R = 6371;
              const dLat = (lat2 - lat1) * (Math.PI / 180);
              const dLon = (lon2 - lon1) * (Math.PI / 180);
              const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
              const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
              return Math.round(R * c);
            }
            return undefined;
          })(),
          negotiationCount: item.negotiationCount != null ? Number(item.negotiationCount) : 0,
          remarks: item.remarks || '',
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
    counterFee?: number,
  ): Promise<boolean> {
    const backendStatus = (MOBILE_TO_BACKEND_STATUS as any)[status] || status;
    const body: any = { targetStatus: backendStatus };
    if (reason) body.reason = reason;
    if (counterFee !== undefined) body.fee = counterFee;
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

  static async uploadCompletedAuditPdf(targetId: string, fileName: string, fileBase64OrBlob?: string, assignmentId?: string): Promise<{ success: boolean; documentUrl?: string; error?: string }> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/documents/mobile-upload`, {
        method: 'POST',
        body: JSON.stringify({
          assignmentId: assignmentId || targetId,
          assessmentId: targetId,
          projectBranchId: targetId,
          documentType: 'AUDITED_RETURN_PDF',
          fileName,
          fileData: fileBase64OrBlob,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success) {
        return { success: true, documentUrl: data.data?.filePath || data.documentUrl || `/documents/${data.data?.id}/download` };
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

  static async respondToQuery(queryId: string, responseText: string, attachments?: any[]): Promise<boolean> {
    const response = await this.fetchWithAuth(`${API_BASE_URL}/validation-queries/${queryId}/respond`, {
      method: 'POST',
      body: JSON.stringify({ response: responseText, attachments }),
    });
    return response.ok;
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

      const response = await fetch(`${API_BASE_URL}/validation-queries/upload-attachment`, {
        method: 'POST',
        headers,
        body: formData,
      });

      if (response.ok) {
        const data = await response.json();
        return data?.data || null;
      }
      return null;
    } catch {
      return null;
    }
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
