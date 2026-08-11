import { Injectable, Logger, OnModuleInit, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketEncryptionCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { StorageEngine } from './storage-engine.interface';

/**
 * S3-compatible object storage backend.
 *
 * Supports both AWS S3 and MinIO (via S3_ENDPOINT + S3_FORCE_PATH_STYLE).
 * In the Docker development environment this talks to the `fapoms-minio` container;
 * in production it talks to an AWS S3 bucket.
 *
 * On startup the service ensures the configured bucket exists, creating it if needed.
 * This is idempotent — running against an already-provisioned bucket is a no-op.
 */
@Injectable()
export class S3StorageService implements StorageEngine, OnModuleInit {
  private readonly logger = new Logger(S3StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.get<string>('S3_BUCKET_NAME', 'fapoms-documents');
    const endpoint = this.config.get<string>('S3_ENDPOINT', '');
    const forcePathStyle = this.config.get<string>('S3_FORCE_PATH_STYLE', 'false') === 'true';

    this.client = new S3Client({
      region: this.config.get<string>('AWS_REGION', 'us-east-1'),
      credentials: {
        accessKeyId: this.config.get<string>('AWS_ACCESS_KEY_ID', ''),
        secretAccessKey: this.config.get<string>('AWS_SECRET_ACCESS_KEY', ''),
      },
      // Retry transient failures, and fail fast when storage is unreachable rather than hanging a
      // request/worker. Only the *connection* is capped — the socket (data-transfer) timeout is left
      // to the default so large file streams are never aborted mid-transfer.
      maxAttempts: Number(this.config.get<string>('S3_MAX_ATTEMPTS')) || 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: Number(this.config.get<string>('S3_CONNECTION_TIMEOUT_MS')) || 5000,
      }),
      // MinIO-specific: custom endpoint and path-style addressing.
      // AWS S3 uses virtual-hosted-style (bucket.s3.amazonaws.com) by default;
      // MinIO requires path-style (endpoint/bucket).
      ...(endpoint ? { endpoint } : {}),
      ...(forcePathStyle ? { forcePathStyle: true } : {}),
    });
  }

  /**
   * Ensures the bucket exists. Called once when the NestJS module initialises.
   * For MinIO in dev the bucket is always created fresh; for production S3 it
   * will already exist and HeadBucket succeeds immediately.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Storage bucket "${this.bucket}" already exists.`);
    } catch (err: any) {
      // NoSuchBucket (S3) or 404 (MinIO) means we must create it.
      // BucketAlreadyOwnedByYou / BucketAlreadyExists (409) means another service already created it.
      if (
        err?.name === 'NoSuchBucket' ||
        err?.$metadata?.httpStatusCode === 404 ||
        err?.name === 'BucketAlreadyOwnedByYou' ||
        err?.name === 'BucketAlreadyExists' ||
        err?.$metadata?.httpStatusCode === 409
      ) {
        if (err?.name === 'NoSuchBucket' || err?.$metadata?.httpStatusCode === 404) {
          try {
            await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
            this.logger.log(`Created storage bucket "${this.bucket}".`);
          } catch (createErr: any) {
            if (
              createErr?.name !== 'BucketAlreadyOwnedByYou' &&
              createErr?.name !== 'BucketAlreadyExists' &&
              createErr?.$metadata?.httpStatusCode !== 409
            ) {
              throw createErr;
            }
            this.logger.log(`Storage bucket "${this.bucket}" already exists (created concurrently).`);
          }
        } else {
          this.logger.log(`Storage bucket "${this.bucket}" already exists.`);
        }
      } else {
        // Any other error (credential failure, network, etc.) is fatal — the
        // service cannot operate without a reachable bucket.
        this.logger.error(`Cannot connect to object storage bucket "${this.bucket}":`, err?.message);
        throw new InternalServerErrorException(
          `Object storage is unreachable. Check S3_ENDPOINT, AWS credentials and bucket name. Details: ${err?.message}`,
        );
      }
    }

    await this.ensureBucketCors();
    await this.ensureBucketEncryption();
  }

  /**
   * Turn on default server-side encryption at rest for the bucket, so every object — including the
   * presigned browser uploads that never touch this process — is encrypted without the client having
   * to send SSE headers. Audit evidence and KYC documents (PAN cards, photos, government IDs) live
   * here, so this is the at-rest protection for the files, complementing the column encryption for the
   * numbers.
   *
   * `STORAGE_SSE` selects the algorithm (`AES256` default, or `aws:kms` with `STORAGE_SSE_KMS_KEY_ID`).
   * Non-fatal: some MinIO deployments manage encryption at the volume level, so a failure only warns.
   */
  private async ensureBucketEncryption(): Promise<void> {
    const algo = this.config.get<string>('STORAGE_SSE', 'AES256');
    const kmsKeyId = this.config.get<string>('STORAGE_SSE_KMS_KEY_ID');
    try {
      await this.client.send(
        new PutBucketEncryptionCommand({
          Bucket: this.bucket,
          ServerSideEncryptionConfiguration: {
            Rules: [
              {
                ApplyServerSideEncryptionByDefault: {
                  SSEAlgorithm: algo as any,
                  ...(algo === 'aws:kms' && kmsKeyId ? { KMSMasterKeyID: kmsKeyId } : {}),
                },
                BucketKeyEnabled: algo === 'aws:kms',
              },
            ],
          },
        }),
      );
      this.logger.log(`Applied default encryption (${algo}) to bucket "${this.bucket}".`);
    } catch (err: any) {
      this.logger.warn(
        `Could not set default encryption on bucket "${this.bucket}" — confirm encryption is handled at ` +
          `the storage layer: ${err?.message}`,
      );
    }
  }

  /** SSE params for individual PUTs, mirroring the bucket default so server-side uploads match. */
  private sseParams(): { ServerSideEncryption?: any; SSEKMSKeyId?: string } {
    const algo = this.config.get<string>('STORAGE_SSE');
    if (!algo) return {};
    const kmsKeyId = this.config.get<string>('STORAGE_SSE_KMS_KEY_ID');
    return { ServerSideEncryption: algo, ...(algo === 'aws:kms' && kmsKeyId ? { SSEKMSKeyId: kmsKeyId } : {}) };
  }

  /**
   * Allow the web app to upload straight to the bucket via presigned PUT URLs
   * (`POST /documents/upload/presign` → client PUT → `/finalize`). Without a CORS rule the
   * browser blocks that cross-origin PUT, so the presigned-upload path cannot work from a
   * browser at all. Origins come from CORS_ORIGINS (falling back to '*' only when unset).
   *
   * Non-fatal: server-side uploads (multipart, chunked) do not need this, so a failure here
   * only warns — it must never stop the service from booting.
   */
  private async ensureBucketCors(): Promise<void> {
    const origins = (this.config.get<string>('CORS_ORIGINS') || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    const allowedOrigins = origins.length > 0 ? origins : ['*'];

    try {
      await this.client.send(
        new PutBucketCorsCommand({
          Bucket: this.bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedMethods: ['PUT', 'GET', 'HEAD'],
                AllowedOrigins: allowedOrigins,
                AllowedHeaders: ['*'],
                ExposeHeaders: ['ETag'],
                MaxAgeSeconds: 3000,
              },
            ],
          },
        }),
      );
      this.logger.log(`Applied CORS policy to bucket "${this.bucket}" for: ${allowedOrigins.join(', ')}.`);
    } catch (err: any) {
      this.logger.warn(
        `Could not set CORS on bucket "${this.bucket}" — presigned browser uploads may be blocked (server-side uploads are unaffected): ${err?.message}`,
      );
    }
  }

  /**
   * Upload a buffer or readable stream to the object store.
   *
   * Streams are uploaded using @aws-sdk/lib-storage Upload for memory efficiency
   * and automatic managed multipart concurrency.
   */
  async saveFile(
    fileName: string,
    content: Buffer | Readable,
    mimeType?: string,
    contentLength?: number,
  ): Promise<string> {
    const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `uploads/${Date.now()}-${safeFileName}`;

    if (Buffer.isBuffer(content)) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: content,
          ContentLength: content.length,
          ...(mimeType ? { ContentType: mimeType } : {}),
          ...this.sseParams(),
        }),
      );
    } else {
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: content,
          ...(mimeType ? { ContentType: mimeType } : {}),
          ...this.sseParams(),
        },
        queueSize: 4,
        partSize: 5 * 1024 * 1024,
      });
      await upload.done();
    }

    this.logger.log(`Saved object: ${key}`);
    return key;
  }

  /**
   * Stream an object from the store, optionally restricted to a byte range.
   *
   * `start` / `end` are inclusive byte offsets (HTTP Range semantics).
   * When present, the request is issued with a `Range: bytes=start-end` header
   * so only the requested bytes are transferred, which is exactly what the
   * download handler needs to serve HTTP 206 Partial Content for resume-capable
   * field downloads.
   */
  async getFileStream(key: string, start?: number, end?: number): Promise<Readable> {
    const rangeHeader =
      start !== undefined && end !== undefined ? `bytes=${start}-${end}` : undefined;

    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      }),
    );

    if (!response.Body) {
      throw new InternalServerErrorException(`Object "${key}" returned an empty body from storage.`);
    }

    return response.Body as Readable;
  }

  /**
   * Return the byte-size and last-modified timestamp of an object.
   *
   * Used by the download handler to set Content-Length, ETag and validate Range
   * requests without downloading the object body. HeadObject is a metadata-only
   * request and is cheap.
   */
  async statFile(key: string): Promise<{ size: number; mtimeMs: number }> {
    const response = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    return {
      size: response.ContentLength ?? 0,
      mtimeMs: response.LastModified?.getTime() ?? Date.now(),
    };
  }

  /** Delete an object. No-op when the object does not exist. */
  async deleteFile(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    this.logger.log(`Deleted object: ${key}`);
  }

  /**
   * Generate a short-lived pre-signed GET URL.
   *
   * Used for the assayer app's document download flow: the app opens the URL in
   * the OS browser which cannot send an Authorization header, so the token is
   * encoded into the URL itself and validated by the object store.
   */
  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn });
  }

  /**
   * Generates a pre-signed PUT URL for direct client-to-S3/MinIO upload.
   *
   * Bypasses the Node.js API process entirely during binary payload transmission:
   * client uploads straight to object storage over HTTP/2, saving API memory,
   * CPU, and worker threads.
   */
  async getSignedUploadUrl(key: string, contentType = 'application/octet-stream', expiresIn = 3600): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }
}
