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
  /**
   * The server's answer to "may we send this person out, and can we pay them for it", and the
   * reasons when it is no. Written by `RosterRecordsService.deploymentVerdict`, which composes the
   * gates that actually refuse things — the candidate-pool predicate, `DeployabilityFilter`,
   * `ClientEligibilityFilter`, `identityStanding`, `cannotBePaid`.
   *
   * These were declared optional here long before the endpoint emitted either of them, which is
   * how `DeploymentReadinessCard` came to branch on two fields that were always `undefined` while
   * calling itself backend-authoritative. Required now, because the endpoint always sends them —
   * and required is what makes a future removal a compile error instead of a green badge on
   * somebody the planner refuses.
   *
   * `deploymentBlockers` are finished sentences meant for the screen, in the product's own voice
   * (lowercase mid-sentence fragments that name the fix). Render them; do not parse them, and do
   * not re-derive the verdict from them — `deployable` is the verdict.
   */
  deployable: boolean;
  deploymentBlockers: string[];
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
  /**
   * What backed `destinationVerifiedAt`: 'BANK_PASSBOOK', 'IDENTITY_DOCUMENT', or null when the
   * destination is unverified. Null with a non-null timestamp is impossible — the database
   * refuses it — so this is what makes "verified" on screen mean something.
   */
  destinationVerifiedSource?: string | null;
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
