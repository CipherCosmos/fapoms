import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `audit_events` becomes a database property, not an application convention.
 *
 * `TypeOrmAuditRepository` exposes only `append` — nothing in the application can express an
 * UPDATE or a DELETE against this table, and `wipe-domains.registry.ts` lists it in
 * `NEVER_WIPEABLE_TABLES` so the danger-zone reset skips it outright. Both are real controls, and
 * both are enforced entirely in application code. Anyone who can reach Postgres directly — a
 * migration script, a one-off maintenance query, a compromised credential, a future contributor
 * who does not know the rule — can still rewrite this table's history with an ordinary UPDATE or
 * DELETE, and nothing would notice. For a system whose product is audit evidence for banks, the
 * append-only guarantee is worth more than a comment saying so.
 *
 * A `REVOKE UPDATE, DELETE` alone would not close this: this deployment runs on a SINGLE
 * application role (`DB_USERNAME`) that also OWNS every table it created via migrations, and
 * PostgreSQL table ownership bypasses GRANT/REVOKE checks entirely — `REVOKE ... FROM <owner>` is
 * a silent no-op. (Splitting migration-time and runtime credentials into separate roles would
 * close this the "normal" way, but that is a deployment-architecture change, not something this
 * migration can safely decide on its own.) So the real enforcement here is a `BEFORE UPDATE OR
 * DELETE` trigger, which PostgreSQL fires for every row-level write regardless of who owns the
 * table or which role is connected — it cannot be bypassed by ownership the way a permission
 * check can. The REVOKE is added alongside it anyway, cheaply, as defense-in-depth for any
 * future non-owning role (e.g. a read-only reporting connection) that might one day share this
 * database.
 *
 * Verified safe to add now: `TypeOrmAuditRepository.append` builds every row with
 * `repository.create(...)` — no `id` is ever set on it before `.save()`, so TypeORM always
 * performs an INSERT for this table, never an UPDATE-on-conflict. A full-codebase grep for any
 * UPDATE/DELETE against `audit_events` (raw SQL or ORM) returned nothing at the time this
 * migration was written. This is the actual one-way door in this batch of work: once it runs,
 * any code path that is ever added later and tries to modify or remove an audit row will fail at
 * RUNTIME, not at deploy time — so the check above is the safety net, and it needs to stay true.
 */
export class AuditEventsImmutable1794000000000 implements MigrationInterface {
  name = 'AuditEventsImmutable1794000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE OR REPLACE FUNCTION audit_events_reject_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit_events is append-only: % is not permitted on this table', TG_OP
          USING ERRCODE = 'insufficient_privilege';
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await q.query(`
      DROP TRIGGER IF EXISTS audit_events_immutable ON "audit_events";
    `);

    await q.query(`
      CREATE TRIGGER audit_events_immutable
        BEFORE UPDATE OR DELETE ON "audit_events"
        FOR EACH ROW
        EXECUTE FUNCTION audit_events_reject_mutation();
    `);

    // Defense-in-depth only — see the class doc comment for why this alone does not protect the
    // table on this deployment's single owning role. `PUBLIC` covers any role with no explicit
    // grant; it does not, and cannot, cover the owner.
    await q.query(`REVOKE UPDATE, DELETE ON "audit_events" FROM PUBLIC;`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER IF EXISTS audit_events_immutable ON "audit_events";`);
    await q.query(`DROP FUNCTION IF EXISTS audit_events_reject_mutation();`);
    await q.query(`GRANT UPDATE, DELETE ON "audit_events" TO PUBLIC;`);
  }
}
