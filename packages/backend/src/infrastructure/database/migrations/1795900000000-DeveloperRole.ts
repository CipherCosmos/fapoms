import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The DEVELOPER role and the destructive-action two-person rule's table.
 *
 * The ADMIN role was two jobs wearing one hat: running the business, and running the machine.
 * This splits the machine half out (see SystemRole.DEVELOPER in the shared enums, 2026-09-05)
 * and installs the asymmetry that makes a data wipe a two-person action:
 *
 *   DEVELOPER = everything ADMIN holds + SYSTEM:VIEW/EDIT:PLATFORM  (requests a wipe)
 *   ADMIN     = the business estate    + SYSTEM:APPROVE:PLATFORM    (approves it — never both)
 *
 * Everyone currently holding ADMIN also receives DEVELOPER: on the day of the split every
 * existing admin IS the person doing both jobs, and taking the technical estate away from them
 * mid-flight would be an outage, not a security posture. Separating the people is then an
 * un-assignment away, done deliberately in Admin → Users.
 *
 * Also creates `destructive_action_requests` — the ledger of who asked for a wipe, who decided,
 * and when it was consumed. Its `requested_by`/`decided_by` are plain uuids with NO foreign key
 * to `users`, on purpose: any enforced FK (RESTRICT, CASCADE or SET NULL) would either block the
 * `users` wipe domain outright or drag this table into the FK-graph closure, where
 * NEVER_WIPEABLE_TABLES rightly refuses the selection. The approval trail must survive the wipe
 * it approved.
 *
 * Idempotent throughout — every INSERT is guarded by WHERE NOT EXISTS / ON CONFLICT, every
 * CREATE by IF NOT EXISTS — mirroring ReconcileRolePermissions' style (including its
 * load-bearing parameter casts: a parameter used both in a SELECT list and in a varchar
 * comparison has no type Postgres can deduce on its own).
 */
export class DeveloperRole1795900000000 implements MigrationInterface {
  name = 'DeveloperRole1795900000000';

  private static readonly SYSTEM_PERMISSIONS: Array<[string, string, string]> = [
    ['SYSTEM', 'VIEW', 'PLATFORM'],
    ['SYSTEM', 'EDIT', 'PLATFORM'],
    ['SYSTEM', 'APPROVE', 'PLATFORM'],
  ];

