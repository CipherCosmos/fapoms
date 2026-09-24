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

/**
 * The words the compliance register shows. The panel printed the stored codes as they came —
 * `IN_PROGRESS`, `AWAITING_INFO`, `UNAUTHORISED_ACCESS` — beside plain-English copy everywhere
 * else. Every code the backend can send has a word here; anything newer falls back to sentence
 * case rather than the raw code.
 */
const COMPLIANCE_WORDS: Record<string, string> = {
  // incident + rights-request statuses
  OPEN: 'Open', INVESTIGATING: 'Investigating', CONTAINED: 'Contained', RESOLVED: 'Resolved', CLOSED: 'Closed',
  RECEIVED: 'Received', IN_PROGRESS: 'In progress', AWAITING_INFO: 'Waiting for information',
  COMPLETED: 'Completed', REJECTED: 'Rejected',
  // incident categories
  UNAUTHORISED_ACCESS: 'Unauthorised access', DATA_BREACH: 'Data breach', MALWARE: 'Malware',
  DOS: 'Denial of service', PHISHING: 'Phishing', SYSTEM_COMPROMISE: 'System compromise',
  IDENTITY_THEFT: 'Identity theft', OTHER: 'Other',
  // severities
  LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical',
  // rights-request types
  ACCESS: 'Access to data', CORRECTION: 'Correction', ERASURE: 'Erasure', GRIEVANCE: 'Grievance',
  NOMINATION: 'Nomination',
};

export function complianceLabel(code?: string | null): string {
  if (!code) return '—';
  const known = COMPLIANCE_WORDS[code];
  if (known) return known;
  const words = code.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

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
