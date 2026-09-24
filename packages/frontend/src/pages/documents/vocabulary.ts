import { auditDocumentTypeLabel } from '@fapoms/shared';

/**
 * One word per thing on the Documents screens — and one explanation of each word.
 *
 * The stage a file is at was written out FOUR times: `BranchDocumentPanel` and
 * `DocumentControlPanel` held byte-identical eight-key maps, `DocumentModelLegend` restated six
 * of them as prose, and `DailyRunPanel` spoke a different key space that nonetheless reused the
 * words. They had already drifted — the legend collapsed "Excel ready" and "Completed" into one
 * row while the badges kept them apart, and the file-type names here said "Customer Master
 * Excel" where `@fapoms/shared` says "Customer Master Data".
 *
 * That is worse on this screen than most. Documents has a fold-out explainer titled "What are
 * these files and states?" — the page admitting it is not self-evident — and an explainer that
 * is written separately from the badges it explains is how a reader ends up more confused, not
 * less. Everything below is now the single source for both, so a badge and its explanation
 * cannot say different things.
 *
 * The rule this file follows, same as `billing/vocabulary.ts`: plain words for what the thing IS
 * to the person looking at it, never the column it is stored in.
 */

/** The pipeline a file moves along, in the order the backend counts it. */
export const DOCUMENT_STAGE_ORDER = [
  'UPLOADED', 'DISPATCHED', 'RECEIVED', 'SENT_TO_DATA_ENTRY',
  'SENT_TO_EXTERNAL_OCR', 'EXCEL_GENERATED', 'PROCESSED', 'COMPLETED',
] as const;

export type DocumentStage = (typeof DOCUMENT_STAGE_ORDER)[number];

export interface StageWords {
  /** The badge. */
  label: string;
  /** What the badge means, in one sentence — this is what the explainer prints. */
  meaning: string;
  color: string;
  bg: string;
}

export const DOCUMENT_STAGE: Record<DocumentStage, StageWords> = {
  UPLOADED: {
    label: 'Prepared',
    meaning: 'Uploaded here. The assayer cannot see it yet.',
    color: 'var(--accent)', bg: 'var(--status-pending-bg)',
  },
  DISPATCHED: {
    label: 'With assayer',
    meaning: 'Sent. The assayer can now open and download it on their phone.',
    color: 'var(--accent)', bg: 'var(--status-pending-bg)',
  },
  RECEIVED: {
    label: 'Returned',
    meaning: 'The assayer has sent their completed paperwork back.',
    color: 'var(--success)', bg: 'var(--status-completed-bg)',
  },
  SENT_TO_DATA_ENTRY: {
    label: 'Data entry',
    meaning: 'In the data entry queue to be typed up.',
    color: 'var(--accent)', bg: 'var(--status-pending-bg)',
  },
  SENT_TO_EXTERNAL_OCR: {
    label: 'External OCR',
    meaning: 'Pushed to the outside scanning application.',
    color: 'var(--warning)', bg: 'var(--status-pending-bg)',
  },
  EXCEL_GENERATED: {
    label: 'Excel ready',
    meaning: 'The scanned result has come back as a spreadsheet.',
    color: 'var(--success)', bg: 'var(--status-completed-bg)',
  },
  PROCESSED: {
    label: 'Processed',
    meaning: 'Checked and accepted by data entry.',
    color: 'var(--success)', bg: 'var(--status-completed-bg)',
  },
  COMPLETED: {
    label: 'Completed',
    meaning: 'Finished. Nothing further is owed on this file.',
    color: 'var(--success)', bg: 'var(--status-completed-bg)',
  },
};

/**
 * A file that has left the pipeline. It is not a stage anything moves THROUGH, so it stays out of
 * `DOCUMENT_STAGE_ORDER` (the counts and the legend walk that), but a superseded file still shows
 * up in a branch's history and must read as a word there — it used to fall through to the raw
 * `ARCHIVED`.
 */
export const DOCUMENT_ARCHIVED: StageWords = {
  label: 'Archived',
  meaning: 'Replaced by a newer copy or withdrawn. Kept for the record only.',
  color: 'var(--text-muted)', bg: 'var(--status-draft-bg)',
};

