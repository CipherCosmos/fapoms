#!/usr/bin/env node
/**
 * Create one empty FAPOMS database with the extensions the migrations need, and nothing else.
 *
 * A three-line job that is three lines of shell right up until it is inside a YAML block scalar
 * inside a double-quoted `node -e`, at which point the quoting has four levels and the failure
 * mode is a syntax error in a file nobody can run locally. So it is a file.
 *
 *   DB_ADMIN_URL=postgres://user:pw@host:5432/postgres DB_NAME=fapoms_ci node scripts/create-database.mjs
 *
 * Idempotent: an existing database is left alone, extensions are `IF NOT EXISTS`. It does NOT
 * create roles or apply grants — that is `db:bootstrap-roles` and `db:harden`, and a job that
 * only needs somewhere to run migrations should not be quietly provisioning identities.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const ADMIN_URL = process.env.DB_ADMIN_URL;
const NAME = process.env.DB_NAME;

if (!ADMIN_URL || !NAME) {
  console.error('DB_ADMIN_URL and DB_NAME are both required.');
  process.exit(1);
}
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(NAME)) {
  // Interpolated into `CREATE DATABASE`, which takes no parameters.
  console.error(`DB_NAME must be a plain identifier, got: ${NAME}`);
  process.exit(1);
}

/** What the migrations assume is installed. Each needs an administrative connection. */
const EXTENSIONS = ['uuid-ossp', 'pgcrypto', 'postgis'];

const admin = new Client({ connectionString: ADMIN_URL });
await admin.connect();
try {
  const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [NAME]);
  if (existing.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${NAME}"`);
    console.log(`Created database ${NAME}.`);
  } else {
    console.log(`Database ${NAME} already exists.`);
  }
} finally {
  await admin.end();
}

const url = new URL(ADMIN_URL);
url.pathname = `/${NAME}`;
const inDb = new Client({ connectionString: url.toString() });
await inDb.connect();
try {
  for (const extension of EXTENSIONS) {
    await inDb.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
  }
  console.log(`Extensions ready: ${EXTENSIONS.join(', ')}.`);
} finally {
  await inDb.end();
}
