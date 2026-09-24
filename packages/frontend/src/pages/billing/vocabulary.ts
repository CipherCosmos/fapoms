import { AssayerPayableStatus, AssayerInvoiceStatus, InvoiceStatus } from '@fapoms/shared';

/**
 * One word per thing, for every money screen.
 *
 * The audit that produced this file counted SIX names in the UI for a single object — the
 * assayer's bill was "Assayer Invoices" (the tab), "Assayer Bills" (the card inside it),
 * "Assayer Claims & Payables" (the hub button above it), "Assayer Claims (AINV Statements)"
 * (the sub-navigation), "Send Monthly Bills" (the button that creates one) and "Invite to
 * invoice" (the row link that creates one for a single assayer). The payout wore four:
 * "Payout", "Payable", "Claim" and "Disbursement Queue (Bank Payouts & CMS)". A clerk cannot
 * learn a screen whose nouns change between the button and the list the button fills.
 *
 * So the nouns live here and the screens import them. A new label is a change to this file,
 * which is the only way a vocabulary stays one vocabulary. The rule the names follow: plain
 * English for what the thing IS to the person using it, never the table it is stored in and
 * never the internal code (AINV, CMS, payable, receivable, entry).
 */

/** The assayer's periodic bill: the set of their completed work they are asked to confirm. */
export const BILL = { one: 'assayer bill', many: 'assayer bills', Cap: 'Assayer bill', CapMany: 'Assayer bills' } as const;

/** One line of what we owe one assayer for one assignment (`assayer_payables`). */
export const PAYOUT = { one: 'payout', many: 'payouts', Cap: 'Payout', CapMany: 'Payouts' } as const;

/** What a client owes us, as a document (`billing_invoices`). */
export const INVOICE = { one: 'client invoice', many: 'client invoices', Cap: 'Client invoice', CapMany: 'Client invoices' } as const;

/**
 * The five jobs the billing desk actually does, in the order a day runs through them.
 *
 * These are the tabs. They are named after the job, not after the table — "Pay assayers", not
 * "Payouts"; "Bill clients", not "Receivables" — because the person arriving at this page has a
 * task in mind, not an entity. The order is the dependency order: a claim must be approved
 * before it is a payout, a payout must be billed and approved before it is paid.
 */
export type BillingJob = 'todo' | 'expenses' | 'bills' | 'pay' | 'invoices' | 'final';

export const JOBS: ReadonlyArray<{ key: BillingJob; label: string; hint: string }> = [
  { key: 'todo', label: 'To do', hint: 'Everything waiting on you, in the order to do it' },
  { key: 'expenses', label: 'Expense claims', hint: 'Approve what assayers spent, so it can be paid with their fee' },
  { key: 'bills', label: 'Assayer bills', hint: 'Send the monthly bill, approve what assayers confirm' },
  { key: 'pay', label: 'Pay assayers', hint: 'Send the bank file, then record what the bank paid' },
  { key: 'invoices', label: 'Bill clients', hint: 'Invoice completed work, send it, record the payment' },
  /*
    The HOD's queue (2026-09-24). Shown only to whoever holds the final billing approval — see
    `Billing.tsx`. Last, because it is a different person's job, not a step in the office's day.
  */
  { key: 'final', label: 'Final approval', hint: 'Bills, payouts and client invoices the office approved, waiting for your final approval' },
];

/**
 * Old tab keys kept working.
 *
 * `?tab=assayer-invoices` is in the notification catalog's link contract (see the note where it
 * was defined in Billing.tsx), and `?tab=payouts` / `?tab=overview` are in people's bookmarks,
 * in old toasts and in at least one email template. Renaming a tab must not break a link that
 * was minted before the rename — so the old spellings resolve, silently, to the new job.
 */
