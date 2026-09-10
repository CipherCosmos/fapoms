/**
 * Put the audit tables out of the runtime's reach, and grant the runtime exactly what is left.
 *
 * Runs as `fapoms_migrator`, AFTER every migration run, on every deployment. Not once at
 * provisioning time: a migration that creates a table leaves the runtime with no grant on it, and
 * a migration that recreates an audit trigger function leaves it owned by the migrator again. The
 * default privileges set below cover the first case for future tables, and this step covers both
 * for the tables and functions that already exist.
 *
 *   DB_HOST=… DB_PORT=… DB_DATABASE=… \
 *   DB_USERNAME=fapoms_migrator DB_PASSWORD=… \
 *   npm run db:harden --workspace=packages/backend
 *
 * It ends by opening a `fapoms_runtime` connection and checking what that identity can actually
 * see and do, because a GRANT that ran without error is not the same as a privilege boundary that
 * holds. Pass `FAPOMS_RUNTIME_PASSWORD` for that; without it the grants are applied and the
 * verification is skipped with a warning, which is the right trade for a developer machine and
 * the wrong one for a deployment.
 */
import { DataSource } from 'typeorm';
import { RUNTIME_ROLE, RUNTIME_ASSERTIONS, hardenSql } from './role-model';

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} is not set.`);
  return value;
}

async function main(): Promise<void> {
  const connection = {
    host: env('DB_HOST', 'localhost'),
    port: Number(env('DB_PORT', '5432')),
    database: env('DB_DATABASE', 'fapoms'),
    username: env('DB_USERNAME'),
    password: env('DB_PASSWORD'),
  };

  // A bare DataSource with no entities: this script issues catalogue statements only, and
  // reaches `pg` through TypeORM because `pg` ships no type declarations.
  const migrator = new DataSource({ type: 'postgres', ...connection, entities: [] });
  await migrator.initialize();
  try {
    const rows = await migrator.query('SELECT current_user AS who');
    console.log(`Hardening ${connection.database} as ${rows[0]?.who}.`);
    for (const statement of hardenSql(connection.database)) {
      try {
        await migrator.query(statement);
      } catch (err) {
        // Named, with the statement. A bare "permission denied for schema public" out of a
        // twenty-statement loop says nothing about which grant is wrong, and this script runs on
        // a deployment where nobody is going to bisect it by hand.
        throw new Error(
          `Hardening statement failed: ${(err as Error).message}\n${statement.trim().split('\n')[0]}…`,
        );
      }
    }
    console.log('Grants applied; audit tables and their trigger functions reassigned.');
  } finally {
    await migrator.destroy();
  }

  const runtimePassword = process.env.FAPOMS_RUNTIME_PASSWORD;
  if (!runtimePassword) {
    console.warn(
      `! FAPOMS_RUNTIME_PASSWORD not set, so the ${RUNTIME_ROLE} side was not checked. ` +
        'A deployment should always set it: applying a grant and confirming the boundary are ' +
        'different claims.',
    );
    return;
  }

  const runtime = new DataSource({
    type: 'postgres',
    ...connection,
    username: RUNTIME_ROLE,
    password: runtimePassword,
    entities: [],
  });
  await runtime.initialize();
  try {
    const failed: string[] = [];
    for (const { what, sql } of RUNTIME_ASSERTIONS) {
      const rows = await runtime.query(sql);
      const ok = rows[0]?.ok === true;
      console.log(`  ${ok ? '✓' : '✗'} ${what}`);
      if (!ok) failed.push(what);
    }
    if (failed.length > 0) {
      throw new Error(
        `The runtime role is not where it should be after hardening:\n  - ${failed.join('\n  - ')}\n` +
          'Do not start the application against this database.',
      );
    }
    console.log(`✓ ${RUNTIME_ROLE} is least-privileged and cannot reach the audit structures.`);
  } finally {
    await runtime.destroy();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
