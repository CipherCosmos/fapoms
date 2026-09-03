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

  it('says nothing rather than padding when there is no useful instruction', () => {
    // Null, not a key: a requirement nobody has written copy for renders no hint line at all,
    // rather than a humanised guess at what its name might mean.
    expect(buildChecklistRows([item({ requirement: 'GOVERNANCE_AUDIT' })], [])[0].hintKey).toBeNull();
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
