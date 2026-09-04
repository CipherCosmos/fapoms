import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The `audit_chain` tamper-evidence ledger.
 *
 * One row per sealed audit event, forming a SHA-256 hash chain (see hash-chain.ts). It is written
 * only by INSERT from the single-writer sealing pass, so `audit_events` itself is never touched and
 * keeps its absolute immutability. This table is likewise append-only: a chain whose rows could be
 * edited or deleted would prove nothing, so the same BEFORE UPDATE OR DELETE trigger pattern used on
 * `audit_events` (a row-level trigger no table ownership can bypass) guards it here too.
 */
export class AuditChain1795100000000 implements MigrationInterface {
  name = 'AuditChain1795100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "audit_chain" (
        "seq"            bigserial PRIMARY KEY,
        "audit_event_id" uuid NOT NULL,
        "prev_hash"      char(64) NOT NULL,
        "row_hash"       char(64) NOT NULL,
        "sealed_at"      timestamptz NOT NULL DEFAULT now()
      );
    `);

    // One chain row per event, and the join back to the event it seals.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_audit_chain_event"
        ON "audit_chain" ("audit_event_id");
    `);

    // Append-only, enforced the same way audit_events is (see 1794000000000-AuditEventsImmutable):
    // a row-level trigger that fires regardless of who owns the table or which role is connected.
    await q.query(`
      CREATE OR REPLACE FUNCTION audit_chain_reject_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit_chain is append-only: % is not permitted on this table', TG_OP
          USING ERRCODE = 'insufficient_privilege';
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await q.query(`DROP TRIGGER IF EXISTS audit_chain_immutable ON "audit_chain";`);
    await q.query(`
      CREATE TRIGGER audit_chain_immutable
        BEFORE UPDATE OR DELETE ON "audit_chain"
        FOR EACH ROW
        EXECUTE FUNCTION audit_chain_reject_mutation();
    `);
    await q.query(`REVOKE UPDATE, DELETE ON "audit_chain" FROM PUBLIC;`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS audit_chain_immutable ON "audit_chain";`);
    await q.query(`DROP FUNCTION IF EXISTS audit_chain_reject_mutation();`);
    await q.query(`DROP TABLE IF EXISTS "audit_chain";`);
  }
}
