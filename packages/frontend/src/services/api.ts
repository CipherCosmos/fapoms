/**
 * FAPOMS — Frontend API Client & Mock/Live Mode Controller
 *
 * Dynamically checks backend health and database connectivity.
 * If backend/DB is offline, falls back to mock UAT sandbox data
 * so UAT runs correctly in any environment.
 */

import { ProjectStatus, Priority } from '@fapoms/shared';

class ApiClient {
  private isLiveMode = false;
  private statusListeners: Array<(isLive: boolean) => void> = [];

  constructor() {
    this.checkStatus();
  }

  get isLive(): boolean {
    return this.isLiveMode;
  }

  // Subscribe to status changes (e.g. Header mode badge)
  subscribe(listener: (isLive: boolean) => void) {
    this.statusListeners.push(listener);
    listener(this.isLiveMode);
    return () => {
      this.statusListeners = this.statusListeners.filter(l => l !== listener);
    };
  }

  private notifyListeners() {
    this.statusListeners.forEach(listener => listener(this.isLiveMode));
  }

  /**
   * Check connection status to NestJS backend
   */
  async checkStatus(): Promise<boolean> {
    try {
      const response = await fetch('/api/v1/auth/status');
      if (response.ok) {
        const res = await response.json();
        // Backend responds and TypeORM DB connection is up
        this.isLiveMode = res.success && res.data?.status === 'online';
      } else {
        this.isLiveMode = false;
      }
    } catch (err) {
      this.isLiveMode = false;
    }
    this.notifyListeners();
    return this.isLiveMode;
  }

  /**
   * Wrapper for API requests. Falls back to mock values if offline.
   */
  async request<T>(endpoint: string, options?: RequestInit, mockFallback?: T): Promise<T> {
    if (this.isLiveMode) {
      try {
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
      } catch (err) {
        console.warn(`Live API ${endpoint} failed. Using mock fallback.`, err);
      }
    }

    // Fall back to mocks
    if (mockFallback !== undefined) {
      return Promise.resolve(mockFallback);
    }
    throw new Error(`API Endpoint ${endpoint} unreachable and no fallback provided.`);
  }

  // -------------------------------------------------------------------------
  // Mocks Data Store
  // -------------------------------------------------------------------------

  getMockProjects() {
    return [
      { id: 'PROJ-001', name: 'Axis Bank July Cycle', client: 'Axis Bank', branches: 45, coverage: 95.5, status: ProjectStatus.EXECUTION, priority: Priority.HIGH, date: '2026-07-01' },
      { id: 'PROJ-002', name: 'ICICI Bank West Zone', client: 'ICICI Bank', branches: 60, coverage: 90.0, status: ProjectStatus.SCHEDULING, priority: Priority.MEDIUM, date: '2026-07-05' },
      { id: 'PROJ-003', name: 'RBL Rural Coverage', client: 'RBL Bank', branches: 37, coverage: 86.4, status: ProjectStatus.PLANNING, priority: Priority.LOW, date: '2026-07-08' },
      { id: 'PROJ-004', name: 'HDFC North Urban', client: 'HDFC Bank', branches: 82, coverage: 0.0, status: ProjectStatus.DRAFT, priority: Priority.CRITICAL, date: '2026-07-15' },
    ];
  }

  getMockBranches() {
    return [
      { code: 'BR-0010', solId: '1029', name: 'Pune Main Branch', city: 'Pune', state: 'Maharashtra', district: 'Pune', pin: '411001' },
      { code: 'BR-0011', solId: '1043', name: 'Pimpri Branch', city: 'Pune', state: 'Maharashtra', district: 'Pune', pin: '411018' },
      { code: 'BR-0012', solId: '1105', name: 'Mumbai Fort Branch', city: 'Mumbai', state: 'Maharashtra', district: 'Mumbai', pin: '400001' },
      { code: 'BR-0020', solId: '2055', name: 'Ahmedabad Navrangpura', city: 'Ahmedabad', state: 'Gujarat', district: 'Ahmedabad', pin: '380001' },
      { code: 'BR-0030', solId: '3049', name: 'Bangalore MG Road', city: 'Bangalore', state: 'Karnataka', district: 'Bangalore Urban', pin: '560001' },
    ];
  }

  getMockStates() {
    return ['Maharashtra', 'Gujarat', 'Karnataka'];
  }
}

export const api = new ApiClient();
