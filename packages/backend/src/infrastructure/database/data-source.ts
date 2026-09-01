import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(process.cwd(), '.env') });
dotenv.config({ path: path.join(process.cwd(), '.env.local') });

/** True when this file is the compiled build (dist) rather than the ts-node source. */
const IS_COMPILED = __filename.endsWith('.js');

// Migrations are DDL, so prefer a DIRECT (unpooled) connection — Neon's pooled endpoint
// (PgBouncer, transaction mode) is the wrong place to run schema changes. Falls back to the
// pooled URL, then to the discrete DB_* vars. TLS is on whenever a URL is used (managed
// Postgres like Neon requires it).
const migrationUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
const sslEnabled = process.env.DB_SSL
  ? process.env.DB_SSL === 'true'
  : Boolean(migrationUrl);

export const AppDataSource = new DataSource({
  type: 'postgres',
  ...(migrationUrl
    ? { url: migrationUrl }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        username: process.env.DB_USERNAME || 'fapoms',
        password: process.env.DB_PASSWORD || 'fapoms_dev',
        database: process.env.DB_DATABASE || 'fapoms',
      }),
  ...(sslEnabled ? { ssl: { rejectUnauthorized: false } } : {}),
  synchronize: process.env.DB_SYNCHRONIZE === 'true',
  logging: process.env.DB_LOGGING === 'true',
  /**
   * Load EITHER the compiled output or the TypeScript sources — never both.
   *
   * These globs used to list `dist/**` and `src/**` together. Once the project has been built
   * (which every production deploy does before running migrations), both matched the same 46
   * migrations, and TypeORM aborted with "Duplicate migrations: …" before executing a single
   * one. `migration:run` was therefore guaranteed to fail on a real deployment while appearing
   * to work in a fresh dev checkout that had no `dist/` yet.
   *
   * Which set to use is decided by how this very file is being executed: `.js` means we are
   * running the compiled build, `.ts` means ts-node.
   */
  entities: IS_COMPILED
    ? [
        path.join(process.cwd(), 'dist/**/*.entity.js'),
        path.join(process.cwd(), 'dist/modules/**/*.entities.js'),
      ]
    : [
        path.join(process.cwd(), 'src/**/*.entity.ts'),
        path.join(process.cwd(), 'src/modules/**/*.entities.ts'),
      ],
  migrations: IS_COMPILED
    ? [path.join(process.cwd(), 'dist/infrastructure/database/migrations/*.js')]
    : [path.join(process.cwd(), 'src/infrastructure/database/migrations/*.ts')],
  subscribers: [],
});
