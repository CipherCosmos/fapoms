import { api } from './api';

/**
 * Customer-master version governance.
 *
 * The client sends customer data per audit date; the backend reconciles it against the branch
 * master (DRAFT → RECONCILED) and a version must be APPROVED before its branch PDFs generate.
 * Upload + daily-run are already wired (DailyRunPanel); this surfaces the missing governance
 * side — version history, the records inside a version, and the approval gate itself.
 */

// Single source of truth is the shared enum; kept as a type alias so the status style map and version
// interface below track any change there instead of silently drifting from a hand-copied union.
export type CustomerMasterStatus = import('@fapoms/shared').CustomerMasterStatus;

export interface CustomerMasterVersion {
  id: string;
  projectId: string;
  versionNumber: number;
  auditDate: string | null;
  fileName: string;
  totalRows: number;
  uniqueAccounts: number;
  duplicateAccounts: number;
  status: CustomerMasterStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface CustomerRecord {
  id: string;
  branchId: string | null;
  accountNumber: string;
  customerName: string;
  packetCount: number;
  declaredWeightGrams: number | null;
  branch?: { id: string; branchCode?: string; name?: string } | null;
}

/** Version history for a project mandate, newest version first. */
export const getVersions = (projectId: string) =>
  api.request<CustomerMasterVersion[]>(`/customer-master/projects/${projectId}/versions`);

/**
 * Approve a RECONCILED version. The backend supersedes the previously-approved version in the
 * same transaction, so exactly one version is ever active for a project.
 */
export const approveVersion = (versionId: string) =>
  api.request<CustomerMasterVersion>(`/customer-master/versions/${versionId}/approve`, {
    method: 'POST',
  });

/** Paginated customer records inside a version, optionally filtered by branch. */
export const getVersionRecords = (versionId: string, page = 1, limit = 50, branchId?: string) => {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (branchId) params.set('branchId', branchId);
  return api.request<{ data: CustomerRecord[]; meta: { total: number; page: number; limit: number } }>(
    `/customer-master/versions/${versionId}/records?${params.toString()}`,
    { withMeta: true },
  );
};

export const CUSTOMER_MASTER_STATUS_STYLE: Record<
  CustomerMasterStatus,
  { label: string; color: string; bg: string }
> = {
  DRAFT: { label: 'Draft', color: 'var(--text-muted)', bg: 'rgba(148,163,184,0.15)' },
  RECONCILED: { label: 'Reconciled — awaiting approval', color: 'var(--accent)', bg: 'rgba(216,174,71,0.14)' },
  APPROVED: { label: 'Approved', color: 'var(--success, #16a34a)', bg: 'var(--status-active-bg, rgba(22,163,74,0.12))' },
  SUPERSEDED: { label: 'Superseded', color: 'var(--text-muted)', bg: 'rgba(148,163,184,0.15)' },
  REJECTED: { label: 'Rejected', color: 'var(--danger, #dc2626)', bg: 'var(--status-cancelled-bg, rgba(220,38,38,0.12))' },
};
