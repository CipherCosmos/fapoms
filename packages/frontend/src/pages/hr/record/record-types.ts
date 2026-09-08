import type { EmpanelmentStatus } from '@fapoms/shared';

export interface DocumentVersionInfo {
  id: string;
  version: number;
  filePath?: string;
  fileChecksum?: string | null;
  contentSha256?: string | null;
  storageObjectId?: string | null;
  fileSize?: number | null;
  mimeType?: string | null;
  uploadedAt?: string | Date;
  createdAt?: string | Date | null;
  uploadedBy?: string | null;
  verificationStatus: string;
  verifiedAt?: string | Date | null;
  verifiedBy?: string | null;
  rejectionReason?: string | null;
  supersededByVersionId?: string | null;
  supersededAt?: string | Date | null;
}

export interface PaperworkDocument {
  requirement: string;
  label: string;
  identity: boolean;
  id: string | null;
  currentVersionId?: string | null;
  docVersion?: number;
  contentSha256?: string | null;
  uploadedAt?: string | null;
  versions?: DocumentVersionInfo[];
  softCopyReceived: boolean | null;
  hardCopyReceived: boolean | null;
  hardCopyLocation: string | null;
  courierReference: string | null;
  receivedAt: string | null;
  documentNumber: string | null;
  expiryDate: string | null;
  verificationStatus: string | null;
  verifiedAt: string | null;
  holderName: string | null;
  holderDateOfBirth: string | null;
  holderGender: string | null;
  holderGuardianName: string | null;
  holderAddress: string | null;
  prints: Record<string, boolean> | null;
  nameMatchGrade: string | null;
  nameMatchNote: string | null;
  rejectionReason: string | null;
  filePaths: string[];
  remarks: string | null;
}

export interface ClientEmpanelment {
  id: string;
  assayerId: string;
  clientId: string;
  status: EmpanelmentStatus | string;
  statusReason?: string | null;
  documentsOutstanding?: string | null;
  decidedAt?: string | null;
  remarks?: string | null;
  client?: {
    id: string;
    name: string;
    clientCode?: string;
  } | null;
}

export interface BackgroundCheck {
  id: string;
  assayerId: string;
  verdict: string;
  riskGrade?: string | null;
  cibilScore?: number | null;
  cibilBand?: string | null;
  checkedOn?: string | null;
  checkedByName?: string | null;
  findings?: string | null;
  createdAt: string;
}

export interface AssayerDossier {
  references: Array<{
    id: string;
    fullName: string;
    phone?: string | null;
    relationship?: string | null;
    checkedAt?: string | null;
    checkedBy?: string | null;
    remarks?: string | null;
  }>;
  empanelments: ClientEmpanelment[];
  backgroundChecks: BackgroundCheck[];
  currentCheck: BackgroundCheck | null;
  onboarding: PaperworkDocument[];
  openIssues: any[];
  deployable?: boolean;
  deploymentBlockers?: string[];
}

export interface PlanningSnapshot {
  workload: {
    activeCount: number;
    maxWeeklyCapacity: number;
    remaining: number;
  };
  riskFlags: Array<{
    reason: string;
    rawValue: string;
    createdAt: string;
  }>;
}

export interface FrozenPayableItem {
  id: string;
  payableNumber: string;
  status: string;
  onHold: boolean;
  holdReason?: string | null;
  assignmentId?: string | null;
  totalAmount: number;
  paidAmount: number;
  approvedAt?: string | null;
  destinationBankAccountNumber?: string | null;
  destinationIfsc?: string | null;
  destinationBankName?: string | null;
  destinationAccountHolderName?: string | null;
  payoutEvidenceVersionId?: string | null;
  destinationVerifiedAt?: string | null;
}

export interface AssayerStatement {
  assayerId: string;
  assayerName?: string | null;
  assayerCode?: string | null;
  pan?: string | null;
  tdsSection?: string;
  totals: {
    earned: number;
    paid: number;
    outstanding: number;
    awaitingApproval: number;
    onHoldOrDisputed: number;
    tdsWithheld: number;
    payableCount: number;
  };
  payables?: FrozenPayableItem[];
}

export interface ActiveAssignment {
  id: string;
  assignmentNumber: string;
  status: string;
  scheduledDate?: string | null;
  branchName?: string | null;
  projectName?: string | null;
  clientName?: string | null;
  city?: string | null;
  branch?: { id: string; name?: string } | null;
  projectBranch?: { id: string; branchName?: string } | null;
  project?: { id: string; name?: string } | null;
}
