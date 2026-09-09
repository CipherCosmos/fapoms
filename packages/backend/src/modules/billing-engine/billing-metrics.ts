/**
 * The headline money figures, defined once, for every surface that reports them.
 *
 * ## "Unbilled" means the receivable, not the revenue
 *
 * Two dashboards showed a figure labelled "Unbilled" to the same people and the two numbers were
 * different. `GET /system-dashboard/operations` returned `money.unbilled = 3200`, which was
 * `SUM(taxable_amount)`; `GET /billing-engine/overview` returned `receivables.unbilled = 3456`,
 * which was `SUM(total_amount)`. Same rows, same filter — the difference was GST less the TDS the
 * client withholds. Both figures were internally correct and only one of them can be called
 * "Unbilled".
 *
 * It is the receivable, on four pieces of evidence from the codebase itself:
 *
 *  1. `billing-entry.entity.ts` says what the row is: *"the client-side line for one assignment:
 *     what the client owes us for that audit"*, and its money comment defines the columns —
 *     `base + travel + adjustment = taxable; taxable + GST − TDS = total`. `total_amount` is what
 *     the client owes. `taxable_amount` is what we earned.
 *  2. `BillingOverview.receivables` groups `unbilled` with `invoiced`, `collected`, `outstanding`
 *     and `held`, and every one of those is a receivable read off the invoice (`total`,
 *     `paid_amount`, `outstanding_amount`). A member on the taxable basis breaks the block's own
 *     arithmetic: unbilled + invoiced stops being the billable book.
 *  3. The ex-GST figure already has a name in this product. `BillingOverview.margin.revenue` is
 *     documented as *"Σ taxable on live client lines (ex-GST)"* and is what margin is computed
 *     from. Two names for one number is fine; two meanings for one name is the defect.
 *  4. The operations dashboard's own money block reports `outstanding` and `collected` from
 *     `outstanding_amount` and `paid_amount` — receivables — and rendered all three as one bar
 *     chart. Only `unbilled` was on the other basis, so that chart compared unlike quantities.
 *     The service's own docblock says the snapshot exists so "the figures cannot disagree with
 *     each other".
 *
 * Both surfaces now select through the fragments below, so the definition cannot be changed on
 * one screen and not the other. `unbilled-consistency.spec.ts` fails if a caller stops using them.
 *
 * ## Where a genuinely different figure is needed, it gets a different name
 *
 * `UNBILLED_TAXABLE_SQL` exists for reporting that has to be ex-GST — margin, revenue recognition,
 * anything that must not double-count tax collected on the government's behalf. It is deliberately
 * not called "unbilled" anywhere a user can see: the instruction was to rename the metric rather
 * than show two numbers under one label.
 */

/**
 * Column prefix for a query that aliases `billing_entries`. Callers that select from the table
 * unaliased pass nothing; the region-scoped queries in `overview()` alias it (`e`, `be`) and pass
 * that, so one definition serves both rather than one definition and one transcription of it.
 */
const col = (alias: string | undefined, name: string) => (alias ? `${alias}.${name}` : name);

/** The row filter both figures share: a live client line, not yet invoiced and not held. */
export const unbilledRowFilterSql = (a?: string) =>
  `${col(a, 'state')} = 'UNBILLED' AND ${col(a, 'on_hold')} = false`;

export const UNBILLED_ROW_FILTER_SQL = unbilledRowFilterSql();

/**
 * **Unbilled** — money owed to us for delivered work that is not yet on an invoice.
 *
 * `total_amount` = taxable + GST − TDS: the amount the client will actually pay. Directly
 * comparable with `invoiced`, `collected` and `outstanding`, which is the whole point of it.
 *
 * Interpolate into a query over `billing_entries` that already carries `is_active = true`:
 *
 *     SELECT ${'${UNBILLED_RECEIVABLE_SQL}'} AS unbilled FROM billing_entries WHERE is_active = true
 */
export const unbilledReceivableSql = (a?: string) =>
  `COALESCE(SUM(${col(a, 'total_amount')}) FILTER (WHERE ${unbilledRowFilterSql(a)}), 0)`;

export const UNBILLED_RECEIVABLE_SQL = unbilledReceivableSql();

/**
 * **Unbilled taxable value** — the same rows on the revenue basis, ex-GST and pre-TDS.
 *
 * A different metric, so a different name. Never label this "Unbilled" on a screen: that word is
 * spoken for by `UNBILLED_RECEIVABLE_SQL` above, and the two differ by roughly 8% on live data.
 */
export const unbilledTaxableSql = (a?: string) =>
  `COALESCE(SUM(${col(a, 'taxable_amount')}) FILTER (WHERE ${unbilledRowFilterSql(a)}), 0)`;

export const UNBILLED_TAXABLE_SQL = unbilledTaxableSql();

/** **Held** — the receivable value of live client lines blocked from invoicing. */
export const heldReceivableSql = (a?: string) =>
  `COALESCE(SUM(${col(a, 'total_amount')}) FILTER (WHERE ${col(a, 'on_hold')} = true AND ${col(a, 'state')} <> 'CANCELLED'), 0)`;

export const HELD_RECEIVABLE_SQL = heldReceivableSql();

/**
 * **Revenue** — Σ taxable on every live client line, cancelled ones excluded. Ex-GST by
 * definition; this is the number margin is computed against.
 */
export const revenueTaxableSql = (a?: string) =>
  `COALESCE(SUM(${col(a, 'taxable_amount')}) FILTER (WHERE ${col(a, 'state')} <> 'CANCELLED'), 0)`;

export const REVENUE_TAXABLE_SQL = revenueTaxableSql();
