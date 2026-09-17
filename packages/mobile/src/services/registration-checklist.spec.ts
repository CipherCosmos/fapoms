/**
 * What a field worker is told about their own paperwork.
 *
 * Two failures are being guarded against here, and they pull in opposite directions.
 *
 * The first is the one that made this feature necessary: the HR record carries a
 * `soft_copy_received` flag that is true on 10,977 rows with no file behind any of them — it
 * records what a migrated spreadsheet asserted, not that a scan exists. Believing it would tell
 * almost every assayer their registration was complete when nothing has ever been uploaded. The
 * server does not send that flag at all, and `hasScan` is the only thing here that means
 * "received".
 *
 * The second is telling somebody their document is still needed thirty seconds after they
 * photographed it, because the checklist was fetched before the upload landed. The on-device
 * outbox knows what is in flight; folding it in is what stops the screen calling a person's work
 * undone.
 */

import { t } from '../i18n/i18n';
import type { RegistrationChecklistItem } from './api.service';
import type { OutboxUpload } from './upload-outbox';
import { buildChecklistRows, checklistProgress, rowStateFor } from './registration-checklist';

const item = (overrides: Partial<RegistrationChecklistItem> = {}): RegistrationChecklistItem => ({
  requirement: 'PAN_CARD',
  label: 'PAN card',
  optional: false,
  identity: true,
  hasScan: false,
  fileCount: 0,
  verificationStatus: null,
  expiryDate: null,
  hasNumber: false,
  ...overrides,
});

const upload = (overrides: Partial<OutboxUpload> & { requirement?: string } = {}): OutboxUpload => {
  const { requirement = 'PAN_CARD', ...rest } = overrides;
  return {
    id: 'u1',
    target: { kind: 'REGISTRATION_DOCUMENT', assayerId: 'me', requirement, documentLabel: 'PAN card' },
    fileName: 'pan.jpg',
    fileUri: 'file:///cache/pan.jpg',
    status: 'PENDING',
    progress: 0,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...rest,
  } as OutboxUpload;
};

describe('what counts as received', () => {
  it('a file on the record is the only thing that means received', () => {
    expect(rowStateFor(item({ hasScan: true, fileCount: 1 }), undefined)).toBe('RECEIVED');
  });

  it('nothing sent and nothing in flight is still needed', () => {
    expect(rowStateFor(item(), undefined)).toBe('NEEDED');
  });

  /**
   * The defect this whole feature turns on. The server never sends `softCopyReceived`, so there
   * is no field here to be fooled by — this pins that a row carrying every other "yes" signal,
   * with no file, is still outstanding.
   */
  it('a verified row with no file is NOT received', () => {
    const claimed = item({
      hasScan: false,
      fileCount: 0,
      hasNumber: true,
      verificationStatus: 'VERIFIED',
    });

    expect(rowStateFor(claimed, undefined)).toBe('NEEDED');
  });
});

describe('folding in what is still on its way', () => {
  it('reads as sending while the upload is queued', () => {
    expect(rowStateFor(item(), upload({ status: 'PENDING' }))).toBe('SENDING');
    expect(rowStateFor(item(), upload({ status: 'SENDING' }))).toBe('SENDING');
  });

  it('reads as failed so the person knows to try again', () => {
    expect(rowStateFor(item(), upload({ status: 'FAILED' }))).toBe('FAILED');
  });

  /**
   * The server accepted it, but this checklist was fetched before that happened. Saying "still
   * needed" here tells somebody their upload failed at the exact moment it worked.
   */
  it('a delivered upload is received even when the checklist is stale', () => {
    expect(rowStateFor(item({ hasScan: false }), upload({ status: 'SENT' }))).toBe('RECEIVED');
  });

  it('the record beats a stale local failure', () => {
    expect(rowStateFor(item({ hasScan: true }), upload({ status: 'FAILED' }))).toBe('RECEIVED');
  });

  /** A retry leaves two entries for one requirement; the later attempt is the one that counts. */
  it('a successful retry is not still reported as failed', () => {
    const rows = buildChecklistRows(
      [item()],
      [
        upload({ id: 'first', status: 'FAILED', createdAt: '2026-09-01T10:00:00.000Z' }),
        upload({ id: 'second', status: 'SENT', createdAt: '2026-09-01T11:00:00.000Z' }),
      ],
    );

    expect(rows[0].state).toBe('RECEIVED');
  });

  it('ignores audit packets sharing the queue', () => {
    const packet = {
      ...upload(),
      target: { kind: 'ASSIGNMENT_PACKET', assignmentId: 'a1', branchName: 'Kollam' },
    } as OutboxUpload;

    expect(buildChecklistRows([item()], [packet])[0].state).toBe('NEEDED');
  });
});

