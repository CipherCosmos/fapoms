import { SystemRole } from '@fapoms/shared';

/**
 * Who may see the billing book.
 *
 * There were two constants with this name and different membership, one in
 * `billing-engine.controller.ts` and one in `reports.controller.ts`. A role refused by every read
 * on the billing engine — entries, invoices, payables, history, dashboard — was admitted by
 * `GET /reports/billing`, which exports the same rows, assayer payout lines included, as a
 * spreadsheet.
 *
 * A read boundary that one export ignores is not a boundary. Defined once, here, so widening it
 * is a decision made in one place rather than an accident of which file someone edited.
 */
export const BILLING_ROLES = [
  SystemRole.ADMIN,
  SystemRole.OPERATIONS,
];

/**
 * The same set plus the auditor, for reads.
 *
 * The auditor could read every billing figure on screen and got a 403 the moment they pressed
 * Export, on a button the page rendered for them unconditionally. Auditing is a reading job, and
 * an export is a read.
 */
export const BILLING_READ_ROLES = [...BILLING_ROLES, SystemRole.AUDITOR];

/**
 * Who may approve, pay, hold or reverse a payout.
 *
 * This was the one gate money left the business through, and it was deliberately not operations:
 * the people who created the work could not release the cash for it. Folding the finance role
 * into OPERATIONS gives that up — one role now books an assignment and approves the payout for
 * it.
 *
 * ADMIN stays on this list for that reason. It is the only remaining way to have a payout
 * approved by someone other than the person who scheduled the work, and if this business ever
 * wants that check back, this constant is where it goes.
 */
export const DISBURSEMENT_ROLES = [
  SystemRole.ADMIN,
  SystemRole.OPERATIONS,
];
