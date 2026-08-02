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
  [AssayerLifecycleStatus.ACTIVE]: '#10b981',
  [AssayerLifecycleStatus.ON_LEAVE]: '#f59e0b',
  [AssayerLifecycleStatus.INVITED]: '#3b82f6',
  [AssayerLifecycleStatus.DOCUMENT_VERIFICATION]: '#8b5cf6',
  [AssayerLifecycleStatus.BACKGROUND_VERIFICATION]: '#8b5cf6',
  [AssayerLifecycleStatus.TRAINING]: '#f59e0b',
  [AssayerLifecycleStatus.SUSPENDED]: '#ef4444',
  [AssayerLifecycleStatus.INACTIVE]: '#6b7280',
  [AssayerLifecycleStatus.RESIGNED]: '#9ca3af',
  [AssayerLifecycleStatus.TERMINATED]: '#dc2626',
  [AssayerLifecycleStatus.ARCHIVED]: '#9ca3af',
};
