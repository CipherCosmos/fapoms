/**
 * Web-specific status presentation.
 *
 * The labels themselves now live in `@fapoms/shared` so the mobile app renders identical
 * wording; this file keeps only what is genuinely web-only (CSS custom-property tones) and
 * re-exports the shared labels so existing imports from `utils/statusLabels` still resolve.
 */
import { ProjectBranchStatus } from '@fapoms/shared';

export {
  branchStatusLabel,
  assignmentStatusLabel,
  scheduleStatusLabel,
  clientLifecycleLabel,
  clientTypeLabel,
  contractStatusLabel,
  billingStateLabel,
  payableStatusLabel,
  invoiceStatusLabel,
  anyStatusLabel,
  BRANCH_COVERED_STATUSES,
  BRANCH_DONE_STATUSES,
  BRANCH_PENDING_STATUSES,
  BRANCH_ACTIVE_COVERED_STATUSES,
  localDateKey,
  todayDateKey,
  formatDateOnly,
} from '@fapoms/shared';

/** Semantic tone for a branch status — single source of truth for badge colours. */
export interface StatusTone { bg: string; color: string; }

/**
 * One bucket per branch status, so a badge and a map pin can never disagree.
 *
 * These were two independent switch statements and had already drifted: IMPORTED and PLANNING
 * fell through `branchStatusColor`'s default to amber while `branchStatusTone` rendered them
 * grey, so a branch nobody had started work on looked "in progress" on the map and "not
 * planned" in the table.
 */
export type BranchStatusBucket = 'covered' | 'inFlight' | 'blocked' | 'seeking' | 'notPlanned';

export function branchStatusBucket(status?: string | null): BranchStatusBucket {
  switch (status) {
    case ProjectBranchStatus.CLOSED:
    case ProjectBranchStatus.ASSIGNMENT_CONFIRMED:
      return 'covered';
    case ProjectBranchStatus.SCHEDULED:
    case ProjectBranchStatus.AUDIT_COMPLETED:
    case ProjectBranchStatus.VALIDATION_COMPLETED:
      return 'inFlight';
    case ProjectBranchStatus.UNABLE_TO_COVER:
    case ProjectBranchStatus.CANCELLED:
      return 'blocked';
    case ProjectBranchStatus.CANDIDATE_SEARCH:
    case ProjectBranchStatus.CONTACT_INITIATED:
    case ProjectBranchStatus.NEGOTIATION:
      return 'seeking';
    case ProjectBranchStatus.ON_HOLD:
    case ProjectBranchStatus.IMPORTED:
    case ProjectBranchStatus.PLANNING:
    default:
      return 'notPlanned';
  }
}

const BUCKET_TONE: Record<BranchStatusBucket, StatusTone> = {
  covered: { bg: 'var(--status-active-bg)', color: 'var(--success)' },
  inFlight: { bg: 'rgba(216,174,71,0.15)', color: 'var(--accent)' },
  blocked: { bg: 'var(--status-cancelled-bg)', color: 'var(--danger)' },
  seeking: { bg: 'var(--status-pending-bg)', color: 'var(--warning)' },
  notPlanned: { bg: 'var(--border-hair)', color: 'var(--text-muted)' },
};

/** Raw hex, because a Leaflet SVG fill cannot take a CSS variable. */
const BUCKET_HEX: Record<BranchStatusBucket, string> = {
  covered: '#10b981',
  inFlight: '#f59e0b',
  blocked: '#ef4444',
  seeking: '#f59e0b',
  notPlanned: '#9ca3af',
};

/** Human-readable bucket names, for a map legend that cannot drift from the pins. */
export const BRANCH_BUCKET_LABEL: Record<BranchStatusBucket, string> = {
  covered: 'Assigned or closed',
  inFlight: 'Scheduled and later',
  blocked: 'Cannot be covered',
  seeking: 'Finding an assayer',
  notPlanned: 'Not yet planned',
};

export function branchStatusTone(status?: string | null): StatusTone {
  return BUCKET_TONE[branchStatusBucket(status)];
}

export function branchStatusColor(status?: string | null): string {
  return BUCKET_HEX[branchStatusBucket(status)];
}

/**
 * The map legend, derived from the same buckets that colour the pins.
 *
 * The legend used to be hand-written and disagreed with what was drawn: it labelled green
 * "Scheduled/Confirmed" when SCHEDULED renders amber, and omitted the red and grey pins
 * entirely, so two of the five colours on screen were unexplained.
 */
export const BRANCH_STATUS_LEGEND: Array<{ bucket: BranchStatusBucket; label: string; hex: string }> =
  (Object.keys(BUCKET_HEX) as BranchStatusBucket[]).map((bucket) => ({
    bucket,
    label: BRANCH_BUCKET_LABEL[bucket],
    hex: BUCKET_HEX[bucket],
  }));

