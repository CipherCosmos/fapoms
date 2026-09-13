import { isValidPan, isValidGstin, isGstinOrPan, GSTIN_OR_PAN_REFUSAL } from '@fapoms/shared';

/**
 * A client's registered tax identifier has always been free text, and it holds either a GSTIN
 * (a GST-registered entity) or a bare PAN (an individual, or a client not yet GST-registered) -
 * both shapes are already documented uses of this one column, so the hint accepts either rather
 * than picking one and flagging the other.
 *
 * Advisory only, matching the house convention (`AssayerForms.tsx`'s `formatHint`): a value that
 * matches neither shape gets a note under the field, never a blocked save. Every write path here
 * already tolerates a freeform tax number for a client that supplies something else entirely (a
 * foreign registration, a TIN), and this must not regress that.
 */
export function taxIdHint(value: string): string | null {
  const v = (value || '').trim();
  if (!v) return null;
  if (isValidGstin(v) || isValidPan(v)) return null;
  return "Doesn't look like a GSTIN (e.g. 27ABCDE1234F1Z5) or a PAN (e.g. ABCDE1234F) - double-check before saving.";
}

/**
 * The same field, on the screen where the rule is enforced.
 *
 * `taxIdHint` above is advice, and on the BILLING tax identifier that is the truth: the column
 * takes anything, including a foreign registration or a TIN. On a CLIENT's `taxId` it was not —
 * the API refuses a value matching neither shape — and both screens printed the same grey
 * "double-check before saving". So one of them was telling an operator to look twice at something
 * that would be accepted, and the other was telling them to look twice at something that would be
 * thrown back. Identical words, opposite outcomes, nothing on screen to tell them apart.
 *
 * This returns the API's own sentence, so what the form warns and what the server would say
 * cannot drift into two different explanations of one rule.
 */
export function taxIdRefusal(value: string): string | null {
  return isGstinOrPan(value) ? null : GSTIN_OR_PAN_REFUSAL;
}

/**
 * A second, independent note about the same field, for the one consequence a bare PAN carries
 * that `taxIdHint` above deliberately stays silent on.
 *
 * The tax invoice document (`BillingEngineService.getInvoiceDocument`) derives "place of supply"
 * from the GSTIN's two-digit state prefix (`gstinStateCode` in `@fapoms/shared`'s gst.ts) — a PAN
 * has no state prefix, so a client stored with a PAN instead of a GSTIN will show "place of
 * supply unknown" on every invoice and fall back to an assumed intra-state (CGST+SGST) split,
 * flagged there but only there. A billing operator entering a PAN here has no way to know that
 * choice has a downstream tax consequence until a real invoice is generated. This surfaces it at
 * the point of entry instead, still advisory only — never a reason to block the save, matching
 * `taxIdHint`'s contract, which is why this is a second function rather than a change to it.
 */
export function taxIdGstinConsequenceHint(value: string): string | null {
  const v = (value || '').trim();
  if (!v || isValidGstin(v)) return null;
  if (!isValidPan(v)) return null; // taxIdHint above already flags a value matching neither shape
  return 'This is a PAN, not a GSTIN — invoices for this client will show "place of supply unknown" and assume same-state tax (CGST + SGST) until a full GSTIN is entered.';
}