export const stageWords = (stage?: string | null): StageWords | null => {
  if (!stage) return null;
  if (stage === 'ARCHIVED') return DOCUMENT_ARCHIVED;
  return DOCUMENT_STAGE[stage as DocumentStage] ?? null;
};

/**
 * The kinds of file, left to right in the order the paperwork actually flows: the data in, the
 * packet out, the return, then what was read off it.
 */
export const DOCUMENT_TYPE_ORDER = [
  'CUSTOMER_MASTER_DATA', 'PRE_FIELD_AUDIT_PDF', 'AUDITED_RETURN_PDF', 'GENERATED_EXCEL',
] as const;

export type DocumentTypeKey = (typeof DOCUMENT_TYPE_ORDER)[number];

/**
 * The NAME comes from `@fapoms/shared` — the same one the rest of the product and the phone use.
 * Only what is genuinely local lives here: a short form for a narrow column, who produces the
 * file, and what it is for.
 */
export const DOCUMENT_TYPE: Record<DocumentTypeKey, { short: string; who: string; purpose: string }> = {
  CUSTOMER_MASTER_DATA: {
    short: 'Customer data',
    who: 'Ops upload it',
    purpose: "The bank's list of customer accounts for this branch, checked before the audit.",
  },
  PRE_FIELD_AUDIT_PDF: {
    short: 'Audit packet',
    who: 'Ops upload it, then send it',
    purpose: 'What the assayer needs to do the audit. Nothing reaches their phone until it is sent.',
  },
  AUDITED_RETURN_PDF: {
    short: 'Field return',
    who: 'The assayer sends it from the field',
    purpose: 'The completed paperwork, scanned after the visit. Data entry works from this.',
  },
  GENERATED_EXCEL: {
    short: 'OCR output',
    who: 'Data entry upload it',
    purpose: 'The spreadsheet produced once the return has been scanned.',
  },
};

/** The full name, from shared. Never spelled out again in this module. */
export const documentTypeLabel = (type?: string | null): string => auditDocumentTypeLabel(type);

/**
 * Only these two are uploaded from this console. The field return comes from the assayer's
 * phone, and the spreadsheet is produced from a specific return by its own action.
 */
export const UPLOADABLE_TYPES = new Set<string>(['CUSTOMER_MASTER_DATA', 'PRE_FIELD_AUDIT_PDF']);

/**
 * The day's run, which asks a different question: not "where is this file" but "what do I do
 * next". Kept beside the stages on purpose — the two vocabularies overlap ("With assayer" means
 * the same in both) and keeping them in one file is what stops that being a coincidence.
 */
export const DAILY_RUN_STEP = {
  AWAITING_CLIENT_DATA: {
    label: 'No client data',
    hint: "This branch is scheduled today but is not in the client's file.",
    color: 'var(--danger)', bg: 'var(--status-cancelled-bg)',
  },
  GENERATE_PDF: {
    label: 'Generate packet',
    hint: 'Client data is in. Produce the audit PDF in the external app, then upload it here.',
    color: 'var(--accent)', bg: 'var(--status-pending-bg)',
  },
  DISPATCH: {
    label: 'Send to assayer',
    hint: 'Packet is ready but the assayer cannot see it until it is sent.',
    color: 'var(--accent)', bg: 'var(--status-pending-bg)',
  },
  AWAITING_ASSAYER_RETURN: {
    label: 'With assayer',
    hint: 'Sent. Waiting for the scanned paperwork to come back.',
    color: 'var(--warning)', bg: 'var(--status-pending-bg)',
  },
  SEND_TO_OCR: {
    label: 'Send for scanning',
    hint: 'Paperwork is back. Push it to the external OCR application.',
    color: 'var(--accent)', bg: 'var(--status-pending-bg)',
  },
  IN_PROGRESS: {
    label: 'In processing',
    hint: 'With OCR or data entry.',
    color: 'var(--success)', bg: 'var(--status-completed-bg)',
  },
} as const;
