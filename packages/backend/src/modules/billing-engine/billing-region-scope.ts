/**
 * FAPOMS — "which billing rows belong to a region", written once.
 *
 * `GET /billing-engine/overview` returned organisation-wide financial totals to a
 * region-scoped caller: every other billing read took `@GlobalScopeFilter`, `overview()`
 * took no parameters at all. Fixing it means adding a region predicate to eight aggregate
 * queries at once, and an aggregate is exactly where a wrong predicate does the most damage —
 * a list that shows too many rows is visible, a SUM that is quietly 40,000 too big is not.
 *
 * So the predicates live here rather than being spelled out eight (really fifteen) times in
 * `overview()`, and they are stated as one rule:
 *
 *   A row counts for a region-scoped caller when its region attribution RESOLVES to at least
 *   one region and EVERY region it resolves to is one the caller holds.
 *
 * Both halves matter and they are the whole of the design:
 *
 *  - "resolves" — a payable whose assignment has no `project_branch_id`, or whose branch has
 *    `region IS NULL`, is attributable to nobody. It is EXCLUDED for every scoped caller and
 *    visible only to an unrestricted one. Including it instead would add the same rupees to
 *    North's total and to East's, so no region's figure would be the money in that region and
 *    the regions would not add up to the organisation.
 *  - "every region" — an invoice can legitimately span regions (see `invoiceRegions` in the
 *    service). One that does is counted for a caller holding all of them and for nobody else,
 *    which is the same ceiling `findInvoicesPage` and `assertInvoiceRegionAllowed` already
 *    apply to the list and the detail route: you do not get a partial view of an invoice.
 *
 * ## Why the path is `assignments → project_branches → branches`
 *
 * Because that is the only path there is. A branch carries `region`; nothing else does. A
 * client does not have a region (a bank is national), a project does not (it is a set of
 * branches and may span several), and an invoice does not (it is a set of assignments). Every
 * region check in the codebase — `RegionGuardService.assertAssignmentInScope`,
 * `listPayouts`, `listClientLines`, `listInvoiceable`, `findInvoicesPage` — walks this same
 * path, and these fragments walk it identically so the overview's totals can never disagree
 * with the lists they head.
 *
 * ## Why EXISTS and not a join
 *
 * The list methods reach the branch with `LEFT JOIN`s, which is correct there: they return
 * entities, and each hop is many-to-one on a primary key, so no row is duplicated. In an
 * aggregate the stakes are different — a join that turned out to be one-to-many would silently
 * double a `SUM`, and nothing about the result would look wrong. `EXISTS` is a predicate: it
 * can only ever include or exclude a row, never duplicate one. The truth table is the same as
 * the joins' (`INNER JOIN` + `region = ANY(...)` is false for a null region, exactly as
 * `LEFT JOIN` + `region IN (...)` is), so this is the same rule expressed in the form whose
 * failure mode is visible rather than silent.
 *
 * ## Aliases
 *
 * Every alias here is prefixed and distinct per fragment (`rgn_`, `rgi_`, `rgx_`, `rgm_`)
 * because `paymentInRegion` nests the other two. No fragment ever nests inside itself, so no
 * alias is ever shadowed by a correlated name from an outer scope.
 *
 * The region list is a query parameter, never interpolated — `regionsExpr` defaults to
 * `$1::text[]`, which is what every caller in `overview()` binds it to.
 */

