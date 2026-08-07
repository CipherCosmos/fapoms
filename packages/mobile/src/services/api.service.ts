import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import Constants from 'expo-constants';
import { AssayerAssignment, AppNotification } from '../types/mobile-app';
import {
  getDefaultServerUrl,
  loadStoredServerUrl,
  saveServerUrl,
  clearServerUrl,
  normaliseServerUrl,
} from './server-config';

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

const BACKEND_TO_MOBILE_STATUS: Record<string, string> = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  CHECKED_IN: 'CHECKED_IN',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
};

const MOBILE_TO_BACKEND_STATUS: Record<string, string> = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  CHECKED_IN: 'CHECKED_IN',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
};
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

  /** Returns the API origin URL (e.g., http://localhost:3000) for resolving relative attachment URLs */
  static getApiOrigin(): string {
    // API_BASE_URL is like http://localhost:3000/api/v1 — strip /api/v1 suffix
    return API_BASE_URL.replace(/\/api\/v1$/, '');
  }

  /** Resolves a relative attachment URL to a full authenticated URL carrying the auth token */
  static resolveAttachmentUrl(url: string | null | undefined): string {
    if (!url) return '';
    if (url.startsWith('data:')) return url;
    let fullUrl = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      fullUrl = `${this.getApiOrigin()}${url.startsWith('/') ? '' : '/'}${url}`;
    }
    if (this.authToken && !fullUrl.includes('token=')) {
      const separator = fullUrl.includes('?') ? '&' : '?';
      fullUrl = `${fullUrl}${separator}token=${encodeURIComponent(this.authToken)}`;
    }
    return fullUrl;
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
    if (!id || !this.authToken) return false;
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/assayers/${id}/profile`, {}, 5000);
      if (response.ok) return true;
      this.clearSession();
      return false;
    } catch {
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

  static async tryRefresh(): Promise<boolean> {
    // Join an already-running refresh instead of starting a second one that
    // would race the first for the same single-use token.
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh().finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  private static async doRefresh(): Promise<boolean> {
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
      // The refresh token itself was rejected (expired, already rotated away by
      // a concurrent call that lost this race anyway, or revoked) — the session
      // is genuinely over, so stop holding tokens that will only keep failing.
      this.clearSession();
      return false;
    } catch {
      return false;
    }
  }

  static async fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 3000): Promise<Response> {
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

  static async fetchWithAuth(url: string, options?: RequestInit, timeoutMs = 3000): Promise<Response> {
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
      const response = await fetch(`${API_BASE_URL}/auth/verify-assayer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        return { verified: false, error: data?.message || 'Unable to reach FAPOMS.' };
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
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) {
      return { success: false, error: 'No saved session found. Please sign in with your Assayer Code and password first.' };
    }

    try {
      const response = await fetch(`${API_BASE_URL}/auth/biometric-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
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
      return { success: false, error: err?.message || 'Network error connecting to server.' };
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

  static async updateAssayerProfile(assayerId: string, profileData: any): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/assayers/${assayerId}/profile`, {
        method: 'PUT',
        body: JSON.stringify(profileData),
      });
      const data = await response.json().catch(() => ({}));
      return { success: response.ok && data?.success !== false, error: data?.message };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error updating profile' };
    }
  }

  static async rejectAssignment(assignmentId: string, reason: string): Promise<{ success: boolean; error?: string }> {
    const ok = await this.updateAssignmentStatus(assignmentId, 'REJECTED', reason);
    return { success: ok, error: ok ? undefined : 'Failed to reject assignment' };
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

  static async getAssayerBillingEngineEntries(assayerId: string): Promise<{ success: boolean; data?: any[]; error?: string }> {
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/billing-engine/entries?assayerId=${assayerId}`);
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success) {
        return { success: true, data: data.data };
      }
      return { success: false, error: data.message || 'Failed to fetch billing entries' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error fetching billing entries' };
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

  static async getAssayerAssignments(assayerId?: string): Promise<AssayerAssignment[]> {
    try {
      if (!assayerId) return [];
      const response = await this.fetchWithAuth(`${API_BASE_URL}/assignments/assayer/${assayerId}`);
      if (!response.ok) return [];
      const data = await response.json();
      const rawItems = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : (data?.items || []));

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
          estimatedAuditHours: branch?.estimatedDurationHours != null ? Number(branch.estimatedDurationHours) : 0,
          status: (BACKEND_TO_MOBILE_STATUS as any)[item.status] || 'PENDING',
          proposedFee: item.proposedFee != null ? Number(item.proposedFee) : 0,
          standardBaseFee: item.currentStandardBaseFee != null ? Number(item.currentStandardBaseFee) : 1200,
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
    const backendStatus = counterFee !== undefined ? 'COUNTER_OFFER' : ((MOBILE_TO_BACKEND_STATUS as any)[status] || status);
    const body: any = { targetStatus: backendStatus };
    if (reason) body.reason = reason;
    if (counterFee !== undefined) {
      body.fee = counterFee;
      body.counterFee = counterFee;
      body.proposedFee = counterFee;
    }
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
      error: resData.error,
    };
  }

  static async updateLiveLocation(lat: number, lng: number): Promise<boolean> {
    const id = this.currentUserId;
    if (!id) return false;
    try {
      const response = await this.fetchWithAuth(`${API_BASE_URL}/assayers/${id}/live-location`, {
        method: 'PUT',
        body: JSON.stringify({ latitude: lat, longitude: lng }),
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
