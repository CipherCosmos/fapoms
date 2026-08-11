import type { CSSProperties } from 'react';
import { AssayerLifecycleStatus, formatRupees } from '@fapoms/shared';

/** Shared shape and colours for the workforce record, used by the roster and its forms. */

export interface Assayer {
  id: string;
  assayerCode: string;
  employeeId: string | null;
  employeeCode: string | null;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string | null;
  phone: string;
  alternatePhone: string | null;
  address: string;
  state: string;
  district: string;
  city: string;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  status: string;
  lifecycleStatus: string;
  organizationId: string | null;
  panNumber: string | null;
  bankAccountNumber: string | null;
  ifscCode: string | null;
  notes: string | null;
  employmentType: string;
  joiningDate: string | null;
  exitDate: string | null;
  terminationDate: string | null;
  managerId: string | null;
  department: string | null;
  region: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  emergencyContactRelation: string | null;
  photograph: string | null;
  skills: string[] | null;
  certifications: { name: string; expiryDate: string }[] | null;
  languages: string[] | null;
  preferredRegions: string[] | null;
  specializations: string[] | null;
  experienceYears: number;
  performanceRating: number;
  leaves: { startDate: string; endDate: string }[] | null;
  workingHours: { start: string; end: string } | null;
  maxDailyWorkload: number;
  maxWeeklyWorkload: number;
}

export const STATUS_COLORS: Record<string, string> = {
  [AssayerLifecycleStatus.ACTIVE]: 'var(--success)',
  [AssayerLifecycleStatus.ON_LEAVE]: 'var(--warning)',
  [AssayerLifecycleStatus.INVITED]: 'var(--accent)',
  [AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: 'var(--accent)',
  [AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: 'var(--accent)',
  [AssayerLifecycleStatus.TRAINING]: 'var(--warning)',
  [AssayerLifecycleStatus.SUSPENDED]: 'var(--danger)',
  [AssayerLifecycleStatus.INACTIVE]: 'var(--text-muted)',
  [AssayerLifecycleStatus.RESIGNED]: 'var(--text-muted)',
  [AssayerLifecycleStatus.TERMINATED]: 'var(--danger)',
  [AssayerLifecycleStatus.ARCHIVED]: 'var(--text-muted)',
};

/**
 * The fields that must be present before an assayer can be paid or sent to a site.
 * Both the full profile page and the roster drawer show the same gap list from here,
 * so the two surfaces can never disagree about who is missing what — the earlier
 * copy-paste had already begun to drift ("payouts" vs "Payouts").
 */
export const CRITICAL_FIELDS: { key: keyof Assayer; label: string; why: string }[] = [
  { key: 'panNumber', label: 'PAN', why: 'TDS and statutory filing' },
  { key: 'bankAccountNumber', label: 'Bank account', why: 'payouts' },
  { key: 'ifscCode', label: 'IFSC', why: 'payouts' },
  { key: 'joiningDate', label: 'Joining date', why: 'tenure and settlement' },
  { key: 'emergencyContactPhone', label: 'Emergency contact', why: 'duty of care' },
];

/** The critical fields this record is still missing (blank or whitespace-only). */
export function missingCriticalFields(a: Pick<Assayer, (typeof CRITICAL_FIELDS)[number]['key']> | null | undefined) {
  if (!a) return [];
  return CRITICAL_FIELDS.filter((f) => {
    const v = (a as any)[f.key];
    return v == null || String(v).trim() === '';
  });
}

/** en-IN date, em-dash for unknown — the app-wide convention for a bare date. */
export const fmtDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

/** en-IN date + time, em-dash for unknown — used wherever a "when" is shown. */
export const fmtWhen = (d?: string | null) =>
  d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

/** Rupees with an em-dash for empty, matching the workforce screens. */
export const money = (n?: number | null) => formatRupees(n, { emptyAs: '—' });

/** The small uppercase caption style repeated across the workforce record surfaces. */
export const fieldLabelStyle: CSSProperties = {
  fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)',
};