export const JOB_ALIASES: Readonly<Record<string, BillingJob>> = {
  overview: 'todo',
  payouts: 'pay',
  'assayer-invoices': 'bills',
  expenses: 'expenses',
  invoices: 'invoices',
  'final-approval': 'final',
};

export const jobFromParam = (raw: string | null): BillingJob => {
  if (!raw) return 'todo';
  if (JOBS.some((j) => j.key === raw)) return raw as BillingJob;
  return JOB_ALIASES[raw] ?? 'todo';
};

/**
 * The stages a payout really moves through, which its `status` column cannot express.
 *
 * The pay screen used to filter by the raw status — All / Due / Approved / Paid / On hold — and
 * "Due" was the problem: it merges work sitting with an assayer for confirmation with work no
 * bill has reached yet. Those two need opposite handling. The desk cannot approve the first (the
 * server refuses: "awaiting assayer invoice AINV-… — approve the invoice instead") and normally
 * should not approve the second either, because the assayer has not seen the money. Showing them
 * as one list of 39 rows with an Approve button over it is how a clerk ends up pressing a button
 * that fails on half their selection.
 *
 * Each stage is a real query, not a client-side slice, so the counts and the pages agree.
 */
export type PayoutStage = 'WITH_ASSAYER' | 'NOT_BILLED' | 'AWAITING_HOD' | 'TO_PAY' | 'PAID' | 'HELD';

export const PAYOUT_STAGES: ReadonlyArray<{
  key: PayoutStage;
  label: string;
  /** What this stage is waiting for, said as the answer to "why is it sitting here?". */
  waitingOn: string;
  query: { status?: AssayerPayableStatus; onHold?: boolean; onBill?: boolean; hodApproved?: boolean };
}> = [
  {
    key: 'WITH_ASSAYER',
    label: 'With the assayer',
    waitingOn: 'On a bill the assayer has not confirmed yet. Nothing for you to do here — chase them, or approve the bill once it comes back.',
    query: { status: AssayerPayableStatus.PENDING, onHold: false, onBill: true },
  },
  {
    key: 'NOT_BILLED',
    label: 'Not billed yet',
    waitingOn: 'Completed work no bill has reached. Send a bill from the Assayer bills tab — or, for an assayer who cannot confirm one, approve it here as an exception.',
    query: { status: AssayerPayableStatus.PENDING, onHold: false, onBill: false },
  },
  {
    // The HOD's final approval (2026-09-24): approved here, not payable until the HOD approves too.
    key: 'AWAITING_HOD',
    label: 'Waiting for HOD approval',
    waitingOn: "Approved by the office, waiting for the HOD's final approval. They cannot be paid until then — nothing for you to do here.",
    query: { status: AssayerPayableStatus.APPROVED, onHold: false, hodApproved: false },
  },
  {
    key: 'TO_PAY',
    label: 'Ready to pay',
    waitingOn: 'Approved by the office and the HOD. Download the bank file, pay it, then record the payment here.',
    query: { status: AssayerPayableStatus.APPROVED, onHold: false, hodApproved: true },
  },
  { key: 'PAID', label: 'Paid', waitingOn: 'Settled. Kept for the record.', query: { status: AssayerPayableStatus.PAID } },
  { key: 'HELD', label: 'On hold', waitingOn: 'Stopped on purpose. It cannot be approved or paid until the hold is released.', query: { onHold: true } },
];

/**
 * The stage a bare `/billing?tab=pay` opens on.
 *
 * "Ready to pay" — the tab is called Pay assayers, and the money that is actually payable is
 * what somebody arriving there came for. The other stages are one click away and carry counts,
 * so nothing is hidden by choosing a default that matches the tab's name.
 */
export const payoutStage = (raw: string | null): PayoutStage =>
  (PAYOUT_STAGES.find((s) => s.key === raw)?.key ?? 'TO_PAY');

