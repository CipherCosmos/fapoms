import { randomUUID } from 'crypto';

/**
 * THE KEY MUST NOT SAY WHOSE DOCUMENT IT IS.
 *
 * Keys used to be built as `uploads/<timestamp>-<the file's own name>`, and people name files after
 * themselves: `Ramesh_Kulkarni_Aadhaar_front.pdf`. That string then travels everywhere a key goes —
 * request paths, error messages, log lines, a support ticket someone pastes it into, the storage
 * console. The object's CONTENTS are encrypted; its name was a caption announcing what the
 * ciphertext is and who it belongs to.
 *
 * So a key is now a random identifier and a date, and nothing else.
 *
 * ## Why the extension stays
 *
 * It carries no personal data, and two things read it: the browser decides whether a scan can be
 * drawn on a canvas from its extension, and the store infers a content type when one is missing.
 * Dropping it would break both to hide nothing.
 *
 * ## Existing keys
 *
 * Left alone. Renaming every object in the bucket would mean rewriting every row that points at
 * one, with no way back if it failed half way; the names are already out there in old logs, and the
 * fix that matters is that no NEW one is created. They age out with the documents they belong to.
 */

/** Extensions we will carry over from an uploaded name — lowercase, short, and letters/digits only. */
const SAFE_EXTENSION = /^\.[a-z0-9]{1,8}$/;

export function objectKeyFor(originalName: string, now: Date = new Date()): string {
  const dot = originalName.lastIndexOf('.');
  const raw = dot > 0 ? originalName.slice(dot).toLowerCase() : '';
  const extension = SAFE_EXTENSION.test(raw) ? raw : '';

  // Date segments, not a timestamp in the name: they make a bucket browsable by when things
  // arrived — which is how retention questions are asked — without identifying anybody.
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `uploads/${year}/${month}/${randomUUID()}${extension}`;
}
