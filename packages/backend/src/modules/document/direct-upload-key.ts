import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';

/**
 * Keys for the presigned direct upload, in one place.
 *
 * ## Why the object moves at finalize
 *
 * `POST /documents/upload/presign` hands the client a PUT URL for `documents/direct/<uuid>/<name>`,
 * and that URL stays valid until it expires whatever happens in between. The document used to be
 * registered AT that key, so for the rest of the URL's life anyone holding it could PUT a different
 * file over a document that had already been scanned, hashed and handed to the desk — and every
 * download after that served the replacement.
 *
 * So finalize reads the object once, scans and hashes that buffer, writes the SAME buffer to a key
 * derived here (`documents/final/<uuid><ext>`) that no URL was ever minted for, points the row at
 * it, and deletes the direct object. A late PUT to the old URL then lands on a key nothing refers to.
 *
 * ## Why the final key is derived, not random
 *
 * A retried finalize (the client lost the first response) must find the row the first attempt
 * created. The direct object is gone by then, so the retry is recognised by the final key, which is
 * a pure function of the direct key the client sends back.
 */

export const DIRECT_UPLOAD_PREFIX = 'documents/direct/';
export const FINAL_UPLOAD_PREFIX = 'documents/final/';

/**
 * Seconds a presigned PUT stays usable. Short on purpose: the client PUTs immediately after asking
 * (S3 checks the signature when the request starts, so a long transfer that began in time still
 * completes), and every second beyond that is a second a leaked URL can still write.
 */
export const PRESIGN_UPLOAD_EXPIRY_SECONDS = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Same extension rule as `object-key.ts`: lowercase, short, letters/digits only. */
const SAFE_EXTENSION = /^\.[a-z0-9]{1,8}$/;
/** What `directUploadKeyFor` produces for a file name — nothing else is a key we minted. */
const SAFE_NAME = /^[\w.-]{1,120}$/;

/** The key `presignUpload` mints for a client-supplied file name. */
export function directUploadKeyFor(fileName: string | undefined): string {
  const safeName = (fileName || 'upload.bin').replace(/[^\w.-]+/g, '_').slice(0, 120) || 'upload.bin';
  return `${DIRECT_UPLOAD_PREFIX}${randomUUID()}/${safeName}`;
}

/**
 * The server-owned key a finalized direct upload is moved to.
 *
 * Refuses anything that is not exactly the shape `directUploadKeyFor` produces — a prefix check
 * alone let `documents/direct/../<anything>` or a nested path through as "one of ours".
 */
export function finalKeyForDirectUpload(directKey: string): string {
  if (typeof directKey !== 'string' || !directKey.startsWith(DIRECT_UPLOAD_PREFIX)) {
    throw new BadRequestException('objectKey is not a direct-upload key issued by /documents/upload/presign.');
  }
  const rest = directKey.slice(DIRECT_UPLOAD_PREFIX.length);
  const slash = rest.indexOf('/');
  const id = slash > 0 ? rest.slice(0, slash) : '';
  const name = slash > 0 ? rest.slice(slash + 1) : '';
  if (!UUID.test(id) || !SAFE_NAME.test(name) || name === '.' || name === '..') {
    throw new BadRequestException('objectKey is not a direct-upload key issued by /documents/upload/presign.');
  }
  const dot = name.lastIndexOf('.');
  const raw = dot > 0 ? name.slice(dot).toLowerCase() : '';
  const extension = SAFE_EXTENSION.test(raw) ? raw : '';
  return `${FINAL_UPLOAD_PREFIX}${id.toLowerCase()}${extension}`;
}
