import { createHash } from 'crypto';
import { Transform, TransformCallback } from 'stream';

/**
 * Serve a stored document only if it is still the document that was recorded.
 *
 * `documents.content_sha256` is the hash of the bytes as they were accepted (scanned, typed,
 * hashed — see document-integrity.ts). Nothing compared it with what storage returned later, so an
 * object replaced in the store — the presigned-URL overwrite this module's sibling
 * `direct-upload-key.ts` closes, or anyone with write access to the bucket — was served as the
 * recorded evidence with a 200 and the original file name.
 *
 * The gate hashes the stream as it passes and HOLDS the bytes back until the hash is known. A
 * mismatch therefore reaches the caller before any byte of the file has been sent, and the route can
 * refuse with a proper status instead of a truncated body.
 *
 * Holding is bounded. A file larger than `holdLimitBytes` cannot be held whole without an unbounded
 * buffer per download, so past the limit the gate releases everything except the most recent chunk
 * and still withholds the tail until the hash is checked: a mismatch then aborts the transfer short
 * of its Content-Length, which every HTTP client reports as a failed download rather than a
 * complete file. Degraded, but never "served as good".
 *
 * Ranged requests (resume of an interrupted download) are not gated — a slice cannot be checked
 * against the hash of the whole — and are served as before.
 */

export class DocumentIntegrityMismatchError extends Error {
  constructor(
    readonly expectedSha256: string,
    readonly actualSha256: string,
  ) {
    super(
      'DOCUMENT_INTEGRITY_MISMATCH: the stored file no longer matches the hash recorded when it was '
      + 'accepted. It has not been served.',
    );
    this.name = 'DocumentIntegrityMismatchError';
  }
}

/** Whole-file hold for anything up to this size; the tail-withhold fallback beyond it. */
export const DOWNLOAD_INTEGRITY_HOLD_LIMIT_BYTES = 25 * 1024 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** True when a row carries a hash this gate can check against. Rows before integrity recording do not. */
export function hasRecordedSha256(value: string | null | undefined): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value.trim().toLowerCase());
}

export function integrityGate(
  expectedSha256: string,
  holdLimitBytes: number = DOWNLOAD_INTEGRITY_HOLD_LIMIT_BYTES,
): Transform {
  const expected = expectedSha256.trim().toLowerCase();
  const hash = createHash('sha256');
  const held: Buffer[] = [];
  let heldBytes = 0;

  return new Transform({
    transform(chunk: Buffer | string, _enc: BufferEncoding, done: TransformCallback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buf);
      held.push(buf);
      heldBytes += buf.length;
      // Past the hold limit: release all but the newest chunk, so the end of the file still waits
      // on the verdict.
      if (heldBytes > holdLimitBytes) {
        while (held.length > 1) {
          const out = held.shift()!;
          heldBytes -= out.length;
          this.push(out);
        }
      }
      done();
    },
    flush(done: TransformCallback) {
      const actual = hash.digest('hex');
      if (actual !== expected) {
        held.length = 0;
        done(new DocumentIntegrityMismatchError(expected, actual));
        return;
      }
      for (const out of held) this.push(out);
      held.length = 0;
      done();
    },
  });
}
