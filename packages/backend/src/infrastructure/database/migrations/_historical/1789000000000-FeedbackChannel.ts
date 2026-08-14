import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The two-way feedback & collaboration channel.
 *
 * Every FAPOMS user — staff, client users and field assayers — can raise a bug,
 * an enhancement, a process idea or a question, and the product/support team
 * triages and replies in thread. Two new tables model it (thread root + message),
 * mirroring the assayer clarification thread, and a new PRODUCT_SUPPORT role owns
 * the receiving end.
 *
 * A thread's reporter lives in one of two identity spaces — `reporter_user_id`
 * (internal users) or `reporter_assayer_id` (field assayers, who have no `users`
 * row) — exactly as the notifications table already models its dual recipient.
 *
 * Idempotent: safe to re-run against a synchronize:true database.
 */
export class FeedbackChannel1789000000000 implements MigrationInterface {
  name = 'FeedbackChannel1789000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Enums ────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE feedback_threads_category_enum AS ENUM ('BUG', 'ENHANCEMENT', 'PROCESS', 'QUESTION', 'OTHER');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE feedback_threads_severity_enum AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE feedback_threads_status_enum AS ENUM ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE feedback_messages_author_type_enum AS ENUM ('REPORTER', 'TEAM', 'SYSTEM');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    // ── Thread root ──────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS feedback_threads (
        id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_by            varchar,
        created_at            timestamptz NOT NULL DEFAULT NOW(),
        updated_by            varchar,
        updated_at            timestamptz NOT NULL DEFAULT NOW(),
        version               integer NOT NULL DEFAULT 1,
        is_active             boolean NOT NULL DEFAULT true,

        reporter_user_id      uuid,
        reporter_assayer_id   uuid,
        reporter_name         varchar(200) NOT NULL,
        reporter_role         varchar(64),
        title                 varchar(200) NOT NULL,
        category              feedback_threads_category_enum NOT NULL DEFAULT 'OTHER',
        severity              feedback_threads_severity_enum NOT NULL DEFAULT 'MEDIUM',
        status                feedback_threads_status_enum NOT NULL DEFAULT 'OPEN',
        assigned_to_user_id   uuid,
        area                  varchar(100),
        app_context           jsonb,
        last_message_at       timestamptz,
        first_responded_at    timestamptz,
        vote_count            integer NOT NULL DEFAULT 1,
        ai_meta               jsonb,
        duplicate_of_id       uuid,
        resolved_at           timestamptz,
        resolved_by_user_id   uuid
      )
    `);
    // Backfill for any environment where feedback_threads already exists (synchronize dev).
    await queryRunner.query(`ALTER TABLE feedback_threads ADD COLUMN IF NOT EXISTS first_responded_at timestamptz`);
    await queryRunner.query(`ALTER TABLE feedback_threads ADD COLUMN IF NOT EXISTS vote_count integer NOT NULL DEFAULT 1`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_feedback_threads_reporter_user ON feedback_threads (reporter_user_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_feedback_threads_reporter_assayer ON feedback_threads (reporter_assayer_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_feedback_threads_status ON feedback_threads (status)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_feedback_threads_category ON feedback_threads (category)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_feedback_threads_assignee ON feedback_threads (assigned_to_user_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_feedback_threads_last_message ON feedback_threads (last_message_at)`);

    // ── Messages ─────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS feedback_messages (
        id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_by          varchar,
        created_at          timestamptz NOT NULL DEFAULT NOW(),
        updated_by          varchar,
        updated_at          timestamptz NOT NULL DEFAULT NOW(),
        version             integer NOT NULL DEFAULT 1,
        is_active           boolean NOT NULL DEFAULT true,

        feedback_thread_id  uuid NOT NULL REFERENCES feedback_threads(id) ON DELETE CASCADE,
        author_type         feedback_messages_author_type_enum NOT NULL,
        author_user_id      uuid,
        author_assayer_id   uuid,
        author_name         varchar(200),
        body                text,
        attachments         jsonb,
        is_internal         boolean NOT NULL DEFAULT false,
        is_read             boolean NOT NULL DEFAULT false,
        read_at             timestamptz
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_feedback_messages_thread
        ON feedback_messages (feedback_thread_id, created_at)
    `);

    // ── Votes ("me too") ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS feedback_votes (
        id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_by          varchar,
        created_at          timestamptz NOT NULL DEFAULT NOW(),
        updated_by          varchar,
        updated_at          timestamptz NOT NULL DEFAULT NOW(),
        version             integer NOT NULL DEFAULT 1,
        is_active           boolean NOT NULL DEFAULT true,

        feedback_thread_id  uuid NOT NULL REFERENCES feedback_threads(id) ON DELETE CASCADE,
        voter_user_id       uuid,
        voter_assayer_id    uuid
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_feedback_votes_thread ON feedback_votes (feedback_thread_id)`);
    // One vote per person per thread, per identity space (NULLs in the other column stay distinct).
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_vote_user ON feedback_votes (feedback_thread_id, voter_user_id) WHERE voter_user_id IS NOT NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_vote_assayer ON feedback_votes (feedback_thread_id, voter_assayer_id) WHERE voter_assayer_id IS NOT NULL`);

    // ── PRODUCT_SUPPORT role ─────────────────────────────────────────────────
    // The product/support/dev team that owns the feedback queue. Feedback endpoints
    // gate on role membership, so the role needs no RBAC permissions to work; it is
    // seeded here so it is assignable and so notification fan-out can reach it.
    // Admins also hold the queue (they already carry every permission), so a fresh
    // PRODUCT_SUPPORT seat being unstaffed never blocks anyone.
    await queryRunner.query(`
      INSERT INTO roles (id, name, display_name, description, version, is_active, created_by, updated_by, created_at, updated_at)
      SELECT uuid_generate_v4(), 'PRODUCT_SUPPORT', 'Product Support',
             'Owns the feedback & collaboration channel: receives, triages and answers bug reports, enhancement requests and process ideas from every user.',
             1, true, 'system', 'system', NOW(), NOW()
      WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'PRODUCT_SUPPORT')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM roles WHERE name = 'PRODUCT_SUPPORT'`);
    await queryRunner.query(`DROP TABLE IF EXISTS feedback_votes`);
    await queryRunner.query(`DROP TABLE IF EXISTS feedback_messages`);
    await queryRunner.query(`DROP TABLE IF EXISTS feedback_threads`);
    await queryRunner.query(`DROP TYPE IF EXISTS feedback_messages_author_type_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS feedback_threads_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS feedback_threads_severity_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS feedback_threads_category_enum`);
  }
}
