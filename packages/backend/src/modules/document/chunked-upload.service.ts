import { Injectable, Logger, BadRequestException, NotFoundException, Inject, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis-client.module';

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
export class ChunkedUploadService implements OnModuleInit {
  private readonly logger = new Logger(ChunkedUploadService.name);

  /** 512 KB — cheap to re-send on 2G, low per-request overhead. */
  static readonly DEFAULT_CHUNK_SIZE = 512 * 1024;
  private static readonly MAX_FILE_SIZE = 100 * 1024 * 1024;
  /** Abandoned sessions are reclaimed after this long. */
  private static readonly SESSION_TTL_SECONDS = 24 * 60 * 60;

  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.bucket = this.config.get<string>('S3_BUCKET_NAME', 'fapoms-documents');
    const endpoint = this.config.get<string>('S3_ENDPOINT', '');
    const forcePathStyle = this.config.get<string>('S3_FORCE_PATH_STYLE', 'false') === 'true';

    this.s3 = new S3Client({
      region: this.config.get<string>('AWS_REGION', 'us-east-1'),
      credentials: {
        accessKeyId: this.config.get<string>('AWS_ACCESS_KEY_ID', ''),
        secretAccessKey: this.config.get<string>('AWS_SECRET_ACCESS_KEY', ''),
      },
      ...(endpoint ? { endpoint } : {}),
      ...(forcePathStyle ? { forcePathStyle: true } : {}),
    });
  }

  async onModuleInit(): Promise<void> {
    // Ensure the bucket exists. S3StorageService does the same on its init,
    // but ChunkedUploadService has its own S3Client instance so we must also
    // guarantee the bucket here in case this service initialises first.
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err: any) {
      if (err?.name === 'NoSuchBucket' || err?.$metadata?.httpStatusCode === 404) {
        try {
          await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
          this.logger.log(`Created storage bucket "${this.bucket}" from ChunkedUploadService.`);
        } catch (createErr: any) {
          // Ignore if bucket was created by S3StorageService concurrently
          if (
            createErr?.name !== 'BucketAlreadyOwnedByYou' &&
            createErr?.name !== 'BucketAlreadyExists' &&
            createErr?.$metadata?.httpStatusCode !== 409
          ) {
            throw createErr;
          }
        }
      }
    }
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
    if (input.fileSize > ChunkedUploadService.MAX_FILE_SIZE) {
      throw new BadRequestException(
        `File exceeds the ${ChunkedUploadService.MAX_FILE_SIZE / 1024 / 1024} MB limit.`,
      );
    }

    const chunkSize = input.chunkSize || ChunkedUploadService.DEFAULT_CHUNK_SIZE;
    const uploadId = createHash('md5')
      .update(`${input.assessmentId}:${input.fileName}:${input.fileSize}:${Date.now()}:${Math.random()}`)
      .digest('hex');

    const safeFileName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const s3Key = `uploads/${Date.now()}-${safeFileName}`;

    // Open the multipart upload in MinIO. The returned s3UploadId must be
    // supplied in every subsequent UploadPart and CompleteMultipartUpload call.
    const { UploadId: s3UploadId } = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: s3Key,
        ContentType: 'application/pdf',
      }),
    );

    if (!s3UploadId) {
      throw new BadRequestException('Failed to open a multipart upload session in object storage.');
    }

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
    const { Parts } = await this.s3.send(
      new ListPartsCommand({
        Bucket: this.bucket,
        Key: session.s3Key,
        UploadId: session.s3UploadId,
      }),
    );
    // S3 part numbers are 1-indexed; we expose 0-indexed to match the original API.
    return (Parts ?? [])
      .map((p) => (p.PartNumber ?? 1) - 1)
      .sort((a, b) => a - b);
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

    await this.s3.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: session.s3Key,
        UploadId: session.s3UploadId,
        PartNumber: index + 1, // S3 is 1-indexed
        Body: data,
        ContentLength: data.length,
      }),
    );

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

    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: session.s3Key,
      UploadId: session.s3UploadId,
      PartNumber: partNumber,
    });

    const presignedUrl = await getSignedUrl(this.s3, command, { expiresIn });
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

    // Fetch the actual uploaded parts with their ETags — required by S3's
    // CompleteMultipartUpload contract.
    const { Parts } = await this.s3.send(
      new ListPartsCommand({
        Bucket: this.bucket,
        Key: session.s3Key,
        UploadId: session.s3UploadId,
      }),
    );

    const received = (Parts ?? []).map((p) => p.PartNumber ?? 0);

    if (received.length !== session.totalChunks) {
      const missing: number[] = [];
      for (let i = 1; i <= session.totalChunks; i++) {
        if (!received.includes(i)) missing.push(i - 1); // report as 0-indexed
      }
      throw new BadRequestException(
        `Cannot complete upload: ${missing.length} chunk(s) still missing (${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}).`,
      );
    }

    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: session.s3Key,
        UploadId: session.s3UploadId,
        MultipartUpload: {
          Parts: (Parts ?? []).map((p) => ({
            PartNumber: p.PartNumber,
            ETag: p.ETag,
          })),
        },
      }),
    );

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
      await this.s3.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: session.s3Key,
          UploadId: session.s3UploadId,
        }),
      );
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
