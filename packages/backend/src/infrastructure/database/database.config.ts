/**
 * FAPOMS — Database Configuration
 *
 * PostgreSQL connection factory for TypeORM.
 * Reads configuration from environment variables.
 */

import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * Where the migrations are, for the runtime — mirroring `data-source.ts`, which the CLI uses.
 *
 * Compiled or source, never both: matching both globs makes TypeORM abort with "Duplicate
 * migrations" before running any. Decided by the extension of this very file, so it is correct
 * under ts-node and under `node dist/main.js` without configuration. Single-level on purpose —
 * `migrations/_historical/` holds the 65 superseded files and must not be picked up.
 *
 * Resolved from `__dirname`, NOT `process.cwd()`. The production image starts as
 * `node packages/backend/dist/main.js` from `/app`, so a cwd-relative glob pointed at
 * `/app/dist/...` while the files are at `/app/packages/backend/dist/...`. TypeORM found no
 * migrations, ran none, and the API came up against an empty database and died on the first
 * query — with no error mentioning migrations at all. `__dirname` is right wherever the process
 * is launched from, which is the only property worth relying on here.
 */
const IS_COMPILED = __filename.endsWith('.js');
const MIGRATIONS_GLOB = [
  path.join(__dirname, IS_COMPILED ? 'migrations/*.js' : 'migrations/*.ts'),
];

export const databaseConfig = (
  configService: ConfigService,
): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: configService.get<string>('DB_HOST', 'localhost'),
  port: configService.get<number>('DB_PORT', 5432),
  username: configService.get<string>('DB_USERNAME', 'fapoms'),
  password: configService.get<string>('DB_PASSWORD', 'fapoms_dev'),
  database: configService.get<string>('DB_DATABASE', 'fapoms'),
  autoLoadEntities: true,
  // Compared to the literal 'true' rather than read as <boolean>. ConfigModule has no
  // schema, so ConfigService.get returns the raw environment string — and every non-empty
  // string, including 'false', is truthy. `DB_SYNCHRONIZE=false` therefore ENABLED
  // synchronize, letting TypeORM rewrite the live schema from the entities and drop any
  // column, index or constraint it does not recognise. Mirrors the DB_LOGGING line below.
  synchronize: configService.get<string>('DB_SYNCHRONIZE', 'false') === 'true',
  /**
   * Apply pending migrations on connect. Defaults ON — this is what makes a new machine work.
   *
   * Nothing ran migrations. Not the Dockerfile (`CMD ["node", "dist/main.js"]`), not compose,
   * not an entrypoint. It never mattered while `synchronize` was building the schema from the
   * entities on every boot — but that is exactly what left the migration chain to rot, and with
   * synchronize correctly off, a fresh deploy would come up against an *empty database* and fail
   * every query. Turning one off without turning the other on would have traded a slow problem
   * for an immediate one.
   *
   * Set `DB_MIGRATIONS_RUN=false` when running more than one replica, and apply migrations as a
   * separate step before rollout: TypeORM takes no cross-instance lock, so parallel starts can
   * race on the same migration.
   */
  migrationsRun: configService.get<string>('DB_MIGRATIONS_RUN', 'true') === 'true',
  migrations: MIGRATIONS_GLOB,
  logging: configService.get<string>('DB_LOGGING', 'false') === 'true',
  // Survive a database that is briefly unavailable at boot (rolling DB restart,
  // cold start behind a pooler) instead of crashing the whole API on the first
  // failed connect.
  retryAttempts: configService.get<number>('DB_RETRY_ATTEMPTS', 10),
  retryDelay: configService.get<number>('DB_RETRY_DELAY_MS', 3000),
  // Connection pool settings for enterprise workloads.
  //
  // `max` is now env-driven because the right value depends on replica count: N
  // API replicas each holding a fixed pool must sum to less than Postgres
  // `max_connections`. Beyond a handful of replicas, point DB_HOST at PgBouncer
  // (transaction pooling) and keep this modest.
  extra: {
    max: configService.get<number>('DB_POOL_MAX', 20),
    min: configService.get<number>('DB_POOL_MIN', 2),
    idleTimeoutMillis: configService.get<number>('DB_IDLE_TIMEOUT_MS', 30000),
    connectionTimeoutMillis: configService.get<number>('DB_CONN_TIMEOUT_MS', 10000),
    // A single runaway query must not be able to pin a pooled connection forever —
    // that is how one slow query cascades into pool exhaustion and a full outage.
    statement_timeout: configService.get<number>('DB_STATEMENT_TIMEOUT_MS', 30000),
    // A transaction left open mid-flight holds row locks; reap it.
    idle_in_transaction_session_timeout: configService.get<number>(
      'DB_IDLE_TX_TIMEOUT_MS',
      60000,
    ),
    // Detect half-open TCP connections through NAT/load balancers so the pool does
    // not hand out a dead socket.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    // Makes connections identifiable in pg_stat_activity when diagnosing load.
    application_name: 'fapoms-backend',
  },
});
