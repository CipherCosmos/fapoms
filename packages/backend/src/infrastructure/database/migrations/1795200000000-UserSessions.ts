import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The durable session store.
 *
 * `user_sessions` is the stable identity of one sign-in (see the entity for why it is separate from
 * the churning, short-lived `refresh_tokens`). `refresh_tokens.session_id` links each rotation-chain
 * row back to the session it belongs to, so revoking a session can revoke exactly its tokens and no
 * others — the per-device sign-out the old all-sessions logout could not express.
 *
 * Nullable `session_id`: refresh-token rows minted before this migration have no session, and that
 * is fine — they age out under the existing token retention within days.
 */
export class UserSessions1795200000000 implements MigrationInterface {
  name = 'UserSessions1795200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "user_sessions" (
        "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id"            uuid NOT NULL,
        "principal_type"     varchar(20) NOT NULL,
        "ip_address"         varchar(50),
        "user_agent"         text,
        "device_browser"     varchar(80),
        "device_os"          varchar(80),
        "device_label"       varchar(160),
        "login_method"       varchar(20) NOT NULL,
        "created_at"         timestamptz NOT NULL DEFAULT now(),
        "last_seen_at"       timestamptz NOT NULL DEFAULT now(),
        "expires_at"         timestamptz NOT NULL,
        "revoked_at"         timestamptz,
        "revoked_reason"     varchar(60),
        "revoked_by_user_id" uuid
      );
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_user_sessions_user" ON "user_sessions" ("user_id");`);
    // "This user's live sessions" — the active-sessions listing — filters on (user_id, revoked_at).
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_sessions_user_active"
        ON "user_sessions" ("user_id", "revoked_at");
    `);

    await q.query(`ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "session_id" uuid;`);
    // Revoking a session finds its tokens by this.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_refresh_tokens_session_id"
        ON "refresh_tokens" ("session_id");
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_refresh_tokens_session_id";`);
    await q.query(`ALTER TABLE "refresh_tokens" DROP COLUMN IF EXISTS "session_id";`);
    await q.query(`DROP INDEX IF EXISTS "IDX_user_sessions_user_active";`);
    await q.query(`DROP INDEX IF EXISTS "IDX_user_sessions_user";`);
    await q.query(`DROP TABLE IF EXISTS "user_sessions";`);
  }
}