/**
 * Words for the bill's states, from the desk's side — "who is this sitting with, and what do I
 * do about it", not the enum's spelling.
 *
 * Moved here from shared.tsx so the pill, the filter chip, the timeline and the To-do queue all
 * read one list. They did not: the pill said "Waiting for Assayer" in title case while the
 * filter beside it said "Invited", for the same rows.
 */
export const BILL_STATE_LABEL: Record<AssayerInvoiceStatus, string> = {
  [AssayerInvoiceStatus.INVITED]: 'Waiting for the assayer',
  [AssayerInvoiceStatus.SUBMITTED]: 'Confirmed, needs your approval',
  [AssayerInvoiceStatus.APPROVED]: 'Approved, waiting for HOD approval',
  [AssayerInvoiceStatus.HOD_APPROVED]: 'Approved for payment',
  [AssayerInvoiceStatus.PAID]: 'Paid',
  [AssayerInvoiceStatus.CANCELLED]: 'Cancelled',
  [AssayerInvoiceStatus.SUPERSEDED]: 'Replaced by a revision',
};

/** The same, short enough for a filter chip. */
export const BILL_STATE_CHIP: Record<AssayerInvoiceStatus, string> = {
  [AssayerInvoiceStatus.INVITED]: 'With the assayer',
  [AssayerInvoiceStatus.SUBMITTED]: 'To approve',
  [AssayerInvoiceStatus.APPROVED]: 'With the HOD',
  [AssayerInvoiceStatus.HOD_APPROVED]: 'Approved for payment',
  [AssayerInvoiceStatus.PAID]: 'Paid',
  [AssayerInvoiceStatus.CANCELLED]: 'Cancelled',
  [AssayerInvoiceStatus.SUPERSEDED]: 'Replaced',
};

/** Client invoice states, said as where the document has got to. */
export const INVOICE_STATE_CHIP: Record<InvoiceStatus, string> = {
  [InvoiceStatus.DRAFT]: 'Draft, not sent',
  [InvoiceStatus.AWAITING_HOD]: 'With the HOD',
  [InvoiceStatus.HOD_APPROVED]: 'Ready to send',
  [InvoiceStatus.ISSUED]: 'Sent to client',
  [InvoiceStatus.PAID]: 'Paid',
  [InvoiceStatus.CANCELLED]: 'Cancelled',
};

/**
 * Which of `PAYOUT_STAGES` one payout is at, read off the row itself.
 *
 * The pay screen never needed this — each stage there is its own server query. A screen that
 * lists one person's payouts next to their work (the assayer record's "Work & pay" tab) gets the
 * rows back unsorted, and must name the stage in the same words the pay screen's chips use. So
 * the answer is derived from the SAME `query` each stage runs, not from a second table of rules:
 * a stage whose query changes moves every screen with it.
 *
 * `onBill` is "rides an assayer bill" — on the statement's rows, a non-null `invoiceNumber`.
 * Returns null for a payout no stage covers (a VOIDED one); say `payableStatusLabel` there.
 */
export const payoutStageOf = (p: {
  status: AssayerPayableStatus | string;
  onHold: boolean;
  onBill: boolean;
  /** Has the HOD's final approval. Omitted (a row that does not carry it) counts as "no". */
  hodApproved?: boolean;
}): (typeof PAYOUT_STAGES)[number] | null =>
  PAYOUT_STAGES.find(({ query: q }) =>
    (q.status === undefined || q.status === p.status)
    && (q.onHold === undefined || q.onHold === p.onHold)
    && (q.onBill === undefined || q.onBill === p.onBill)
    && (q.hodApproved === undefined || q.hodApproved === !!p.hodApproved),
  ) ?? null;

/**
 * The three money words for one person's pay, wherever it is totalled or itemised.
 *
 * "Outstanding" on the statement and "still owed" on the record would be two names for the same
 * figure on the way from one screen to the other; the plain one wins.
 */
export const PAY_WORDS = { earned: 'Earned', paid: 'Paid', owed: 'Still owed' } as const;