describe('the instructions on screen', () => {
  it('explains which side of the card to photograph, without naming the enum', () => {
    const rows = buildChecklistRows(
      [item({ requirement: 'AADHAAR_BACK', label: 'Aadhaar — back' })],
      [],
    );

    // Asserted through the translator rather than on the raw field: what must never reach the
    // screen is the enum, and since the instruction became a catalogue key it is the *rendered*
    // sentence that has to be checked for it.
    expect(rows[0].hintKey).not.toBeNull();
    expect(t(rows[0].hintKey!)).toBe('The side with your address on it.');
    expect(t(rows[0].hintKey!)).not.toMatch(/AADHAAR_BACK/);
  });

  /**
   * A document nobody wrote a sentence for used to render no instruction at all — fifteen of the
   * twenty-eight, including every paper a proprietor is asked for. It now falls back to the shared
   * scanning profile's sentence for that KIND of document, which is the same table the browser
   * scanner reads, so the two apps cannot drift into telling people different things.
   */
  it('falls back to the sentence for that kind of document, rather than saying nothing', () => {
    const row = buildChecklistRows([item({ requirement: 'RENT_AGREEMENT' })], [])[0];

    expect(row.hintKey).toBe('scanner.hint.page');
    expect(t(row.hintKey!)).toMatch(/Flatten the page/i);
    expect(t(row.hintKey!)).not.toMatch(/RENT_AGREEMENT/);
  });

  /** The hand-written sentence wins where there is one: it was written for this app's reader. */
  it('prefers the hand-written instruction over the general one', () => {
    const row = buildChecklistRows([item({ requirement: 'PAN_CARD' })], [])[0];

    expect(row.hintKey).toBe('registration.hints.PAN_CARD');
    expect(t(row.hintKey!)).toMatch(/all four corners/i);
  });

  it('still says nothing for a requirement that is not a document at all', () => {
    expect(buildChecklistRows([item({ requirement: 'NOT_A_DOCUMENT' })], [])[0].hintKey).toBeNull();
  });
});

describe('what the home banner is told', () => {
  it('counts only required documents with nothing sent', () => {
    const progress = checklistProgress(
      buildChecklistRows(
        [
          item({ requirement: 'PAN_CARD', hasScan: true }),
          item({ requirement: 'NDA' }),
          item({ requirement: 'PHOTOGRAPH' }),
        ],
        [],
      ),
    );

    expect(progress).toEqual({ required: 3, done: 1, outstanding: 2, failed: 0 });
  });

  /**
   * An optional passport nobody asked for must never make a complete file look incomplete —
   * that is the difference between a helpful screen and one that can never be satisfied.
   */
  it('an unsent optional document is not outstanding', () => {
    const progress = checklistProgress(
      buildChecklistRows(
        [item({ requirement: 'PAN_CARD', hasScan: true }), item({ requirement: 'PASSPORT', optional: true })],
        [],
      ),
    );

    expect(progress.required).toBe(1);
    expect(progress.outstanding).toBe(0);
  });

  /** A scan waiting for signal is work the person has already done. Do not ask for it again. */
  it('a document waiting in the outbox is not outstanding', () => {
    const progress = checklistProgress(
      buildChecklistRows([item({ requirement: 'PAN_CARD' })], [upload({ status: 'PENDING' })]),
    );

    expect(progress.outstanding).toBe(0);
    expect(progress.done).toBe(0);
  });

  it('surfaces a failed upload separately from work not yet done', () => {
    const progress = checklistProgress(
      buildChecklistRows(
        [item({ requirement: 'PAN_CARD' }), item({ requirement: 'NDA' })],
        [upload({ status: 'FAILED' })],
      ),
    );

    expect(progress.failed).toBe(1);
    expect(progress.outstanding).toBe(1);
  });

  it('an empty checklist asks for nothing', () => {
    expect(checklistProgress(buildChecklistRows([], []))).toEqual({
      required: 0, done: 0, outstanding: 0, failed: 0,
    });
  });
});