  public async up(q: QueryRunner): Promise<void> {
    // 1. The three SYSTEM permissions exist as rows.
    for (const [resource, action, scope] of DeveloperRole1795900000000.SYSTEM_PERMISSIONS) {
      await q.query(
        `INSERT INTO permissions (resource, action, scope, description, created_by, updated_by, version, is_active)
         SELECT $1::varchar, $2::varchar, $3::varchar, $4::varchar, 'migration', 'migration', 1, true
          WHERE NOT EXISTS (
            SELECT 1 FROM permissions WHERE resource = $1 AND action = $2 AND scope = $3)`,
        [resource, action, scope, `${action} ${resource} (${scope})`],
      );
    }

    // 2. The DEVELOPER role row, described as the seed describes it. (The roles table has no
    //    is_system column — built-ins are marked the way ConsolidateRoles marks them, by
    //    created_by = 'migration'.)
    await q.query(
      `INSERT INTO roles (name, display_name, description, created_by, updated_by, version, is_active)
       SELECT $1::varchar, $2::varchar, $3::varchar, 'migration', 'migration', 1, true
        WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = $1)`,
      [
        'DEVELOPER',
        'Developer',
        'Runs the machine: integrations, rollout switches, logs and diagnostics — plus everything Admin can do.',
      ],
    );

    // 3a. DEVELOPER holds everything ADMIN currently holds (the shared business estate).
    await q.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT dev.id, rp.permission_id
         FROM role_permissions rp
         JOIN roles admin ON admin.id = rp.role_id AND admin.name = 'ADMIN'
         JOIN roles dev   ON dev.name = 'DEVELOPER'
        WHERE NOT EXISTS (
          SELECT 1 FROM role_permissions x WHERE x.role_id = dev.id AND x.permission_id = rp.permission_id)`,
    );

    // 3b. DEVELOPER additionally owns the technical estate: SYSTEM VIEW + EDIT.
    for (const action of ['VIEW', 'EDIT']) {
      await q.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id
           FROM roles r, permissions p
          WHERE r.name = 'DEVELOPER'
            AND p.resource = 'SYSTEM' AND p.action = $1 AND p.scope = 'PLATFORM'
            AND NOT EXISTS (
              SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`,
        [action],
      );
    }

    // 3c. ADMIN gains the approve half of the two-person rule.
    await q.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id
         FROM roles r, permissions p
        WHERE r.name = 'ADMIN'
          AND p.resource = 'SYSTEM' AND p.action = 'APPROVE' AND p.scope = 'PLATFORM'
          AND NOT EXISTS (
            SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`,
    );

    // 3d. The guard that makes the split MEAN something, run LAST on purpose: on a re-run,
    //     step 3a copies ADMIN's set — which by then includes APPROVE — onto DEVELOPER, and this
    //     strips it again. No role may hold both halves of the two-person rule.
    await q.query(
      `DELETE FROM role_permissions rp
        USING roles r, permissions p
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
          AND r.name = 'DEVELOPER'
          AND p.resource = 'SYSTEM' AND p.action = 'APPROVE' AND p.scope = 'PLATFORM'`,
    );

    // 4. Every current admin is also a developer — see the header for why that is the right
    //    day-one state.
    await q.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT ur.user_id, dev.id
         FROM user_roles ur
         JOIN roles admin ON admin.id = ur.role_id AND admin.name = 'ADMIN'
         JOIN roles dev   ON dev.name = 'DEVELOPER'
       ON CONFLICT DO NOTHING`,
    );

    // 5. The two-person rule's ledger. Note the deliberate absence of user FKs — header explains.
    await q.query(`
      CREATE TABLE IF NOT EXISTS "destructive_action_requests" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "action_type"     varchar(32) NOT NULL,
        "status"          varchar(16) NOT NULL DEFAULT 'REQUESTED',
        "payload"         jsonb NOT NULL,
        "requested_by"    uuid NOT NULL,
        "decided_by"      uuid,
        "decision_reason" text,
        "requested_at"    timestamptz NOT NULL DEFAULT now(),
        "decided_at"      timestamptz,
        "executed_at"     timestamptz,
        "expires_at"      timestamptz,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_destructive_action_requests_status" ON "destructive_action_requests" ("status");`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_destructive_action_requests_requested_by" ON "destructive_action_requests" ("requested_by");`,
    );
  }

  /**
   * Best-effort reverse: removes the DEVELOPER role (assignments and grants with it), ADMIN's
   * approve grant, the three SYSTEM permission rows, and the request ledger. Anyone whose only
   * role was DEVELOPER is left role-less by this — acceptable for a down() that exists to unwind
   * a deploy, not to be a supported operating mode.
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_destructive_action_requests_requested_by";`);
    await q.query(`DROP INDEX IF EXISTS "IDX_destructive_action_requests_status";`);
    await q.query(`DROP TABLE IF EXISTS "destructive_action_requests";`);

    await q.query(`DELETE FROM user_roles WHERE role_id IN (SELECT id FROM roles WHERE name = 'DEVELOPER')`);
    await q.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name = 'DEVELOPER')`);
    await q.query(`DELETE FROM roles WHERE name = 'DEVELOPER'`);

    await q.query(
      `DELETE FROM role_permissions rp
        USING permissions p
        WHERE rp.permission_id = p.id AND p.resource = 'SYSTEM' AND p.scope = 'PLATFORM'
          AND p.action IN ('VIEW', 'EDIT', 'APPROVE')`,
    );
    await q.query(
      `DELETE FROM permissions
        WHERE resource = 'SYSTEM' AND scope = 'PLATFORM' AND action IN ('VIEW', 'EDIT', 'APPROVE')`,
    );
  }
}
