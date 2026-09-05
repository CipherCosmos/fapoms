import type { RegistrationChecklistItem } from './api.service';
import type { OutboxUpload } from './upload-outbox';
// Type-only, and therefore erased at compile time: this module must stay loadable in the
// package's node-only jest run, which cannot load the translator's native dependencies.
import type { TranslationKey } from '../i18n/i18n';

/**
 * How the registration checklist reads on screen.
 *
 * Two sources have to agree before a row can say anything true. The server knows what has
 * actually landed on the HR record; the on-device outbox knows what is still on its way. Neither
 * alone is enough — a checklist built only from the server tells somebody who photographed their
 * PAN card thirty seconds ago that it is still outstanding, and one built only from the outbox
 * forgets everything the moment the app is reinstalled.
 *
 * Kept as plain functions over plain data so the rules can be tested without a React Native
 * runtime, which this package's jest setup does not load.
 */

/** Where one requirement has got to, once both sources are taken into account. */
export type ChecklistRowState =
  /** Checked against the original by the office. Finished, and worth saying so. */
  | 'VERIFIED'
  /** The office has the scan. Nothing more to do. */
  | 'RECEIVED'
  /** Captured on this phone and on its way, or waiting for signal. */
  | 'SENDING'
  /** Captured, tried, and did not arrive. The one state that needs the person to act. */
  | 'FAILED'
  /**
   * The office looked at it and could not accept it.
   *
   * The state this checklist could not previously express, which is why it existed for months
   * without anybody being able to use it: the row returned RECEIVED on `hasScan` alone, so a
   * refused Aadhaar read "Received ✓" on the appraiser's phone for ever while the desk waited for
   * a replacement that the person had no idea was wanted.
   */
  | 'REJECTED'
  /** Nothing has been sent. */
  | 'NEEDED';

export interface ChecklistRow extends RegistrationChecklistItem {
  state: ChecklistRowState;
  /**
   * Which instruction to show for what to photograph, or null when there is nothing useful
   * to add.
   *
   * A catalogue key rather than a finished sentence, so that this module stays pure and the
   * language is decided where the row is painted. The rows are built inside a `useMemo` keyed
   * on the checklist and the outbox; a sentence resolved here would be frozen at whatever
   * language was active when that memo last ran, and would not follow a language change.
   */
  hintKey: TranslationKey | null;
}

/**
 * Which requirements have a "what to photograph" instruction written for them.
 *
 * The sentences themselves live in the translation catalogue under `registration.hints.*`, one
 * key per entry below. This list exists so that a requirement with no instruction — a new
 * document type the server starts asking for before anybody has written copy for it — produces
 * *nothing* rather than a key that the humanising fallback would turn into "Governance audit".
 * Silence is the intended behaviour there: the document's own name is already on the row, and a
 * padded sentence would add nothing but noise for the reader.
 *
 * The document's *name* is deliberately not translated anywhere: it arrives from the server and
 * the person is holding a physical paper they have to match it against. Renaming an NDA on
 * screen helps nobody searching a folder for the thing they signed. What does get simplified is
 * the instruction, which is where a low-literacy reader actually needs help — not what the
 * document is called, but which side of the card to hold up to the camera.
 */
const DOCUMENTED_REQUIREMENTS = [
  'PHOTOGRAPH', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'PAN_CARD', 'BANK_PASSBOOK', 'JOINING_FORM',
  'NDA', 'CODE_OF_CONDUCT', 'ETHICAL_CONDUCT_LETTER', 'ADDRESS_PROOF', 'DRIVING_LICENCE',
  'VOTER_ID', 'PASSPORT',
] as const;

type DocumentedRequirement = (typeof DOCUMENTED_REQUIREMENTS)[number];

const HINTED = new Set<string>(DOCUMENTED_REQUIREMENTS);

/** The catalogue key for a requirement's photography instruction, or null if none is written. */
export function hintKeyFor(requirement: string): TranslationKey | null {
  return HINTED.has(requirement)
    ? (`registration.hints.${requirement as DocumentedRequirement}` as TranslationKey)
    : null;
}

