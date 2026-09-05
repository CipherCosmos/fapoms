/**
 * THE eligibility predicate: which payables may ride the next assayer invoice.
 *
 *  - `status IN ('PENDING','APPROVED')` — both fee and expense rows, including approved-but-
 *    unpaid ones (approved before invoicing shipped, or approved out-of-band); PAID rows are
 *    settled history and VOIDED rows are dead.
 *  - `on_hold = false` — a held payable is a problem ops is working; inviting it would jam the
 *    invoice on a known issue.
 *  - `assayer_invoice_id IS NULL` — a line rides at most one invoice at a time.
 *  - `pre_invoicing_era = false` — grandfathered rows were revealed (and often paid) under the
 *    old rules; re-inviting them would bill history twice.
 *
 * One exported function rather than SQL written twice: `AssayerInvoiceService.invite`/
 * `inviteAll` select by it and the gated statement's "N audits await invoicing" counts by it,
 * and a teaser that disagrees with the invite about what is billable is exactly the kind of
 * drift a shared predicate exists to prevent. In its own file (not on the service) so
 * `billing-engine.service.ts` can import it without a circular import — the invoice service
 * already imports the engine.
 *
 * `alias` is the `assayer_payables` alias in the caller's query. Deliberately NOT filtered by
 * assayer here — the caller decides whether it scopes to one assayer (invite) or groups across
 * all of them (inviteAll).
 */
export const ASSAYER_INVOICE_ELIGIBLE_SQL = (alias: string): string =>
  `${alias}.is_active = true
   AND ${alias}.status IN ('PENDING','APPROVED')
   AND ${alias}.on_hold = false
   AND ${alias}.assayer_invoice_id IS NULL
   AND ${alias}.pre_invoicing_era = false`;
