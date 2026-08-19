import { SystemRole } from '@fapoms/shared';

/**
 * Who may see the billing book.
 *
 * There were two constants with this name and different membership: one in
 * `billing-engine.controller.ts` and one in `reports.controller.ts`, the latter carrying an extra
 * `OPERATIONS_EXECUTIVE`. That role was refused by every read on the billing engine — entries,
 * invoices, payables, history, dashboard — and admitted by `GET /reports/billing`, which exports
 * the same rows, including assayer payout lines, as a spreadsheet.
 *
 * A read boundary that one export ignores is not a boundary. Defined once, here, so widening it
 * is a decision made in one place rather than an accident of which file someone edited.
 */
export const BILLING_ROLES = [
  SystemRole.SUPER_ADMINISTRATOR,
  SystemRole.ADMINISTRATOR,
  SystemRole.FINANCE_MANAGER,
  SystemRole.OPERATIONS_MANAGER,
];

/**
 * The same set plus the auditor, for reads.
 *
 * `READ_ONLY_AUDITOR` was appended by hand at ten separate `@Roles(...)` sites and omitted at the
 * export — so the auditor could read every billing figure in the UI and got a 403 the moment they
 * pressed Export, on a button the page renders for them unconditionally. Auditing is a reading
 * job; the export is a read.
 */
export const BILLING_READ_ROLES = [...BILLING_ROLES, SystemRole.READ_ONLY_AUDITOR];

/**
 * Who may approve, pay, hold or reverse a payout — money leaving the business has one gate,
 * and it is finance or an administrator. Operations may see the book and raise invoices; it
 * may not release cash.
 */
export const DISBURSEMENT_ROLES = [
  SystemRole.SUPER_ADMINISTRATOR,
  SystemRole.ADMINISTRATOR,
  SystemRole.FINANCE_MANAGER,
];