/**
 * A rejection the person can actually see, and the ordering that makes it usable.
 *
 * This checklist returned RECEIVED on `hasScan` alone, so a refused Aadhaar read "Received ✓" on
 * the appraiser's phone for ever while the desk waited for a replacement nobody had asked them
 * for. The whole verdict was already in the payload and simply never read.
 */
describe('a scan the office sent back', () => {
  const REJECTED_AT = '2026-09-01T09:00:00.000Z';
  const rejected = (over = {}) => item({
    hasScan: true, fileCount: 1, verificationStatus: 'REJECTED',
    rejectionReason: 'ILLEGIBLE', rejectedAt: REJECTED_AT, ...over,
  });

  it('says it was sent back, rather than that it was received', () => {
    expect(rowStateFor(rejected(), undefined)).toBe('REJECTED');
  });

  /**
   * The ordering that matters. Somebody whose card was refused photographs it again immediately,
   * and the checklist in front of them still carries the rejection because it was fetched before
   * the retake existed. Reading the server first tells them it was refused while the replacement
   * is in their own outbox — and the obvious response to that is to send it a third time.
   */
  it('shows the replacement already going, not the verdict that asked for it', () => {
    const retake = upload({ createdAt: '2026-09-01T09:05:00.000Z', status: 'PENDING' });
    expect(rowStateFor(rejected(), retake)).toBe('SENDING');
  });

  it('still says sent back when the only upload predates the rejection', () => {
    // The upload that WAS refused. It is not a replacement, and treating it as one would hide the
    // rejection behind the very file that caused it.
    const original = upload({ createdAt: '2026-09-01T08:00:00.000Z', status: 'SENT' });
    expect(rowStateFor(rejected(), original)).toBe('REJECTED');
  });

  it('reports a failed replacement as failed, so they know to try again', () => {
    const retake = upload({ createdAt: '2026-09-01T09:05:00.000Z', status: 'FAILED' });
    expect(rowStateFor(rejected(), retake)).toBe('FAILED');
  });

  it('counts a sent-back document as still outstanding on the home banner', () => {
    // A file that was refused is not a file the office has. Counting it as done would leave the
    // banner reading "complete" over a document somebody is waiting for.
    const rows = buildChecklistRows([rejected()], []);
    expect(checklistProgress(rows).outstanding).toBe(1);
  });
});

/**
 * Checked is not the same as received, and saying so is the difference between "we have your
 * photograph" and "you are done".
 */
describe('a scan the office has checked', () => {
  it('says it was checked against the original', () => {
    expect(rowStateFor(item({ hasScan: true, fileCount: 1, verificationStatus: 'VERIFIED' }), undefined))
      .toBe('VERIFIED');
  });

  it('does not claim a check when no scan is on file', () => {
    // A verdict with no file behind it is the shape of the 11,160 rows the roster import wrote.
    expect(rowStateFor(item({ hasScan: false, verificationStatus: 'VERIFIED' }), undefined))
      .toBe('NEEDED');
  });
});
