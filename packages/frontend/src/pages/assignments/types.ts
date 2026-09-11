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
  // The departure half. The API has returned these all along; the web app referenced none of
  // them, so a visit that never ended looked exactly like one that did.
  checkedOutAt?: string | null;
  checkOutLatitude?: number | null;
  checkOutLongitude?: number | null;
  checkOutAccuracyMeters?: number | null;
  checkOutDistanceMeters?: number | null;
  /** Stated when a job was closed with no arrival at all. */
  completedWithoutCheckInReason?: string | null;
  /** Stated when a job was closed with an arrival and no departure. */
  completedWithoutCheckOutReason?: string | null;
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
