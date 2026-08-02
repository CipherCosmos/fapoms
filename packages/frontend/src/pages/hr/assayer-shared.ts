import { AssayerLifecycleStatus } from '@fapoms/shared';

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
