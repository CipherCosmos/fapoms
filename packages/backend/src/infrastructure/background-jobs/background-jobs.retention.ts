import type { DataSource } from 'typeorm';
import type { StorageEngine } from '../storage/storage-engine.interface';

/** How long a finished background job — its row, its uploaded file and its report — is kept. */
export const DEFAULT_BACKGROUND_JOB_RETENTION_DAYS = 30;

export interface PurgeOutcome {
  removed: number;
  saturated: boolean;
}

/**
 * Remove finished background jobs past their window, with the files they point at.
 *
 * ## What is eligible
 *
 * Only jobs with a `finished_at` — SUCCEEDED, FAILED, CANCELLED, and a rehearsal left waiting in
 * AWAITING_REVIEW for the whole window (nobody decided in a month; the file behind it is a copy of a
 * sheet the office still has). QUEUED and RUNNING rows are never touched at any age: they are work
 * in progress, and the recovery sweep, not this, is what deals with one that is stuck.
 *
 * ## Files first, then rows
 *
 * The uploaded sheet is often a client's full branch list, so leaving it in the bucket after its row
 * is gone would keep data with no screen and no rule attached to it. Each object is deleted before
 * the row that points at it; a file that cannot be deleted is left for the orphan report rather than
 * blocking the rest. An object another, younger row still points at (a commit reuses its rehearsal's
 * file) is kept.
 *
 * Written against `idx_background_jobs_finished` (`finished_at` WHERE `finished_at` IS NOT NULL).
 */
export async function purgeExpiredBackgroundJobs(
  dataSource: DataSource,
  storage: StorageEngine,
  cutoff: Date,
  batchSize: number,
  maxBatches: number,
  warn: (message: string) => void = () => undefined,
): Promise<PurgeOutcome> {
  let removed = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const selected: unknown = await dataSource.query(
      `SELECT id, input_object_key, result_object_key, input_objects FROM background_jobs
        WHERE finished_at < $1 AND status NOT IN ('QUEUED', 'RUNNING')
        ORDER BY finished_at
        LIMIT $2`,
      [cutoff, batchSize],
    );
    // Only well-formed rows: a driver answering in some other shape must not become a DELETE.
    const rows = (Array.isArray(selected) ? selected : []).filter(
      (r): r is {
        id: string;
        input_object_key: string | null;
        result_object_key: string | null;
        input_objects?: Array<{ key?: unknown }> | null;
      } =>
        !!r && typeof (r as { id?: unknown }).id === 'string',
    );
    if (rows.length === 0) return { removed, saturated: false };

    const ids = rows.map((r) => r.id);
    const keys = [...new Set(
      rows
        .flatMap((r) => [
          r.input_object_key,
          r.result_object_key,
          // A several-file upload (a batch of audit packets) keeps each file under its own key.
          ...(Array.isArray(r.input_objects) ? r.input_objects.map((o) => (typeof o?.key === 'string' ? o.key : null)) : []),
        ])
        .filter((k): k is string => !!k),
    )];
    for (const key of keys) {
      const stillUsed: Array<{ one: number }> = await dataSource.query(
        `SELECT 1 AS one FROM background_jobs
          WHERE (input_object_key = $1 OR result_object_key = $1
                 OR input_objects @> jsonb_build_array(jsonb_build_object('key', $1::text)))
            AND NOT (id = ANY($2::uuid[]))
          LIMIT 1`,
        [key, ids],
      );
      if (stillUsed.length > 0) continue;
      try {
        await storage.deleteFile(key);
      } catch (err) {
        warn(`Retention could not delete background-job file ${key}: ${(err as Error).message}`);
      }
    }

    await dataSource.query(`DELETE FROM background_jobs WHERE id = ANY($1::uuid[])`, [ids]);
    removed += rows.length;
    if (rows.length < batchSize) return { removed, saturated: false };
  }
  return { removed, saturated: true };
}
