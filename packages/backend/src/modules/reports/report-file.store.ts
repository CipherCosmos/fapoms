/**
 * FAPOMS — Short-lived holding area for produced .xlsx files.
 *
 * ## Why a store at all
 *
 * Moving an export onto a queue splits producing the file from delivering it: the worker builds
 * bytes with nobody connected, and an HTTP request arrives later asking for them. Something has
 * to hold them in between.
 *
 * ## Why Redis rather than S3/MinIO
 *
 * `infrastructure/storage` (S3/MinIO) is where a file that anyone might want tomorrow belongs,
 * and for large exports it is the right answer — the worker would put the object and the
 * download route would redirect to a pre-signed URL, with nothing large crossing the API process
 * at all. That directory was outside the partition of the change that introduced this, so this
 * is the honest interim: a key with a hard TTL and a hard size cap, which is correct for
 * fifteen-minute-lifetime files of a few megabytes and is deliberately bounded so that it cannot
 * quietly grow into a general-purpose file store.
 *
 * ## Why not simply the Bull job's return value
 *
 * Covered in `report-jobs.contract.ts`: polls would carry the bytes, and Bull's age-based
 * retention only prunes when later jobs complete, so on a quiet queue the bytes would outlive
 * their stated lifetime indefinitely. `EX` is enforced by Redis whether or not anything else
 * happens on the queue.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis-client.module';
import { MAX_EXPORT_BYTES, REPORT_RESULT_TTL_SECONDS } from './report-jobs.contract';

/**
 * Namespaced so these keys are recognisable in `KEYS`/`SCAN` output and cannot collide with the
 * cache, the throttler, the upload sessions or Bull's own keys, all of which share this Redis.
 */
const KEY_PREFIX = 'report-export:';

/** Raised when a workbook is too large to hold here. Carries operator-readable wording. */
export class ReportTooLargeError extends Error {
  constructor(sizeBytes: number) {
    super(
      `This export came to ${(sizeBytes / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${(MAX_EXPORT_BYTES / 1024 / 1024).toFixed(0)} MB limit for a downloadable report. ` +
        'Narrow the filter — by project, client, date range or status — and run it again.',
    );
    this.name = 'ReportTooLargeError';
  }
}

@Injectable()
export class ReportFileStore {
  private readonly logger = new Logger(ReportFileStore.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private key(jobId: string): string {
    return `${KEY_PREFIX}${jobId}`;
  }

  /**
   * Stores the produced workbook against its job id.
   *
   * Throws rather than truncating or storing a partial file when over the cap: half a spreadsheet
   * that opens and shows wrong totals is a worse outcome than an error that says which filter to
   * narrow. The check is on the built buffer rather than the row count because compression means
   * row count predicts size poorly — a hundred thousand repetitive rows can zip smaller than ten
   * thousand varied ones.
   */
  async put(jobId: string, buffer: Buffer): Promise<void> {
    if (buffer.length > MAX_EXPORT_BYTES) {
      throw new ReportTooLargeError(buffer.length);
    }
    // Binary, not base64. ioredis writes a Buffer value as-is; base64 would have added a third
    // again to every byte held, for no benefit.
    await this.redis.set(this.key(jobId), buffer, 'EX', REPORT_RESULT_TTL_SECONDS);
    this.logger.log(`Stored export for job ${jobId} (${(buffer.length / 1024).toFixed(0)} KB, TTL ${REPORT_RESULT_TTL_SECONDS}s).`);
  }

  /**
   * Fetches the workbook, or null if it has expired.
   *
   * `getBuffer`, not `get`: the default client decodes replies as UTF-8 strings, which silently
   * corrupts every byte of a zip container that is not valid UTF-8 — the file would download,
   * and Excel would refuse to open it.
   */
  async get(jobId: string): Promise<Buffer | null> {
    return this.redis.getBuffer(this.key(jobId));
  }

  /**
   * Seconds until the file expires, or null when it is already gone.
   *
   * Read from Redis rather than computed from the job's finish time, so what the poll response
   * advertises is the actual remaining lifetime rather than an estimate that drifts.
   */
  async secondsRemaining(jobId: string): Promise<number | null> {
    const ttlMs = await this.redis.pttl(this.key(jobId));
    // ioredis mirrors Redis: -2 = no such key, -1 = key exists with no expiry (which these
    // always have, so it would mean the EX was lost — treat it as absent rather than eternal).
    if (ttlMs < 0) return null;
    return Math.ceil(ttlMs / 1000);
  }
}
