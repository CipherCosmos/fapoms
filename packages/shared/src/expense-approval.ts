import { SystemRole } from './enums';
import { OTHER_CONFLICT_ERROR_CODES } from './error-codes';

/**
 * APPROVING AN EXPENSE CLAIM THE RULES REFUSE (owner decision 2026-09-24).
 *
 * Approval is refused when the assignment was cancelled, when the claim's assayer no longer holds
 * the assignment, or when the job's pay is on an assayer bill that has been sent
 * (`evaluateExpenseApproval` in the backend's assignment-capabilities.ts). A senior can still
 * approve by writing a reason; the reason is kept on the claim and in the audit trail. Rejecting a
 * claim is never refused.
 *
 * Both sides read this file, so the web offers "Approve anyway" to exactly the people the server
 * will accept it from, on exactly the refusals it will accept it for.
 */

/**
 * Who counts as a senior here: ADMIN — the same people who may suspend an operational rule
 * (rule-bypass) and decide the approvals above HR (final approval, adverse re-checks). OPERATIONS
 * reviews claims day to day and is deliberately not on it: the override is somebody above the
 * reviewer. Matched implication-aware (`expandRoles`), so a DEVELOPER passes as ADMIN does.
 */
export const EXPENSE_APPROVAL_OVERRIDE_ROLES: readonly SystemRole[] = [SystemRole.ADMIN];

/** The refusals a senior may override with a written reason — all three of them. */
export const EXPENSE_APPROVAL_OVERRIDABLE_CODES: readonly string[] = [
  OTHER_CONFLICT_ERROR_CODES.EXPENSE_APPROVAL_ASSIGNMENT_CANCELLED,
  OTHER_CONFLICT_ERROR_CODES.EXPENSE_APPROVAL_ASSAYER_REASSIGNED,
  OTHER_CONFLICT_ERROR_CODES.EXPENSE_APPROVAL_JOB_ON_SENT_BILL,
];

/** A written override reason shorter than this is refused — the same floor assignment overrides use. */
export const EXPENSE_APPROVAL_OVERRIDE_MIN_REASON = 10;