/**
 * ## The fifteen statements, one row each
 *
 * The instruction on this finding was not to add a predicate to eight queries and call it done:
 * a wrong join in an aggregate produces incorrect financial figures, which is worse than the leak
 * it was meant to close. So every statement `overview()` runs is written down here — what it
 * selects from, what decides its region, how it gets there, and what it is allowed to count —
 * and every figure is reconciled against an independently written calculation over the same rows
 * in `billing-overview-region-scope.db.spec.ts`.
 *
 * "Slot" is the position in `overview()`'s `Promise.all`; eight slots, fifteen statements,
 * because `byClient` is three grouped sub-selects and the attention list is six queries.
 * `billing-overview-region-scope.spec.ts` drives the real method and asserts, per statement, that
 * the predicate is present and the regions are bound rather than inlined.
 *
 * Every row reaches a region through `branches.region` and through nothing else, because nothing
 * else carries one. The "path" column is therefore the same walk in every row, differing only in
 * where it starts, which is the point: one rule, one path, fifteen uses.
 *
 * | # | Slot | Selects from | Fragment | Starts at | Counts a row when | Row filter it is added to |
 * |---|------|--------------|----------|-----------|-------------------|---------------------------|
 * | 1 | 1 payouts | `assayer_payables p` | `payable` | `p.assignment_id` | its assignment's branch is in the list | `is_active` |
 * | 2 | 2 client lines | `billing_entries e` | `entry` | `e.assignment_id` | its assignment's branch is in the list | `is_active` |
 * | 3 | 3 invoices | `billing_invoices i` | `invoice` | `i.id` -> its lines | it has a line in the list and none outside it | `is_active` |
 * | 4 | 4 ageing | `billing_invoices i` | `invoice` | `i.id` -> its lines | same as 3 | `is_active AND status = 'ISSUED'` |
 * | 5 | 5 cashflow | `billing_payments pm` | `payment` | `pm.payable_id` or `pm.invoice_id` | the row it settles counts, by rule 1 or rule 3 | `is_active` |
 * | 6 | 6 by client | `billing_entries be` | `entry` | `be.assignment_id` | as row 2 | `is_active`, grouped by `client_id` |
 * | 7 | 6 by client | `billing_invoices bi` | `invoice` | `bi.id` -> its lines | as row 3 | `is_active`, grouped by `client_id` |
 * | 8 | 6 by client | `assayer_payables ap` | `payable` | `ap.assignment_id` | as row 1 | `is_active`, grouped by `client_id` |
 * | 9 | 7 recent activity | `billing_history h` | `history` | `h.assignment_id` | its assignment's branch is in the list | none; `ORDER BY created_at DESC LIMIT 30` |
 * | 10 | 8a unbooked | `assignments a` | `assignment` | `a.id` | its own branch is in the list | `status = 'COMPLETED' AND (no line OR no payout)` |
 * | 11 | 8b unsettled fee | `assayer_payables p` | `payable` | `p.assignment_id` | as row 1 | `is_active`, no expense, snapshot says the fee was never agreed |
 * | 12 | 8c fee changed | `assayer_payables p` | `payable` | `p.assignment_id` | as row 1 | `is_active`, no expense, snapshot fee <> the assignment's fee |
 * | 13 | 8d held payout | `assayer_payables p` | `payable` | `p.assignment_id` | as row 1 | `is_active AND on_hold` |
 * | 14 | 8e held line | `billing_entries e` | `entry` | `e.assignment_id` | as row 2 | `is_active AND on_hold` |
 * | 15 | 8f overdue | `billing_invoices i` | `invoice` | `i.id` -> its lines | as row 3 | `is_active`, `ISSUED`, past due, still outstanding |
 *
 * ### The ownership relationship each fragment relies on
 *
 * Each `EXISTS` is only ever a filter because the hop it walks is many-to-one on a primary key,
 * and that is what makes it safe to reason about a SUM through it:
 *
 *  - a payable, a client line and a history row each name AT MOST ONE assignment
 *    (`assignment_id`, nullable), an assignment names at most one `project_branch`, and a
 *    `project_branch` names exactly one branch. So rows 1, 2, 6, 8, 9, 11-14 resolve to at most
 *    one region, and "every region it resolves to" is one region or none;
 *  - an invoice owns MANY lines, so rows 3, 4, 7 and 15 are the only ones where "every region"
 *    can mean more than one — which is why `invoiceInRegion` is two predicates and not one;
 *  - a payment settles at most one payable and at most one invoice, and takes that parent's
 *    answer rather than deriving its own. That is what makes `cashflow.out` reconcile with
 *    `payouts.paid`, and `cashflow.in` with `receivables.collected`, for a scoped caller.
 *
 * ### Two things deliberately NOT narrowed
 *
 *  - The outer `clients` query in slot 6. Its three sub-selects are narrowed instead, so a client
 *    with no in-region rows produces no group and is dropped by the existing `IS NOT NULL` guard
 *    — it disappears rather than appearing with zeros, because naming a client at all discloses
 *    that it exists.
 *  - Every statement, for an unrestricted caller or in `off` mode. `billingRegionFilters(null)`
 *    returns fragments that add nothing, so the national SQL is character-for-character the text
 *    it was before this file existed. The db spec pins that against a frozen copy of the pre-fix
 *    queries: a fix that quietly narrowed the national view would be a worse defect than the leak.
 *
 * ### What "reconciled" means here
 *
 * Not "the service agrees with itself". The db spec re-implements the rule in TypeScript —
 * resolving each assignment's region through `project_branches -> branches` and deciding
 * membership row by row — then sums the money with plain `SUM(...) WHERE id = ANY($1)` over the
 * base tables, on a fixture with two populated regions, a branch whose region is NULL, an
 * assignment with no branch, an invoice spanning both regions, an invoice with no lines and a
 * payment settling nothing. Two independently written formulations have to agree on every figure.
 * Two further checks are the ones that would catch a join that double-counts: the regions must
 * PARTITION the attributable money (A + B = the caller holding both), and each region's by-client
 * rows must add up to that region's own headline figures.
 */

