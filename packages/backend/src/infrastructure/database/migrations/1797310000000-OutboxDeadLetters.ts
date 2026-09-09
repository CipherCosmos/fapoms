import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GIVE THE OUTBOX A TERMINAL STATE THAT CAN BE SEEN AND UNDONE.
 *
 * `OutboxRelay` selected `attempts < MAX_ATTEMPTS` (15). A row that reached 15 stopped matching
 * that query — and that was the whole of "abandoned": no column said so, no route listed it, no
 * health check counted it, no metric moved. `RetentionService.purgeDispatchedOutboxEvents`
 * deletes only rows with a `dispatched_at`, so the row also never went away. A domain event
 * committed with its transaction could therefore be permanently undelivered, invisible and
 * unpurgeable, with one `logger.error` at the moment of the fifteenth failure as the sole trace.
 *
 * `failed_at` makes the terminal state a fact on the row: the relay writes it in the same UPDATE
 * as the attempt that caused it (so a crash between the two cannot leave a row out of retries and
 * unmarked), `GET /admin/outbox/dead-letters` lists it, and
 * `POST /admin/outbox/dead-letters/:id/replay` clears it so the ordinary relay tick picks the row
 * up again — one delivery path, never a second one that could drift.
 *
 * `replayed_at` / `replayed_by` record who put an event back and when, because a replay
 * re-publishes to every subscriber and, for `assignment:status-changed`, that reaches the billing
 * engine.
 *
 * Backfills any row already past the attempt ceiling so existing abandoned events appear in the
 * new view rather than staying invisible under the new mechanism as well. The partial index is
 * what keeps the dead-letter list and the health counts off a table scan as `outbox_events` grows
 * — it covers only the undelivered rows, which are the tiny minority.
 */
export class OutboxDeadLetters1797310000000 implements MigrationInterface {
  name = 'OutboxDeadLetters1797310000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "outbox_events"
      ADD COLUMN IF NOT EXISTS "failed_at" timestamptz NULL,
      ADD COLUMN IF NOT EXISTS "replayed_at" timestamptz NULL,
      ADD COLUMN IF NOT EXISTS "replayed_by" uuid NULL
    `);

    const before = await q.query(`
      SELECT count(*)::text AS n FROM outbox_events
       WHERE dispatched_at IS NULL AND attempts >= 15 AND failed_at IS NULL
    `);
    if (Number(before[0]?.n ?? 0) > 0) {
      // `occurred_at` is the honest stand-in: the exact moment of the fifteenth failure was never
      // recorded anywhere, so inventing `now()` would date the abandonment to this deployment.
      await q.query(`
        UPDATE outbox_events SET failed_at = occurred_at
         WHERE dispatched_at IS NULL AND attempts >= 15 AND failed_at IS NULL
      `);
    }
    // eslint-disable-next-line no-console
    console.log(
      `[OutboxDeadLetters] marked ${before[0]?.n ?? 0} already-exhausted outbox event(s) as dead-lettered; ` +
        'they are now listed by GET /admin/outbox/dead-letters.',
    );

    // The relay's own query is (dispatched_at IS NULL AND failed_at IS NULL ORDER BY occurred_at),
    // and the dead-letter list is (dispatched_at IS NULL AND failed_at IS NOT NULL). One partial
    // index over the undelivered rows serves both.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_events_undispatched"
      ON "outbox_events" ("failed_at", "occurred_at")
      WHERE "dispatched_at" IS NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "idx_outbox_events_undispatched"`);
    await q.query(`
      ALTER TABLE "outbox_events"
      DROP COLUMN IF EXISTS "replayed_by",
      DROP COLUMN IF EXISTS "replayed_at",
      DROP COLUMN IF EXISTS "failed_at"
    `);
  }
}
