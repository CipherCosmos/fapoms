export interface Assignment {
  id: string;
  assignmentNumber: string;
  projectId: string;
  /** Carried so the panel's outbound links can name the branch, not just the project. */
  projectBranchId?: string | null;
  assayerId: string;
  status: string;
  rejectReason?: string | null;
  priority: string;
  proposedFee: number;
  agreedFee: number | null;
  scheduledDate: string | null;
  createdAt: string;
  // GPS check-in evidence — the record that proves the assayer stood in the branch.
  checkedInAt?: string | null;
  checkInLatitude?: number | null;
  checkInLongitude?: number | null;
  checkInAccuracyMeters?: number | null;
  checkInDistanceMeters?: number | null;
  project: { name: string };
  assayer: { displayName: string };
  projectBranch: { status?: string; branch: { name: string; state: string } };
  assessment: { status?: string; branch: { name: string; state: string }; packetSize?: number } | null;
}

export interface TimelineEvent {
  type: string;
  timestamp: string;
  description: string;
  user: string;
}

/** A problem the field flagged from the mobile app — the desk's execution queue. */
export interface FieldIssue {
  id: string;
  reportedAt: string;
  assignmentId: string;
  assignmentNumber: string | null;
  branchName: string | null;
  assayerName: string | null;
  category: string | null;
  categoryLabel: string | null;
  note: string;
  assignmentStatus: string | null;
  /** False once the assignment reached a terminal state — i.e. the issue is implicitly resolved. */
  open: boolean;
}
