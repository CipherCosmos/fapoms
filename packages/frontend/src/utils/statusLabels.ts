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
  assessmentStatusLabel,
  clientLifecycleLabel,
  clientTypeLabel,
  contractStatusLabel,
  billingStatusLabel,
  anyStatusLabel,
  BRANCH_COVERED_STATUSES,
  BRANCH_DONE_STATUSES,
  BRANCH_PENDING_STATUSES,
  BRANCH_ACTIVE_COVERED_STATUSES,
  localDateKey,
  todayDateKey,
} from '@fapoms/shared';

/** Semantic tone for a branch status — single source of truth for badge colours. */
export interface StatusTone { bg: string; color: string; }

export function branchStatusTone(status?: string | null): StatusTone {
  switch (status) {
    case ProjectBranchStatus.CLOSED:
    case ProjectBranchStatus.ASSIGNMENT_CONFIRMED:
      return { bg: 'var(--status-active-bg)', color: 'var(--success)' };
    case ProjectBranchStatus.SCHEDULED:
    case ProjectBranchStatus.AUDIT_COMPLETED:
    case ProjectBranchStatus.VALIDATION_COMPLETED:
      return { bg: 'rgba(216,174,71,0.15)', color: 'var(--accent)' };
    case ProjectBranchStatus.UNABLE_TO_COVER:
    case ProjectBranchStatus.CANCELLED:
      return { bg: 'var(--status-cancelled-bg)', color: 'var(--danger)' };
    case ProjectBranchStatus.CANDIDATE_SEARCH:
    case ProjectBranchStatus.CONTACT_INITIATED:
    case ProjectBranchStatus.NEGOTIATION:
      return { bg: 'var(--status-pending-bg)', color: 'var(--warning)' };
    case ProjectBranchStatus.ON_HOLD:
      return { bg: 'var(--border-hair)', color: 'var(--text-muted)' };
    case ProjectBranchStatus.IMPORTED:
    case ProjectBranchStatus.PLANNING:
    default:
      return { bg: 'var(--border-hair)', color: 'var(--text-muted)' };
  }
}

/** Hex marker colour for the Leaflet map (SVG fill needs a raw colour, not a CSS var). */export function branchStatusColor(status?: string | null): string {
  switch (status) {
    case ProjectBranchStatus.CLOSED:
    case ProjectBranchStatus.ASSIGNMENT_CONFIRMED:
      return '#10b981';
    case ProjectBranchStatus.SCHEDULED:
    case ProjectBranchStatus.AUDIT_COMPLETED:
    case ProjectBranchStatus.VALIDATION_COMPLETED:
      return '#f59e0b';
    case ProjectBranchStatus.UNABLE_TO_COVER:
    case ProjectBranchStatus.CANCELLED:
      return '#ef4444';
    case ProjectBranchStatus.ON_HOLD:
      return '#9ca3af';
    case ProjectBranchStatus.IMPORTED:
    case ProjectBranchStatus.PLANNING:
    case ProjectBranchStatus.CANDIDATE_SEARCH:
    case ProjectBranchStatus.CONTACT_INITIATED:
    case ProjectBranchStatus.NEGOTIATION:
    default:
      return '#f59e0b';
  }
}

