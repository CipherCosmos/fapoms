import { Injectable, Logger, BadRequestException, NotFoundException, Inject } from '@nestjs/common';
import { createHash } from 'crypto';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis-client.module';
import type { StorageEngine } from '../../infrastructure/storage/storage-engine.interface';
import { assertUploadAllowed, MAX_RESUMABLE_UPLOAD_BYTES } from './upload-validation';

/** The subset of StorageEngine this service actually needs, all present at once or not at all. */
type MultipartStorage = Required<
  Pick<
    StorageEngine,
    | 'createMultipartUpload'
    | 'uploadPart'
    | 'listUploadedParts'
    | 'getSignedPartUploadUrl'
    | 'completeMultipartUpload'
    | 'abortMultipartUpload'
  >
>;

export interface UploadSession {
  uploadId: string;       // Our internal ID (hex MD5)
  s3UploadId: string;     // MinIO/S3 multipart upload ID
  s3Key: string;          // The final object key in the bucket
  assessmentId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  chunkSize: number;
  createdBy: string;
  createdAt: number;
}

/**
 * Resumable chunked uploads using S3 native multipart upload.
 *
 * Assayers upload scanned audits over rural 2G/weak-3G. A 10 MB scan takes
 * 5-7 minutes on such a link, and a single-request upload that drops at 90%
 * restarts from zero — which on a flaky connection can mean it never completes.
 *
 * S3 native multipart upload is the correct backend for this: each chunk is an
 * `UploadPart` call that MinIO stores independently. After a reconnect the client
 * asks which parts landed (via `ListParts` under the hood) and sends only the
 * gaps. On completion a `CompleteMultipartUpload` atomically assembles all parts
 * into the final object — no file is ever held in memory or written to disk.
 *
 * Session state (uploadId→{s3UploadId, s3Key, metadata}) is kept in Redis with
 * a 24-hour TTL. An API restart mid-upload does not discard progress because
 * the parts live in MinIO and the session lives in Redis, both outside the
 * (stateless, ephemeral) API container.
 */
@Injectable()
export class ChunkedUploadService {
  private readonly logger = new Logger(ChunkedUploadService.name);

  /**
   * S3's own hard floor for every part in a multipart upload EXCEPT the last one — "Part size:
   * 5 MB to 5 GB. There is no minimum size limit on the last part." MinIO enforces the identical
   * rule (it implements the S3 multipart protocol, not a MinIO-specific one).
   *
   * This class's `DEFAULT_CHUNK_SIZE` used to be 512 KB, chosen purely for "cheap to re-send on
   * 2G" with no regard for this floor. The chunk-level `saveChunk`/`UploadPart` calls succeed
   * individually regardless of size — S3 does not validate part sizes until assembly — so the
   * failure was invisible until the very last step. Verified live: a session with 512 KB (in the
   * repro, an even smaller 2 KB to keep the test file tiny) chunks accepted every single
   * `UploadPart` call, then `assemble()`'s `CompleteMultipartUpload` failed with a bare
   * `EntityTooSmall: Your proposed upload is smaller than the minimum allowed object size.` —
   * after the entire file had already been transferred. For the rural-2G use case this whole
   * feature exists for (see the class doc comment), that is close to the worst possible failure
   * shape: the slow part succeeds, and the instant final step is what blows up, discarding a
   * multi-minute upload's confirmation.
   *
   * `Math.max(…, MIN_CHUNK_SIZE)` in `createSession` below applies this floor to *every* session
   * unconditionally — including a caller-supplied `chunkSize` (the query/body parameter has
   * always let a caller ask for something smaller than the default; nothing enforced a floor on
   * that value either, so fixing only the default would still leave this reachable).
   */
  static readonly MIN_CHUNK_SIZE = 5 * 1024 * 1024;
  /**
   * Kept at the S3 floor rather than the previously-intended 512 KB: a genuinely smaller,
   * cheaper-to-resend chunk is not a knob this service can turn while still using real S3
   * multipart upload underneath. The resumability benefit this feature promises still holds at
   * this size — a dropped 5 MB part on a slow link is a partial re-send measured in tens of
   * seconds, not a from-scratch restart of the whole file — it simply cannot be smaller than
   * this without abandoning true multipart semantics (buffering small chunks server-side into
   * 5 MB+ parts before calling `UploadPart` is a real alternative design, but a materially larger
   * change than fixing a mis-set default belongs in).
   */
  static readonly DEFAULT_CHUNK_SIZE = ChunkedUploadService.MIN_CHUNK_SIZE;
  /**
   * The resumable ceiling, owned by `upload-validation.ts` rather than restated here.
   *
   * This used to be a private `100 * 1024 * 1024` literal sitting a few files away from the 50 MB
   * the single-request routes enforce, with nothing tying the two together — two upload limits
   * that could be changed independently and a user who met whichever one their client happened to
   * pick. The difference between them is intentional (see the constant's comment); the duplication
   * was not.
   */
  private static readonly MAX_FILE_SIZE = MAX_RESUMABLE_UPLOAD_BYTES;
  /** Abandoned sessions are reclaimed after this long. */
  private static readonly SESSION_TTL_SECONDS = 24 * 60 * 60;