/** Outbox entries for registration documents, keyed by requirement, newest attempt winning. */
function inFlightByRequirement(uploads: OutboxUpload[]): Map<string, OutboxUpload> {
  const map = new Map<string, OutboxUpload>();
  for (const upload of uploads) {
    if (upload.target.kind !== 'REGISTRATION_DOCUMENT') continue;
    const existing = map.get(upload.target.requirement);
    // A person who retried after a failure has two entries for one requirement. The later one is
    // the attempt that counts — otherwise a successful retry would still read as failed.
    if (!existing || existing.createdAt.localeCompare(upload.createdAt) < 0) {
      map.set(upload.target.requirement, upload);
    }
  }
  return map;
}

export function rowStateFor(item: RegistrationChecklistItem, pending: OutboxUpload | undefined): ChecklistRowState {
  /**
   * A replacement already on its way outranks the verdict that asked for it.
   *
   * This is the ordering that matters and the one that is easy to get wrong. Somebody whose card
   * was refused photographs it again immediately; the checklist they are looking at still carries
   * the rejection, because it was fetched before the retake existed. Reading the server first
   * would tell them their document was refused while the replacement was in their own outbox, and
   * the obvious response to that is to send it a third time.
   */
  const retakenSinceRejection = Boolean(
    pending && item.rejectedAt && pending.createdAt.localeCompare(item.rejectedAt) > 0,
  );

  if (item.verificationStatus === 'REJECTED' && !retakenSinceRejection) return 'REJECTED';

  /**
   * Verified beats received, and both beat the outbox.
   *
   * `hasScan` used to be the first thing tested, and it short-circuited everything: it is the only
   * definition of "received" this feature has, but it says nothing about whether anybody looked at
   * the scan afterwards. A document that has been checked against its original is finished in a
   * way that "we have your photograph" is not, and a document that was refused is not finished at
   * all — neither could be said while `hasScan` answered first.
   */
  if (item.verificationStatus === 'VERIFIED' && item.hasScan) return 'VERIFIED';
  if (item.hasScan && !retakenSinceRejection) return 'RECEIVED';
  if (!pending) return item.hasScan ? 'RECEIVED' : 'NEEDED';

  switch (pending.status) {
    // Accepted by the server but this checklist was fetched before that happened. Showing
    // "still needed" here would tell somebody their upload had failed when it had just worked.
    case 'SENT':
      return 'RECEIVED';
    case 'FAILED':
      return 'FAILED';
    default:
      return 'SENDING';
  }
}

/** The checklist as rows, with in-flight uploads folded in. */
export function buildChecklistRows(
  items: RegistrationChecklistItem[],
  uploads: OutboxUpload[],
): ChecklistRow[] {
  const pending = inFlightByRequirement(uploads);
  return items.map((item) => ({
    ...item,
    state: rowStateFor(item, pending.get(item.requirement)),
    hintKey: hintKeyFor(item.requirement),
  }));
}

/**
 * What the home banner needs to decide whether to appear, and what to say.
 *
 * `outstanding` counts only *required* documents with nothing sent — an optional passport nobody
 * asked for must never make a complete file look incomplete, and neither must a scan that is
 * sitting in the outbox waiting for signal. `failed` is separate because it is the only number
 * that means something has gone wrong rather than something has not been done yet.
 */
export function checklistProgress(rows: ChecklistRow[]): {
  required: number;
  done: number;
  outstanding: number;
  failed: number;
} {
  const required = rows.filter((r) => !r.optional);
  return {
    required: required.length,
    // Checked counts as done as surely as received does — more so.
    done: required.filter((r) => r.state === 'RECEIVED' || r.state === 'VERIFIED').length,
    /**
     * A document that was sent back is outstanding, not finished.
     *
     * It has a file, so a count keyed on "has a scan" reads it as done — which would leave the
     * home banner saying the file is complete over a document the office is actively waiting for,
     * and the person would never open the checklist to find out.
     */
    outstanding: required.filter((r) => r.state === 'NEEDED' || r.state === 'REJECTED').length,
    failed: rows.filter((r) => r.state === 'FAILED').length,
  };
}