/** Default placeholder for the caller's region list. Bound as `text[]` by every caller. */
const DEFAULT_REGIONS_EXPR = '$1::text[]';

/**
 * True when the assignment named by `assignmentIdExpr` sits in a branch inside the region list.
 *
 * The shared base of the payable, client-line and history rules: all three carry an
 * `assignment_id` and reach a region only through it. A NULL `assignment_id`, an assignment
 * with no `project_branch_id`, and a branch with a NULL `region` all make this false — the
 * three shapes of "cannot be attributed".
 */
export function assignmentInRegion(
  assignmentIdExpr: string,
  regionsExpr: string = DEFAULT_REGIONS_EXPR,
): string {
  return `EXISTS (
    SELECT 1
      FROM assignments rgn_a
      JOIN project_branches rgn_pb ON rgn_pb.id = rgn_a.project_branch_id
      JOIN branches rgn_b ON rgn_b.id = rgn_pb.branch_id
     WHERE rgn_a.id = ${assignmentIdExpr}
       AND rgn_b.region = ANY(${regionsExpr}))`;
}

/**
 * True when the invoice named by `invoiceIdExpr` resolves to at least one region and to no
 * region outside the list.
 *
 * The second half is `findInvoicesPage`'s `outOfScopeLine`, unchanged. The first half is the
 * addition this file exists to make: `findInvoicesPage` shows an invoice whose lines resolve
 * to nothing (no lines at all, or every line unattributable) to every scoped caller, which is
 * a defensible answer for a LIST — a row nobody can attribute should not become invisible to
 * everybody. It is the wrong answer for a TOTAL, where it would put the same money in every
 * region's `invoiced`, `collected`, `outstanding` and ageing bucket at once. This rule is
 * therefore strictly narrower than the list's and can never surface an invoice the list would
 * hide.
 *
 * Neither half filters `rg_e.is_active`, matching `invoiceRegions` and `findInvoicesPage`
 * exactly: an invoice must not be counted here and then 403 when the operator opens it.
 */
export function invoiceInRegion(
  invoiceIdExpr: string,
  regionsExpr: string = DEFAULT_REGIONS_EXPR,
): string {
  return `(EXISTS (
    SELECT 1
      FROM billing_entries rgi_e
      JOIN assignments rgi_a ON rgi_a.id = rgi_e.assignment_id
      JOIN project_branches rgi_pb ON rgi_pb.id = rgi_a.project_branch_id
      JOIN branches rgi_b ON rgi_b.id = rgi_pb.branch_id
     WHERE rgi_e.invoice_id = ${invoiceIdExpr}
       AND rgi_b.region = ANY(${regionsExpr}))
   AND NOT EXISTS (
    SELECT 1
      FROM billing_entries rgx_e
      JOIN assignments rgx_a ON rgx_a.id = rgx_e.assignment_id
      JOIN project_branches rgx_pb ON rgx_pb.id = rgx_a.project_branch_id
      JOIN branches rgx_b ON rgx_b.id = rgx_pb.branch_id
     WHERE rgx_e.invoice_id = ${invoiceIdExpr}
       AND rgx_b.region IS NOT NULL
       AND NOT (rgx_b.region = ANY(${regionsExpr}))))`;
}

/**
 * True when a payment inherits a region from the row it settles.
 *
 * A payment has no assignment of its own: an OUTBOUND row settles an `assayer_payables` row
 * and an INBOUND row settles a `billing_invoices` row, so each simply takes that parent's
 * rule. Deriving it rather than restating it is what makes `cashflow.out` reconcile with
 * `payouts.paid` and `cashflow.in` with `receivables.collected` for a scoped caller — two
 * different rules would have made those pairs disagree by an amount nobody could explain.
 *
 * A payment with neither parent set cannot be attributed and is excluded, the same answer the
 * other fragments give an unattributable row.
 */
