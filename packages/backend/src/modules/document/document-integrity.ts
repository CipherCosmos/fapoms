import { createHash } from 'crypto';

/**
 * What a stored document actually is, computed from the bytes that arrived.
 *
 * Every integrity field on a `documents` row used to come from the request. `file_size` was
 * multer's count (real enough), but `mime_type` was the `Content-Type` the uploading client wrote
 * into the multipart part header — a claim, not an observation — and there was no content hash of
 * any kind, so nothing recorded could tell you whether the file on disk today is the file that was
 * uploaded. For a system whose documents are audit evidence, that is the whole point of storing
 * them.
 *
 * A client-declared type is not evidence: a renamed executable announces itself as a PDF for the
 * asking, and an honest client that mislabels a scan makes the same row. So the type is sniffed
 * from the leading bytes and the declared value is kept alongside it as a separate, clearly
 * labelled claim. Where the two disagree, the sniffed value is the one recorded and the
 * disagreement is preserved rather than smoothed over.
 */

/** Everything derived from the received bytes. Nothing here comes from the request. */
export interface DerivedFileIntegrity {
  /** Lower-case hex SHA-256 of the exact bytes stored. */
  sha256: string;
  /** Byte length, counted here rather than taken from any header. */
  byteLength: number;
  /** MIME type read from the file's own leading bytes, or null when unrecognised. */
  sniffedMimeType: string | null;
  /** What the uploader claimed, recorded as a claim. */
  declaredMimeType: string | null;
  /** True when a declared type was given and the bytes say otherwise. */
  mimeTypeMismatch: boolean;
  /** The type to store: sniffed where we could read it, else the claim, else octet-stream. */
  effectiveMimeType: string;
}

/**
 * Magic-byte signatures for the formats this product actually stores.
 *
 * Deliberately a short, explicit table rather than a dependency: these are the types the upload
 * validation already admits, the signatures are stable, and a lookup nobody can read is worse
 * than one that is a little shorter. `offset` exists for the containers that do not start at
 * byte zero.
 */
const SIGNATURES: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },                 // %PDF
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },                       // GIF8
  { mime: 'image/webp', bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },           // RIFF....WEBP
  { mime: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { mime: 'image/tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  // ZIP container. Office documents (.xlsx, .docx) and .zip share it; the container is as far as
  // magic bytes can honestly take us, and claiming more would be guessing.
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x05, 0x06] },
  // Legacy Office compound binary (.xls, .doc).
  { mime: 'application/vnd.ms-office', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];

/** Office formats that are legitimately ZIP containers, so a "mismatch" here is not one. */
const ZIP_BACKED_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
]);

/** Legacy Office formats behind the compound-binary signature. */
const COMPOUND_BINARY_MIME_TYPES = new Set([
  'application/vnd.ms-excel',
  'application/msword',
  'application/vnd.ms-powerpoint',
  'application/vnd.ms-office',
]);

export function sniffMimeType(buffer: Buffer): string | null {
  for (const sig of SIGNATURES) {
    const at = sig.offset ?? 0;
    if (buffer.length < at + sig.bytes.length) continue;
    let hit = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[at + i] !== sig.bytes[i]) { hit = false; break; }
    }
    if (hit) return sig.mime;
  }
  return null;
}

/**
 * True when a sniffed container legitimately backs the declared type.
 *
 * An .xlsx really is a ZIP; calling that a mismatch would raise an alarm on every spreadsheet
 * anybody uploads, and an alarm that fires constantly is not read.
 */
function containerMatches(sniffed: string, declared: string): boolean {
  if (sniffed === declared) return true;
  if (sniffed === 'application/zip') return ZIP_BACKED_MIME_TYPES.has(declared);
  if (sniffed === 'application/vnd.ms-office') return COMPOUND_BINARY_MIME_TYPES.has(declared);
  return false;
}

/**
 * Derive every integrity field from the bytes.
 *
 * `declaredMimeType` is accepted only to be recorded and compared. It never becomes the stored
 * type while the bytes say something else.
 */
export function deriveFileIntegrity(buffer: Buffer, declaredMimeType?: string | null): DerivedFileIntegrity {
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const sniffedMimeType = sniffMimeType(buffer);
  const declared = declaredMimeType?.split(';')[0]?.trim() || null;

  const mimeTypeMismatch = !!(sniffedMimeType && declared && !containerMatches(sniffedMimeType, declared));

  // Sniffed wins where we could read it. Where we could not, the claim is all there is — it is
  // recorded as such, and the null `sniffedMimeType` beside it says the bytes were not readable.
  const effectiveMimeType = sniffedMimeType ?? declared ?? 'application/octet-stream';

  return {
    sha256,
    byteLength: buffer.length,
    sniffedMimeType,
    declaredMimeType: declared,
    mimeTypeMismatch,
    effectiveMimeType,
  };
}

/**
 * Compare a client-supplied hash against the one computed here.
 *
 * A hash the client sends is useful — it catches corruption in transit — but it is a claim about
 * the bytes, not a property of them, so it is checked against ours rather than stored in place of
 * it. A mismatch means the bytes that arrived are not the bytes that were sent, which is a failed
 * upload and not a document.
 */
export function verifyClientHash(derived: DerivedFileIntegrity, clientSha256?: string | null): {
  supplied: boolean; matches: boolean;
} {
  const supplied = !!clientSha256?.trim();
  if (!supplied) return { supplied: false, matches: true };
  return { supplied: true, matches: clientSha256!.trim().toLowerCase() === derived.sha256 };
}