  constructor(
    @Inject('StorageEngine') private readonly storage: StorageEngine,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Multipart is optional on `StorageEngine` — `LocalStorageService` has no real analog, the way
   * it also has no presigned-URL support (see `document.controller.ts`'s own `typeof` guard for
   * that pair). Surfaced here, once, with a clear message, rather than as "storage.uploadPart is
   * not a function" from deep inside a chunk upload. `main.ts`'s production guard already
   * requires `STORAGE_DRIVER=s3`, so this only bites in local dev/test with the driver unset.
   */
  private requireMultipart(): MultipartStorage {
    const s = this.storage;
    if (
      typeof s.createMultipartUpload !== 'function' ||
      typeof s.uploadPart !== 'function' ||
      typeof s.listUploadedParts !== 'function' ||
      typeof s.getSignedPartUploadUrl !== 'function' ||
      typeof s.completeMultipartUpload !== 'function' ||
      typeof s.abortMultipartUpload !== 'function'
    ) {
      throw new BadRequestException(
        'Resumable chunked upload needs real multipart object storage (STORAGE_DRIVER=s3); the local storage driver does not support it.',
      );
    }
    return s as MultipartStorage;
  }

  // ─── Redis helpers ────────────────────────────────────────────────────────

  private redisKey(uploadId: string): string {
    return `chunked_upload:${uploadId}`;
  }

  private async saveSession(session: UploadSession): Promise<void> {
    await this.redis.set(
      this.redisKey(session.uploadId),
      JSON.stringify(session),
      'EX',
      ChunkedUploadService.SESSION_TTL_SECONDS,
    );
  }

  private async loadSession(uploadId: string): Promise<UploadSession> {
    const raw = await this.redis.get(this.redisKey(uploadId));
    if (!raw) {
      throw new NotFoundException(`Upload session ${uploadId} not found or already completed.`);
    }
    return JSON.parse(raw) as UploadSession;
  }

  private async deleteSession(uploadId: string): Promise<void> {
    await this.redis.del(this.redisKey(uploadId));
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Open a new multipart upload in MinIO and record the session in Redis.
   * Returns the session descriptor the client uses to track progress.
   */
  async createSession(input: {
    assessmentId: string;
    fileName: string;
    fileSize: number;
    createdBy: string;
    chunkSize?: number;
  }): Promise<UploadSession> {
    if (!input.fileSize || input.fileSize <= 0) {
      throw new BadRequestException('fileSize must be a positive number of bytes.');
    }
    // Same gate, same wording, same module as every other upload route — only the ceiling differs.
    // `application/pdf` is not a guess: `CreateMultipartUpload` below stores the object as a PDF,
    // so that is what this route accepts by construction.
    assertUploadAllowed({
      contentType: 'application/pdf',
      size: input.fileSize,
      maxBytes: ChunkedUploadService.MAX_FILE_SIZE,
      hint: 'Scan at a lower resolution or split the packet, then send it again.',
    });

    // Floored unconditionally — see MIN_CHUNK_SIZE's comment. A caller-requested `chunkSize`
    // below the S3 multipart minimum would otherwise reach `CreateMultipartUpload` and every
    // `UploadPart` call just fine, and only fail at `CompleteMultipartUpload`, after the client
    // has already sent the whole file.
    const chunkSize = Math.max(
      input.chunkSize || ChunkedUploadService.DEFAULT_CHUNK_SIZE,
      ChunkedUploadService.MIN_CHUNK_SIZE,
    );
    const uploadId = createHash('md5')
      .update(`${input.assessmentId}:${input.fileName}:${input.fileSize}:${Date.now()}:${Math.random()}`)
      .digest('hex');

    // Open the multipart upload. The store derives the key (same scheme `saveFile` uses) and
    // returns it — this service used to compute its own key before calling CreateMultipartUpload,
    // duplicating exactly the logic `saveFile` already has; now there is one place that decides
    // what an uploaded object is named. The returned s3UploadId must be supplied in every
    // subsequent part upload and completion call.
    const { uploadId: s3UploadId, key: s3Key } = await this.requireMultipart().createMultipartUpload(
      input.fileName,
      'application/pdf',
    );

    const session: UploadSession = {
      uploadId,
      s3UploadId,
      s3Key,
      assessmentId: input.assessmentId,
      fileName: input.fileName,
      fileSize: input.fileSize,
      chunkSize,
      totalChunks: Math.ceil(input.fileSize / chunkSize),
      createdBy: input.createdBy,
      createdAt: Date.now(),
    };

    await this.saveSession(session);
    this.logger.log(
      `Upload session ${uploadId} opened: ${input.fileName} (${input.fileSize} bytes, ${session.totalChunks} chunks) → s3Key=${s3Key}`,
    );
    return session;
  }

  /** Retrieve the session descriptor. */
  async getSession(uploadId: string): Promise<UploadSession> {
    return this.loadSession(uploadId);
  }

  /**
   * Which part numbers (0-indexed) have already been received by MinIO.
   * This is what makes resume possible — after a reconnect the client asks
   * which chunks survived and sends only the gaps.
   */
  async receivedChunks(uploadId: string): Promise<number[]> {
    const session = await this.loadSession(uploadId);
    const parts = await this.requireMultipart().listUploadedParts(session.s3Key, session.s3UploadId);
    // S3 part numbers are 1-indexed; we expose 0-indexed to match the original API.
    return parts.map((n) => n - 1).sort((a, b) => a - b);
  }

  /**
   * Upload one chunk as an S3 multipart part.
   *
   * `index` is 0-indexed (matching the original disk-based API). S3 part
   * numbers are 1-indexed, so we add 1 internally.
   */
  async saveChunk(
    uploadId: string,
    index: number,
    data: Buffer,
  ): Promise<{ received: number; total: number }> {
    const session = await this.loadSession(uploadId);

    if (index < 0 || index >= session.totalChunks) {
      throw new BadRequestException(
        `Chunk index ${index} out of range (expected 0..${session.totalChunks - 1}).`,
      );
    }
    if (!data?.length) {
      throw new BadRequestException('Empty chunk.');
    }

    await this.requireMultipart().uploadPart(session.s3Key, session.s3UploadId, index + 1, data); // S3 is 1-indexed

    const receivedCount = (await this.receivedChunks(uploadId)).length;
    return { received: receivedCount, total: session.totalChunks };
  }

  /**
   * Generates a pre-signed PUT URL for uploading one chunk directly to MinIO / S3.
   *
   * On low-bandwidth 2G/3G connections, streaming chunks directly to object storage
   * eliminates the API server proxy overhead completely, resulting in 2-3x higher transfer speeds
   * and lower latency.
   */
  async getPresignedPartUrl(
    uploadId: string,
    index: number,
    expiresIn = 3600,
  ): Promise<{ presignedUrl: string; partNumber: number }> {
    const session = await this.loadSession(uploadId);
    const partNumber = index + 1; // S3 is 1-indexed

    if (index < 0 || index >= session.totalChunks) {
      throw new BadRequestException(
        `Chunk index ${index} out of range (expected 0..${session.totalChunks - 1}).`,
      );
    }

    const presignedUrl = await this.requireMultipart().getSignedPartUploadUrl(
      session.s3Key,
      session.s3UploadId,
      partNumber,
      expiresIn,
    );
    return { presignedUrl, partNumber };
  }

  /**
   * Complete the multipart upload: MinIO assembles all uploaded parts into the
   * final object atomically. Returns the S3 key so the caller can persist it
   * in the database as the document's filePath.
   *
   * The method verifies that all declared chunks are present before calling
   * CompleteMultipartUpload — an incomplete upload produces a corrupt file.
   */
  async assemble(uploadId: string): Promise<{ s3Key: string; session: UploadSession }> {
    const session = await this.loadSession(uploadId);
    const storage = this.requireMultipart();

    // Which parts actually landed — checked before completing, so an incomplete upload is refused
    // by name rather than assembled into a corrupt file.
    const received = await storage.listUploadedParts(session.s3Key, session.s3UploadId);

    if (received.length !== session.totalChunks) {
      const missing: number[] = [];
      for (let i = 1; i <= session.totalChunks; i++) {
        if (!received.includes(i)) missing.push(i - 1); // report as 0-indexed
      }
      throw new BadRequestException(
        `Cannot complete upload: ${missing.length} chunk(s) still missing (${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}).`,
      );
    }

    // The store re-fetches the parts itself to build the ETag manifest CompleteMultipartUpload
    // needs — one extra cheap List call, in exchange for the caller never having to know an ETag
    // exists at all.
    await storage.completeMultipartUpload(session.s3Key, session.s3UploadId);
    // The parts were written by the client straight into the store; encrypt the assembled object
    // before anything registers it. See document-cipher.ts.
    await this.storage.sealObject?.(session.s3Key);

    this.logger.log(
      `Upload session ${uploadId} completed → object key: ${session.s3Key}`,
    );
    return { s3Key: session.s3Key, session };
  }

  /**
   * Abort the multipart upload and delete the session from Redis.
   * Called when an upload is abandoned or after a fatal error.
   * AbortMultipartUpload instructs MinIO to discard all uploaded parts,
   * reclaiming the staging storage.
   */
  async discard(uploadId: string): Promise<void> {
    let session: UploadSession | null = null;
    try {
      session = await this.loadSession(uploadId);
    } catch {
      // Session already gone — nothing to abort.
      return;
    }

    try {
      await this.requireMultipart().abortMultipartUpload(session.s3Key, session.s3UploadId);
    } catch (err: any) {
      // Log but don't propagate — the session is being discarded regardless.
      this.logger.warn(`Could not abort S3 multipart upload ${session.s3UploadId}: ${err?.message}`);
    }

    await this.deleteSession(uploadId);
  }

  /**
   * Prune expired sessions from Redis.
   *
   * Redis TTL handles expiry automatically, but any S3 multipart uploads those
   * sessions pointed at are not automatically aborted. This method iterates the
   * remaining session keys whose TTL is exhausted and issues AbortMultipartUpload
   * for each, reclaiming MinIO staging space.
   *
   * Note: Because Redis automatically removes expired keys, this method only
   * sees keys that are still alive but logically expired (createdAt > TTL_MS).
   * In practice, MinIO's own lifecycle rules can be configured to abort incomplete
   * multipart uploads after N days as an additional safeguard.
   */
  async pruneExpiredSessions(): Promise<number> {
    const pattern = this.redisKey('*');
    const keys = await this.redis.keys(pattern);
    let pruned = 0;

    for (const key of keys) {
      try {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const session = JSON.parse(raw) as UploadSession;
        const ageMs = Date.now() - session.createdAt;
        if (ageMs > ChunkedUploadService.SESSION_TTL_SECONDS * 1000) {
          await this.discard(session.uploadId);
          pruned++;
        }
      } catch {
        // Unreadable session — delete the Redis key.
        await this.redis.del(key);
        pruned++;
      }
    }

    if (pruned) this.logger.log(`Pruned ${pruned} expired upload session(s).`);
    return pruned;
  }
}