export function paymentInRegion(
  paymentAlias: string,
  regionsExpr: string = DEFAULT_REGIONS_EXPR,
): string {
  return `(EXISTS (
    SELECT 1 FROM assayer_payables rgm_p
     WHERE rgm_p.id = ${paymentAlias}.payable_id
       AND ${assignmentInRegion('rgm_p.assignment_id', regionsExpr)})
   OR EXISTS (
    SELECT 1 FROM billing_invoices rgm_i
     WHERE rgm_i.id = ${paymentAlias}.invoice_id
       AND ${invoiceInRegion('rgm_i.id', regionsExpr)}))`;
}

/**
 * The `AND …` clauses `overview()` splices into its eight queries — empty strings when the
 * caller is unrestricted or the rollout is `off`, so the unfiltered query text and the figures
 * it produces are exactly what they were before region scoping existed here.
 *
 * Every builder takes the alias its query gave the table, because two of the eight
 * (`byClient`'s three grouped sub-selects) already use `e`, `i` and `p` for something else.
 */
export interface BillingRegionFilters {
  /**
   * The FROM-clause alias — ` p` when narrowing, `''` when not.
   *
   * The predicates need a name to correlate against; the original queries had none, because a
   * single-table aggregate does not need one. Emitting the alias only when there is a predicate
   * to correlate keeps the unrestricted SQL character-for-character what it was before this
   * file existed, which `billing-overview-region-scope.spec.ts` asserts against a frozen copy
   * of the pre-fix text. Columns inside those queries stay unqualified either way: there is one
   * table in each FROM, so there is nothing for them to be ambiguous with.
   */
  as(alias: string): string;
  /** `assayer_payables` aliased as `alias`. */
  payable(alias: string): string;
  /** `billing_entries` aliased as `alias`. */
  entry(alias: string): string;
  /** `billing_invoices` aliased as `alias`. */
  invoice(alias: string): string;
  /** `billing_payments` aliased as `alias`. */
  payment(alias: string): string;
  /** `billing_history` aliased as `alias`. */
  history(alias: string): string;
  /** `assignments` aliased as `alias` — the attention list's unbooked query starts here. */
  assignment(alias: string): string;
  /** True when these filters actually narrow anything. */
  readonly active: boolean;
}

const INERT: BillingRegionFilters = {
  as: () => '',
  payable: () => '',
  entry: () => '',
  invoice: () => '',
  payment: () => '',
  history: () => '',
  assignment: () => '',
  active: false,
};

/**
 * `null`/empty regions — an unrestricted caller — yields filters that add nothing at all, so
 * the caller does not have to branch on it and cannot forget to.
 */
export function billingRegionFilters(regions: readonly string[] | null | undefined): BillingRegionFilters {
  if (!regions || regions.length === 0) return INERT;
  return {
    as: (alias) => ` ${alias}`,
    payable: (alias) => ` AND ${assignmentInRegion(`${alias}.assignment_id`)}`,
    entry: (alias) => ` AND ${assignmentInRegion(`${alias}.assignment_id`)}`,
    invoice: (alias) => ` AND ${invoiceInRegion(`${alias}.id`)}`,
    payment: (alias) => ` AND ${paymentInRegion(alias)}`,
    history: (alias) => ` AND ${assignmentInRegion(`${alias}.assignment_id`)}`,
    assignment: (alias) => ` AND ${assignmentInRegion(`${alias}.id`)}`,
    active: true,
  };
}

/**
 * One query answering "what would `enforce` have removed?", for Log mode.
 *
 * The list endpoints compute their Log-mode warning from the page they already fetched. An
 * aggregate has no rows to inspect — the figure is a single number either way — so the count
 * has to be asked for separately. It is one statement covering all five base tables, run only
 * for a restricted caller and only while the rollout is in Log mode.
 */
export const BILLING_OUT_OF_SCOPE_COUNTS_SQL = `
  SELECT
    (SELECT COUNT(*) FROM assayer_payables p  WHERE p.is_active  = true AND NOT ${assignmentInRegion('p.assignment_id')})  AS payables,
    (SELECT COUNT(*) FROM billing_entries  e  WHERE e.is_active  = true AND NOT ${assignmentInRegion('e.assignment_id')})  AS entries,
    (SELECT COUNT(*) FROM billing_invoices i  WHERE i.is_active  = true AND NOT ${invoiceInRegion('i.id')})                AS invoices,
    (SELECT COUNT(*) FROM billing_payments pm WHERE pm.is_active = true AND NOT ${paymentInRegion('pm')})                  AS payments,
    (SELECT COUNT(*) FROM billing_history  h  WHERE NOT ${assignmentInRegion('h.assignment_id')})                          AS history`;
