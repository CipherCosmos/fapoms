import { Readable } from 'stream';

/**
 * Abstract contract for all binary file operations.
 *
 * Implementations: LocalStorageService (dev/test fallback), S3StorageService (production / MinIO).
 * All callers go through this interface so the underlying backend is swappable via STORAGE_DRIVER env var.
 */
export interface StorageEngine {
  /**
   * Persist a binary buffer under a derived key/path.
   * Returns the opaque key/path to store in the database — callers must not
   * construct it themselves.
   */
  saveFile(fileName: string, content: Buffer | Readable, mimeType?: string, contentLength?: number): Promise<string>;

  /**
   * Open a readable stream for the stored object identified by `key`.
   * `start` and `end` are inclusive byte offsets (HTTP Range semantics) —
   * supply both to request a partial-content range for resume-capable downloads.
   */
  getFileStream(key: string, start?: number, end?: number): Promise<Readable>;

  /**
   * Return the byte-length and last-modified timestamp needed for ETag
   * generation and byte-range validation in the download handler.
   */
  statFile(key: string): Promise<{ size: number; mtimeMs: number }>;

  /** Remove the stored object. No-op if it does not exist. */
  deleteFile(key: string): Promise<void>;

  /**
   * Walk everything in the store, oldest API page at a time.
   *
   * Only the orphan audit uses this: the question "is there anything in the bucket that no row
   * points at?" cannot be answered from the database side alone. Optional, because a driver that
   * cannot enumerate (or should not) is allowed to say so by not implementing it — the audit then
   * reports that it could not look, rather than reporting zero orphans.
   */
  listObjects?(cursor?: string): Promise<{ objects: Array<{ key: string; lastModified: Date | null; size: number }>; cursor: string | null }>;

  /**
   * Generate a pre-signed GET URL that expires after `expiresIn` seconds.
   * Only required when clients need to fetch the binary directly (e.g. signed
   * download links for the assayer mobile app).
   */
  getSignedUrl?(key: string, expiresIn?: number): Promise<string>;

  /**
   * Encrypt an object that reached the store without passing through `saveFile` — a direct
   * presigned upload, or an assembled multipart upload — in place. Returns true when it did, false
   * when the object was already encrypted or no key is configured. See `document-cipher.ts`.
   */
  sealObject?(key: string): Promise<boolean>;

  /**
   * Generate a short-lived pre-signed PUT URL so mobile/web clients can stream
   * files DIRECTLY to MinIO / S3 without proxying through the NestJS backend API.
   * Crucial for high throughput and zero server bottleneck on low 2G/3G networks.
   */
  getSignedUploadUrl?(key: string, contentType?: string, expiresIn?: number): Promise<string>;

  // ── Multipart upload — server-orchestrated resumable upload for large files ─────────────────
  //
  // `ChunkedUploadService` used to build its own S3Client and call these AWS SDK commands
  // directly, rather than going through this interface — a second, independently-tuned S3
  // connection existed for no reason a StorageEngine method couldn't serve, and this class's own
  // `onModuleInit` had to re-guard the exact same "does the bucket exist yet" race
  // `S3StorageService.onModuleInit` already handles, because the two were unaware of each other.
  // Optional, like the presign methods above: there is no meaningful local-disk multipart
  // primitive, so `LocalStorageService` implements none of these, and a caller must check for
  // their presence first (see `ChunkedUploadService.requireMultipart`).

  /**
   * Open a new multipart upload. The storage layer derives the key the same way `saveFile` does
   * — callers must not construct it themselves — so key-generation logic has exactly one home
   * regardless of which upload path produced it.
   */
  createMultipartUpload?(fileName: string, contentType?: string): Promise<{ uploadId: string; key: string }>;

  /** Upload one part. `partNumber` is 1-indexed, matching S3's own multipart part numbering. */
  uploadPart?(key: string, uploadId: string, partNumber: number, data: Buffer): Promise<void>;

  /** Which 1-indexed part numbers the store has actually received, in ascending order. */
  listUploadedParts?(key: string, uploadId: string): Promise<number[]>;

  /** Pre-signed PUT URL for one part, so a client can upload it directly to the store. */
  getSignedPartUploadUrl?(key: string, uploadId: string, partNumber: number, expiresIn?: number): Promise<string>;

  /**
   * Assemble every uploaded part into the final object. The store is responsible for fetching
   * each part's ETag and building the completion manifest — a caller only names which upload to
   * finish, never touches an ETag.
   */
  completeMultipartUpload?(key: string, uploadId: string): Promise<void>;

  /** Discard an in-progress multipart upload and reclaim its staged parts. */
  abortMultipartUpload?(key: string, uploadId: string): Promise<void>;
}
