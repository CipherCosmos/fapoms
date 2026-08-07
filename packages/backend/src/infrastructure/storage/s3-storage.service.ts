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
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
