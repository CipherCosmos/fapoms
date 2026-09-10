import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AUDIT_FUNCTIONS,
  AUDIT_OWNER_ROLE,
  AUDIT_TABLES,
  MIGRATION_ROLE,
  PARTITION_FUNCTION,
  RUNTIME_ASSERTIONS,
  RUNTIME_ROLE,
  createRolesSql,
  hardenSql,
} from './role-model';

/**
 * The role split, checked as a design rather than as a database.
 *
 * The adversarial proof — actually issuing `DROP TRIGGER` as the runtime role and watching
 * PostgreSQL refuse it — is `scripts/verify-runtime-role.mjs`, which provisions its own database
 * from nothing so it is never vacuous. It cannot run in the unit suite: there is no database
 * there, and a spec that skips when it finds none would report a boundary it never tested.
 *
 * What CAN be held here is everything that is a property of the plan itself:
 *
 *  - no statement grants the runtime something the design says it must not have;
 *  - the checklist the deployment verifies at boot covers every prohibition that was asked for,
 *    so a check quietly disappearing from `RUNTIME_ASSERTIONS` fails the build rather than
 *    shrinking the boot-time report by one line nobody counts;
 *  - the adversarial script still attempts every attack, so removing a probe from it is also a
 *    visible change and not a quieter run.
 *
 * That last one matters more than it looks. The natural way for this control to rot is not
 * somebody granting the runtime TRUNCATE; it is somebody deleting the check that would have
 * noticed.
 */
