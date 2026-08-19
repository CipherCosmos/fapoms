import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A clarification's message stops being stored in five places.
 *
 * `validation_queries` carried two copies of a conversation that lives in
 * `validation_query_messages`:
 *
 *   - `assayer_response`, a text column two routes wrote in two incompatible ways. The mobile
 *     `/respond` route appended `[timestamp] text` lines to build a chat log inside one column;
 *     the web message route overwrote the whole column with just the latest body. No screen in
 *     either app ever rendered it, so the corruption was invisible and the column pointless.
 *   - `attachments`, a jsonb array accumulating copies of files that already hang off the
 *     messages they were sent with. Both clients read attachments off messages; nothing read
 *     this. It also received the desk's marked crop, which is why the crop never reached the
 *     assayer — it was mirrored to the one place no client looks.
 *
 * Before dropping them, any crop still recorded only on the query row is carried onto the
 * message it belongs to, so no image is lost. The crop's real home is its own message's
 * attachment list from now on.
 *
 * `query_text` stays: it is the question as asked, written once, and it is what the worklist
 * and the assayer's list endpoint show. `last_message_at` stays: it is a sort key, not a copy.
 *
 * `down()` restores the columns empty. The content they held is either in the messages table
 * already or was never readable.
 */
export class OneHomeForAClarificationMessage1791800000000 implements MigrationInterface {
  name = 'OneHomeForAClarificationMessage1791800000000';

  public async up(q: QueryRunner): Promise<void> {
    // Carry any crop that exists only on the query row onto the staff message that made it.
    // `snapshot_path` is the crop's real origin, so the message is matched by that.
    await q.query(`
      UPDATE validation_query_messages m
         SET attachments = COALESCE(m.attachments, '[]'::jsonb) || jsonb_build_array(
               jsonb_build_object(
                 'url', m.snapshot_path,
                 's3Key', regexp_replace(m.snapshot_path, '^.*/validation-queries/attachment/', ''),
                 'fileName', CASE WHEN m.page_number IS NULL
                                  THEN 'Marked area'
                                  ELSE 'Marked area on page ' || m.page_number::text END,
                 'fileType', 'image/png'
               ))
       WHERE m.snapshot_path IS NOT NULL
         AND m.author_type = 'STAFF'
         -- Only when the crop is not already listed, so re-running adds nothing twice.
         AND NOT COALESCE(m.attachments, '[]'::jsonb) @> jsonb_build_array(
               jsonb_build_object('url', m.snapshot_path))
    `);

    await q.query(`ALTER TABLE "validation_queries" DROP COLUMN IF EXISTS "assayer_response"`);
    await q.query(`ALTER TABLE "validation_queries" DROP COLUMN IF EXISTS "attachments"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "validation_queries" ADD COLUMN IF NOT EXISTS "assayer_response" text`);
    await q.query(`ALTER TABLE "validation_queries" ADD COLUMN IF NOT EXISTS "attachments" jsonb`);
  }
}
