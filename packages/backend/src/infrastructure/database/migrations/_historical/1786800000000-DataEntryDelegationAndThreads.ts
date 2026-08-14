import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the data entry stage actually trackable.
 *
 * Two gaps blocked the desk workflow:
 *
 * 1. `documents.status = SENT_TO_DATA_ENTRY` recorded *that* a returned packet had
 *    reached the desk, but not *who* on the team owns it. The head had no way to
 *    distribute work and no member had a personal queue, so allocation lived
 *    outside the system.
 *
 * 2. A clarification with the assayer was a single exchange — one `query_text`,
 *    one `assayer_response`. Real clarifications go back and forth, and the useful
 *    ones point at a specific place on a specific page ("this weight, third row").
 *    There was nowhere to put either the conversation or the anchor.
 *
 * Idempotent: safe to re-run against a synchronize:true database.
 */
export class DataEntryDelegationAndThreads1786800000000 implements MigrationInterface {
  name = 'DataEntryDelegationAndThreads1786800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Delegation ────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE documents
        ADD COLUMN IF NOT EXISTS assigned_to_user_id uuid,
        ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
        ADD COLUMN IF NOT EXISTS assigned_by uuid,
        ADD COLUMN IF NOT EXISTS data_entry_completed_at timestamptz
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_assigned_to
        ON documents (assigned_to_user_id) WHERE assigned_to_user_id IS NOT NULL
    `);

    // ── 2. Threaded clarifications ───────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE validation_query_message_author_enum AS ENUM ('STAFF', 'ASSAYER');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS validation_query_messages (
        id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_by          varchar,
        created_at          timestamptz NOT NULL DEFAULT NOW(),
        updated_by          varchar,
        updated_at          timestamptz NOT NULL DEFAULT NOW(),
        version             integer NOT NULL DEFAULT 1,
        is_active           boolean NOT NULL DEFAULT true,

        validation_query_id uuid NOT NULL REFERENCES validation_queries(id) ON DELETE CASCADE,
        author_type         validation_query_message_author_enum NOT NULL,
        author_id           uuid NOT NULL,
        author_name         varchar(200),
        body                text,

        -- Free attachments, plus an optional anchor pinning this message to a
        -- rectangle on one page of the returned PDF. Coordinates are stored
        -- normalised (0..1) so they survive any zoom or render width.
        attachments         jsonb,
        page_number         integer,
        region              jsonb,
        snapshot_path       varchar(500)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_vq_messages_query
        ON validation_query_messages (validation_query_id, created_at)
    `);

    // The document a clarification is about — the desk needs to open the right PDF.
    await queryRunner.query(`
      ALTER TABLE validation_queries
        ADD COLUMN IF NOT EXISTS document_id uuid,
        ADD COLUMN IF NOT EXISTS raised_by_user_id uuid,
        ADD COLUMN IF NOT EXISTS last_message_at timestamptz
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS validation_query_messages`);
    await queryRunner.query(`DROP TYPE IF EXISTS validation_query_message_author_enum`);
    await queryRunner.query(`
      ALTER TABLE validation_queries
        DROP COLUMN IF EXISTS document_id,
        DROP COLUMN IF EXISTS raised_by_user_id,
        DROP COLUMN IF EXISTS last_message_at
    `);
    await queryRunner.query(`
      ALTER TABLE documents
        DROP COLUMN IF EXISTS assigned_to_user_id,
        DROP COLUMN IF EXISTS assigned_at,
        DROP COLUMN IF EXISTS assigned_by,
        DROP COLUMN IF EXISTS data_entry_completed_at
    `);
  }
}
