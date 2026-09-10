import { AssayerPayableStatus, BillingState } from './enums';

/**
 * Which financial rows still represent money, and which are only history.
 *
 * Both ledgers keep their dead rows. A payable the owner voided and a client line whose
 * completion was withdrawn stay in the table on purpose — deleting them would make the ledger
 * claim the booking never happened. So every question of the form "has this assignment been
 * billed?" has two possible readings, and only one of them is ever the right one:
 *
 *   "does a row exist for it?"        — true forever, once anything has ever been booked
 *   "does a LIVE row exist for it?"   — the question the business is actually asking
 *
 * Reading the first as the second is what let a reopened audit be redone, completed, and never
 * paid for. `bookAssignment` found the voided payable, concluded "already booked", and wrote
 * nothing; the money view reported `booked: true` beside it; and the reconciler that exists to
 * repair exactly this could not see it, because its LEFT JOIN matched the cancelled row too.
 * The assayer was not paid for work the system recorded as complete, and nothing said so.
 *
 * The rule lives here, once, in both the shape TypeScript needs and the shape SQL needs, so a
 * query and a predicate cannot drift apart. Expressed as "not dead" rather than as a list of
 * live states deliberately: a status added later is live until somebody decides otherwise, which
 * is the direction that fails safe — a new state would be detected and blocked rather than
 * silently ignored by every check at once.
 */

/** Payable states that are history: the money will not be paid under this row. */
export const DEAD_PAYABLE_STATUSES: readonly AssayerPayableStatus[] = [AssayerPayableStatus.VOIDED];

/** Client-line states that are history: the money will not be collected under this row. */
export const DEAD_BILLING_STATES: readonly BillingState[] = [BillingState.CANCELLED];

/** Does this payable still represent money owed to an assayer? */
export const isLivePayable = (status: AssayerPayableStatus | string | null | undefined): boolean =>
  !!status && !DEAD_PAYABLE_STATUSES.includes(status as AssayerPayableStatus);

/** Does this client line still represent money to collect from a client? */
export const isLiveBillingEntry = (state: BillingState | string | null | undefined): boolean =>
  !!state && !DEAD_BILLING_STATES.includes(state as BillingState);

const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

/**
 * The same rule as SQL, for raw queries and for the partial unique indexes.
 *
 * `alias` is the table alias in the query being written (`p.status`, `payable.status`, …). These
 * are built from the enum, so a new dead state changes the predicate, the index and the
 * TypeScript check together or not at all.
 */
export const livePayableSql = (alias = 'p') => `${alias}.status NOT IN (${quoted(DEAD_PAYABLE_STATUSES)})`;
export const liveBillingEntrySql = (alias = 'e') => `${alias}.state NOT IN (${quoted(DEAD_BILLING_STATES)})`;
