import { api } from './api';

export interface IncidentClock {
  applicable: boolean;
  dueAt: string | null;
  hoursRemaining: number | null;
  satisfied: boolean;
  overdue: boolean;
}

export interface SecurityIncident {
  id: string;
  title: string;
  category: string;
  severity: string;
  status: string;
  description: string | null;
  detectedAt: string;
  personalDataInvolved: boolean;
  affectedDataPrincipals: number | null;
  certInReportedAt: string | null;
  boardNotifiedAt: string | null;
  principalsNotifiedAt: string | null;
  remediation: string | null;
  resolvedAt: string | null;
  // dpdpBoard: the real, fixed 72-hour DPDP clock (Board breach report). dpdpPrincipals: "without
  // delay" — DPDP sets no fixed hour count for notifying Data Principals, so that clock never carries
  // a dueAt/hoursRemaining or an `overdue` of its own; see incident-clocks.ts on the backend.
  clocks: { certIn: IncidentClock; dpdpBoard: IncidentClock; dpdpPrincipals: IncidentClock };
}

export interface ComplianceHealth {
  auditUnsealed: number;
  incidents: {
    total: number; open: number; certInOverdue: number; boardOverdue: number; principalsOverdue: number;
  };
  rightsRequests: { open: number; overdue: number };
}

export interface SlaClock {
  dueAt: string;
  daysRemaining: number | null;
  satisfied: boolean;
  overdue: boolean;
}

export interface RightsRequest {
  id: string;
  requestType: string;
  subjectType: string;
  subjectRef: string | null;
  requesterName: string | null;
  requesterContact: string | null;
  details: string | null;
  status: string;
  receivedAt: string;
  completedAt: string | null;
  legalHoldApplied: boolean;
  resolutionNotes: string | null;
  sla: SlaClock;
}

export const RIGHTS_REQUEST_TYPES = ['ACCESS', 'CORRECTION', 'ERASURE', 'GRIEVANCE', 'NOMINATION'];
export const RIGHTS_REQUEST_STATUSES = ['RECEIVED', 'IN_PROGRESS', 'AWAITING_INFO', 'COMPLETED', 'REJECTED'];

export const INCIDENT_CATEGORIES = [
  'UNAUTHORISED_ACCESS', 'DATA_BREACH', 'MALWARE', 'DOS', 'PHISHING',
  'SYSTEM_COMPROMISE', 'IDENTITY_THEFT', 'OTHER',
];
export const INCIDENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export const getComplianceHealth = () => api.request<ComplianceHealth>('/admin/compliance/health');
export const listIncidents = () => api.request<SecurityIncident[]>('/admin/compliance/incidents');

export const raiseIncident = (body: {
  title: string; category: string; severity: string;
  description?: string; personalDataInvolved?: boolean; affectedDataPrincipals?: number | null;
}) => api.request<SecurityIncident>('/admin/compliance/incidents', { method: 'POST', body: JSON.stringify(body) });

export const updateIncident = (id: string, body: Record<string, unknown>) =>
  api.request<SecurityIncident>(`/admin/compliance/incidents/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

export const listRightsRequests = () => api.request<RightsRequest[]>('/admin/compliance/rights-requests');

export const logRightsRequest = (body: {
  requestType: string; subjectType?: string; subjectRef?: string;
  requesterName?: string; requesterContact?: string; details?: string;
}) => api.request<RightsRequest>('/admin/compliance/rights-requests', { method: 'POST', body: JSON.stringify(body) });

export const updateRightsRequest = (id: string, body: Record<string, unknown>) =>
  api.request<RightsRequest>(`/admin/compliance/rights-requests/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
