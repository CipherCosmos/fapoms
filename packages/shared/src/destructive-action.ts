/**
 * The destructive-action two-person rule — the contract between the developer who requests,
 * the admin who approves, and the Danger Zone / Approvals screens that render it.
 *
 * v1 covers exactly one action: the data wipe (`DATA_RESET`). A DEVELOPER requests it naming
 * the domains, an ADMIN approves or rejects (never their own request), and only then does the
 * requesting developer execute — with the same confirmation phrase as before, plus the
 * approved request's id. Neither role can destroy alone; see SYSTEM:* in enums.ts.
 */

export enum DestructiveActionType {
  DATA_RESET = 'DATA_RESET',
}

export enum DestructiveActionRequestStatus {
  /** Filed by a developer; waiting for an admin's decision. */
  REQUESTED = 'REQUESTED',
  /** An admin said yes. Executable by the requesting developer until `expiresAt`. */
  APPROVED = 'APPROVED',
  /** An admin said no; `decisionReason` says why. Terminal. */
  REJECTED = 'REJECTED',
  /** Approval ran out before execution. Terminal — file a fresh request. */
  EXPIRED = 'EXPIRED',
  /** Withdrawn by the requesting developer before a decision. Terminal. */
  CANCELLED = 'CANCELLED',
  /** The wipe actually ran. Terminal. */
  EXECUTED = 'EXECUTED',
}

/** How long an approval stays executable. Kept short: an approval is for THIS wipe, now. */
export const DESTRUCTIVE_APPROVAL_TTL_HOURS = 24;

export interface DestructiveActionRequest {
  id: string;
  actionType: DestructiveActionType;
  status: DestructiveActionRequestStatus;
  /** What the developer asked to wipe — sorted domain keys, frozen at request time. */
  domainKeys: string[];
  /** Row counts previewed at request time, keyed by domain — what the approver saw. */
  previewCounts: Record<string, number>;
  requestedById: string;
  requestedByName: string | null;
  requestedAt: string;
  decidedById: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  executedAt: string | null;
  /** Set on approval: the moment the approval stops being executable. */
  expiresAt: string | null;
}
