/**
 * FAPOMS — Database Configuration
 *
 * PostgreSQL connection factory for TypeORM.
 * Reads configuration from environment variables.
 */

import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

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
