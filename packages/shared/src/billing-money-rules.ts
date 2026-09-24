/**
 * Money rules the web, the field app and the server must compute identically (2026-09-24 audit).
 *
 *  - `roundMoney` — THE rounding of a rupee figure to paise. Every `round2` in the product is this.
 *  - `indianFinancialYear` — April to March, on the Indian calendar day (IST), never the server's.
 *  - `formatClientInvoiceNumber` — the client invoice number series, `INV/25-26/000123`.
 *  - `tds194jDeduction` — withholding under s.194J with the annual threshold, including the
 *    catch-up on the payable that crosses it.
 *  - `PayoutDestinationCheck` — what the approver, the HOD and the payer are told about the bank
 *    account a payout will go to.
 */

// ---------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------

/**
 * Round a rupee figure to paise, half away from zero, as a person would on paper.
 *
 * `Math.round(n * 100) / 100` is wrong for about one figure in every few hundred that ends in a
 * half paisa, because the multiplication happens in binary: `1.005 * 100` is `100.49999999999999`,
 * so ₹1.005 rounded to ₹1.00 — and `10000.005` to `10000.00`. On a GST or TDS line that is a paisa
 * missing from a statutory figure, and a paisa that the two sides of the ledger disagree on.
 *
 * `toPrecision(15)` removes the binary noise the multiplication introduced (a double carries 15-17
 * significant digits; money here never needs more than 15 — ₹99,99,99,99,999.99 is 13), so the
 * half is seen as a half. Negative figures (credits) round away from zero too, so a credit and the
 * charge it reverses round to the same size. Non-finite input passes through unchanged, as before.
 */
export function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return n;
  const sign = n < 0 ? -1 : 1;
  const shifted = Number((Math.abs(n) * 100).toPrecision(15));
  const rounded = Math.round(shifted) / 100;
  // `|| 0` turns -0 into 0, so a zeroed credit never prints as "-0.00".
  return sign * rounded || 0;
}

// ---------------------------------------------------------------------------
// The Indian financial year
// ---------------------------------------------------------------------------

export interface IndianFinancialYear {
  /** The calendar year the financial year starts in: 2025 for FY 2025-26. */
  startYear: number;
  /** The short form printed on invoices: `25-26`. */
  label: string;
  /** First and last calendar day, inclusive, `YYYY-MM-DD`. */
  from: string;
  to: string;
}

const pad2 = (n: number) => String(((n % 100) + 100) % 100).padStart(2, '0');

/**
 * The financial year (1 April – 31 March) a moment falls in, judged on the Indian calendar day.
 *
 * A payable booked at 02:00 IST on 1 April is in the NEW year, though the server's UTC clock still
 * says 31 March — which is exactly the boundary a TDS threshold and an invoice series reset on.
 * Accepts a `Date`, an ISO timestamp or a `YYYY-MM-DD` day key (taken as that Indian day).
 */
export function indianFinancialYear(value: Date | string | number): IndianFinancialYear {
  let key: string;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    key = value;
  } else {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new Error(`Not a date: ${String(value)}`);
    key = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  }
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  return {
    startYear,
    label: `${pad2(startYear)}-${pad2(startYear + 1)}`,
    from: `${startYear}-04-01`,
    to: `${startYear + 1}-03-31`,
  };
}

// ---------------------------------------------------------------------------
// Client invoice numbers
// ---------------------------------------------------------------------------

/** The widest serial the 6-digit field holds. The 1,000,000th invoice in one year is refused. */
export const CLIENT_INVOICE_SERIAL_MAX = 999_999;

/** Every number minted since 2026-09-24. Older invoices keep whatever number they were given. */
export const CLIENT_INVOICE_NUMBER_PATTERN = /^INV\/\d{2}-\d{2}\/\d{6}$/;

/**
 * `INV/25-26/000123` — the owner's format (2026-09-24): consecutive within a financial year, six
 * digits, zero-padded, 16 characters. GST Rule 46 asks for a consecutive serial of at most 16
 * characters, unique for the financial year; this meets it with the year in the number itself so
 * the same serial in two years never collides.
 */