describe('the database role split', () => {
  const runtimeSql = () => hardenSql('fapoms').join('\n');

  describe('what the runtime is granted', () => {
    it('never grants it TRUNCATE, on anything', () => {
      // TRUNCATE is the one that took 3,320 audit rows in certification. It is granted to nobody
      // by this file, on any table, ever — the runtime deletes rows through DELETE or not at all.
      expect(runtimeSql()).not.toMatch(new RegExp(`GRANT[^;]*TRUNCATE[^;]*TO ${RUNTIME_ROLE}`, 'i'));
    });

    it('never grants it CREATE on a schema', () => {
      // Creating an object in a schema is altering the schema, which is the privilege the split
      // exists to take away from the running process. USAGE is what it needs and all it gets.
      const grantsToRuntime = hardenSql('fapoms').filter((s) => s.includes(RUNTIME_ROLE) && /GRANT/i.test(s));
      for (const statement of grantsToRuntime) {
        expect(statement).not.toMatch(/GRANT[^;]*\bCREATE\b[^;]*ON SCHEMA/i);
      }
    });

    it('gives the audit tables only SELECT and INSERT, after revoking everything', () => {
      const statements = hardenSql('fapoms');
      const revokeAt = statements.findIndex((s) => /REVOKE ALL ON .*audit_events.* FROM fapoms_runtime/i.test(s));
      const grantAt = statements.findIndex((s) => /GRANT SELECT, INSERT ON .*audit_events/i.test(s));
      expect(revokeAt).toBeGreaterThan(-1);
      expect(grantAt).toBeGreaterThan(revokeAt);
      // And the broad table grant comes BEFORE the revoke, or it would re-open what the revoke
      // had just closed — the ordering is the whole correctness of this function. That grant is a
      // per-object loop rather than `ON ALL TABLES`, because `public` also holds whatever an
      // extension put there and the blanket form dies on the first object this role does not own.
      const broadAt = statements.findIndex((s) => /GRANT SELECT, INSERT, UPDATE, DELETE ON %s/i.test(s));
      expect(broadAt).toBeGreaterThan(-1);
      expect(broadAt).toBeLessThan(revokeAt);
    });

    it('moves every audit table and trigger function to the role that cannot log in', () => {
      const sql = runtimeSql();
      for (const table of AUDIT_TABLES) {
        expect(sql).toContain(`ALTER TABLE "${table}" OWNER TO ${AUDIT_OWNER_ROLE}`);
      }
      for (const fn of AUDIT_FUNCTIONS) {
        expect(sql).toContain(`ALTER FUNCTION ${fn} OWNER TO ${AUDIT_OWNER_ROLE}`);
      }
    });

    it('contains no backtick, which would have ended the template literal that carries it', () => {
      // Not style. These statements are built in template literals, so a backtick inside a SQL
      // comment terminates the literal early — and TypeScript sometimes still compiles the wreck,
      // leaving a module that only fails when Node parses the emitted JavaScript. That happened
      // three times while this file was being written, each time costing a full provision run to
      // diagnose. Markdown habits do not belong inside SQL.
      for (const statement of [...hardenSql('fapoms'), ...createRolesSql('rt', 'mg')]) {
        expect(statement).not.toContain('`');
      }
    });

    it('lets the runtime execute the one narrow DDL function and nothing else named', () => {
      expect(runtimeSql()).toContain(`GRANT EXECUTE ON FUNCTION ${PARTITION_FUNCTION} TO ${RUNTIME_ROLE}`);
    });
  });

  describe('what the roles are', () => {
    const created = () => createRolesSql('rt', 'mg').join('\n');

    it('makes none of the three a superuser, a role creator or a database creator', () => {
      for (const role of [RUNTIME_ROLE, MIGRATION_ROLE, AUDIT_OWNER_ROLE]) {
        const alter = createRolesSql('rt', 'mg').find((s) => s.startsWith(`ALTER ROLE ${role} `))!;
        expect(alter).toContain('NOSUPERUSER');
        expect(alter).toContain('NOCREATEDB');
        expect(alter).toContain('NOCREATEROLE');
        expect(alter).toContain('NOREPLICATION');
        expect(alter).toContain('NOBYPASSRLS');
      }
    });

    it('gives the audit owner no way to log in', () => {
      expect(created()).toMatch(new RegExp(`ALTER ROLE ${AUDIT_OWNER_ROLE} NOLOGIN`));
      expect(created()).not.toMatch(new RegExp(`ALTER ROLE ${AUDIT_OWNER_ROLE}[^\\n]*PASSWORD`));
    });

    it('makes the runtime a member of nothing, and says so every run', () => {
      // A membership is as good as the privilege it reaches, so this is revoked rather than
      // merely not granted: an operator who added the runtime to a role by hand is undone by the
      // next deploy rather than left standing.
      expect(created()).toContain(`REVOKE ${AUDIT_OWNER_ROLE} FROM ${RUNTIME_ROLE}`);
      expect(created()).toContain(`REVOKE ${MIGRATION_ROLE} FROM ${RUNTIME_ROLE}`);
      expect(created()).not.toMatch(new RegExp(`GRANT [a-z_]+ TO ${RUNTIME_ROLE}`));
    });

    it('escapes a quote in a password rather than ending the statement', () => {
      const sql = createRolesSql("pa'ss", 'mg').find((s) => s.includes(RUNTIME_ROLE) && s.includes('PASSWORD'))!;
      expect(sql).toContain(`PASSWORD 'pa''ss'`);
    });
  });

  describe('the checklist a deployment verifies at boot', () => {
    const covered = (fragment: string) =>
      RUNTIME_ASSERTIONS.some((a) => a.what.toLowerCase().includes(fragment) || a.sql.includes(fragment));

    it.each([
      ['superuser', 'rolsuper'],
      ['role and database creation', 'rolcreaterole'],
      ['RLS bypass', 'rolbypassrls'],
      ['owning no table', 'tableowner'],
      ['membership in no role', 'pg_auth_members'],
      ['audit tables owned by a NOLOGIN role', 'rolcanlogin'],
      ['no UPDATE, DELETE or TRUNCATE on audit', 'TRUNCATE'],
      ['still able to append and read audit', 'INSERT'],
      ['no CREATE on the public schema', 'has_schema_privilege'],
    ])('covers %s', (_name, fragment) => {
      expect(covered(fragment)).toBe(true);
    });

    it('asks the database rather than trusting configuration', () => {
      // Every assertion is a query returning `ok`, so the answer comes from PostgreSQL's own
      // catalogue. A check that read an environment variable would pass on a deployment where
      // the variable was right and the grant was not.
      for (const { sql } of RUNTIME_ASSERTIONS) {
        expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
        expect(sql).toMatch(/\bok\b/);
      }
      expect(RUNTIME_ASSERTIONS.length).toBeGreaterThanOrEqual(9);
    });
  });

  describe('the adversarial script still attempts every attack', () => {
    const script = readFileSync(
      join(__dirname, '..', '..', '..', '..', '..', '..', 'scripts', 'verify-runtime-role.mjs'),
      'utf8',
    );

    it.each([
      'UPDATE audit_events',
      'DELETE FROM audit_events',
      'TRUNCATE audit_events',
      'TRUNCATE audit_events CASCADE',
      'RESTART IDENTITY',
      'ALTER TABLE audit_events ADD COLUMN',
      'DISABLE TRIGGER audit_events_immutable',
      'DISABLE TRIGGER ALL',
      'DROP TRIGGER audit_events_immutable',
      'ALTER FUNCTION audit_events_reject_mutation',
      'CREATE OR REPLACE FUNCTION audit_events_reject_mutation',
      'DROP FUNCTION audit_events_reject_mutation',
      'DROP TABLE audit_events',
      'SET ROLE fapoms_migrator',
      'ALTER ROLE fapoms_runtime SUPERUSER',
      'CREATE EXTENSION',
      'CREATE TABLE public.smuggled',
    ])('probes %s', (attack) => {
      expect(script).toContain(attack);
    });

    it('also checks that ordinary work still succeeds', () => {
      // A boundary that stops the product working is a boundary somebody switches off. These are
      // the operations the inventory found the runtime actually performs.
      for (const operation of [
        'append an audit event',
        'take a transaction advisory lock',
        'create a temporary table',
        'use a PostGIS function',
        'manage a location-ping partition through the SECURITY DEFINER function',
      ]) {
        expect(script).toContain(operation);
      }
    });
  });
});
