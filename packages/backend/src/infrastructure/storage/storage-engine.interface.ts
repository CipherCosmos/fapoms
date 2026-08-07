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
   * Generate a pre-signed GET URL that expires after `expiresIn` seconds.
   * Only required when clients need to fetch the binary directly (e.g. signed
   * download links for the assayer mobile app).
   */
  getSignedUrl?(key: string, expiresIn?: number): Promise<string>;

  /**
   * Generate a short-lived pre-signed PUT URL so mobile/web clients can stream
   * files DIRECTLY to MinIO / S3 without proxying through the NestJS backend API.
   * Crucial for high throughput and zero server bottleneck on low 2G/3G networks.
   */
  getSignedUploadUrl?(key: string, contentType?: string, expiresIn?: number): Promise<string>;
}