export function formatClientInvoiceNumber(fyLabel: string, serial: number): string {
  if (!/^\d{2}-\d{2}$/.test(fyLabel)) throw new Error(`Not a financial-year label: ${fyLabel}`);
  if (!Number.isInteger(serial) || serial < 1 || serial > CLIENT_INVOICE_SERIAL_MAX) {
    throw new Error(`Invoice serial ${serial} is outside 1–${CLIENT_INVOICE_SERIAL_MAX}.`);
  }
  return `INV/${fyLabel}/${String(serial).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// TDS under s.194J, with the annual threshold
// ---------------------------------------------------------------------------

export interface Tds194jInput {
  /** This payable's professional fee: base + travel, before TDS. */
  gross: number;
  /** The rate that applies to this deductee now, in percent (the normal rate, or s.206AA's). */
  ratePct: number;
  /** `billing.tds194jThresholdRupees`. 0 means no threshold: every payable is withheld on. */
  thresholdRupees: number;
  /** The fees on this assayer's OTHER live fee payables in the same financial year. */
  fyGrossBefore: number;
  /** The TDS already on those payables. */
  fyTdsBefore: number;
}

export type Tds194jBasis =
  /** No threshold configured — the rate on this payable's own fee (the behaviour before 2026-09-24). */
  | 'NO_THRESHOLD'
  /** The year's fees, this payable included, have not gone past the threshold. Nothing is withheld. */
  | 'BELOW_THRESHOLD'
  /** This payable takes the year past the threshold and carries the catch-up for the whole year. */
  | 'CROSSED'
  /** The year was already past the threshold. */
  | 'ABOVE';

export interface Tds194jOutcome {
  tds: number;
  basis: Tds194jBasis;
  /** The year's fees including this payable — what the threshold was compared with. */
  fyGrossIncluding: number;
}

/**
 * The TDS to withhold from ONE fee payable, under s.194J with its annual threshold.
 *
 * The threshold is an AGGREGATE for the financial year, not a per-payment limit: nothing is
 * deducted while the year's fees to this assayer stay at or under it; once they go past it, tax is
 * due on the WHOLE year's fees, the earlier ones included. So the payable that crosses the line
 * carries a catch-up, and every payable after it is withheld at the rate:
 *
 *     tds = rate × (the year's fees, this one included) − TDS already withheld this year
 *
 * floored at zero (an earlier payable withheld at the higher no-PAN rate has already covered more)
 * and capped at this payable's own fee (a payout cannot go negative; whatever could not be withheld
 * here is picked up by the next payable, because the formula always looks at the whole year).
 *
 * Voided payables are not in `fyGrossBefore`/`fyTdsBefore` — the caller reads live rows only — so
 * a voided payable that carried the catch-up simply hands it to the next one.
 *
 * Confirm the threshold and the reading with your CA; the platform setting says so too.
 */
export function tds194jDeduction(input: Tds194jInput): Tds194jOutcome {
  const gross = roundMoney(Math.max(0, Number(input.gross) || 0));
  const rate = Math.max(0, Number(input.ratePct) || 0) / 100;
  const threshold = Math.max(0, Number(input.thresholdRupees) || 0);
  const before = roundMoney(Math.max(0, Number(input.fyGrossBefore) || 0));
  const withheld = roundMoney(Math.max(0, Number(input.fyTdsBefore) || 0));
  const including = roundMoney(before + gross);

  if (threshold <= 0) {
    return { tds: roundMoney(gross * rate), basis: 'NO_THRESHOLD', fyGrossIncluding: including };
  }
  if (including <= threshold) {
    return { tds: 0, basis: 'BELOW_THRESHOLD', fyGrossIncluding: including };
  }
  const due = roundMoney(including * rate - withheld);
  const tds = roundMoney(Math.min(gross, Math.max(0, due)));
  return { tds, basis: before > threshold ? 'ABOVE' : 'CROSSED', fyGrossIncluding: including };
}

// ---------------------------------------------------------------------------
// The bank account a payout goes to
// ---------------------------------------------------------------------------

/** Refusal: the account (number and IFSC) is also on another assayer's record. */
export const PAYOUT_DESTINATION_SHARED_MESSAGE =
  "This bank account (the same account number and IFSC) is on another assayer's record. "
  + 'Payment to it is refused until one of the two records is corrected.';

/** Warning: neither a verified passbook nor a verified identity document backs the account. */
export const PAYOUT_DESTINATION_UNVERIFIED_WARNING =
  'Bank details are not verified — there is no verified bank passbook and no verified identity '
  + 'document on file. The money will go to the account typed on the record.';

/** Warning: the record changed after the destination was frozen at approval. */
export function payoutDestinationChangedWarning(snapshotTail: string, recordTail: string): string {
  return `The assayer's bank details changed after this payout was approved. It will still be paid to `
    + `account ${snapshotTail}; the record now says ${recordTail || 'nothing'}. Put it on hold and release `
    + 'it to pay the account on the record.';
}

/** What the approve, final-approve and pay screens are told about one payout's destination. */
export interface PayoutDestinationCheck {
  payableId: string;
  payableNumber: string;
  assayerId: string;
  assayerName: string | null;
  assayerCode: string | null;
  /** A verified passbook, or an established identity, backs the account on the record. */
  verified: boolean;
  /** The account on the record is also on another assayer's record — approval is refused. */
  sharedWithAnotherRecord: boolean;
  /** A destination was frozen at approval and the record now says something else. */
  snapshotDiffersFromRecord: boolean;
  /** Masked to the last four; never the whole number. */
  snapshotAccountTail: string | null;
  recordAccountTail: string | null;
  /** Plain sentences for the screen. Empty when there is nothing to say. */
  warnings: string[];
  /** The refusal the approval would give, or null when it would go through. */
  blocking: string | null;
}
