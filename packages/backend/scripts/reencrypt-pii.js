#!/usr/bin/env node
/**
 * One-time (and re-runnable) encryption backfill for stored personal identifiers.
 *
 * Why this exists: the `encryptedColumn` transformer has been declared on `pan_number`,
 * `bank_account_number` and `aadhaar_number` for months, but `PII_ENCRYPTION_KEY` was never set —
 * so the transformer was a no-op and 1,128 PANs, 578 Aadhaar numbers and 1,040 bank accounts sat
 * in Postgres as plaintext, readable by anyone with database access or a copy of a backup. The
 * layer "self-migrates on write", but these rows are written rarely: waiting for organic writes
 * means plaintext for months more. This walks them once.
 *
 * How: encryption is done by the SAME compiled module the application uses
 * (`dist/infrastructure/security/field-encryption`), not a re-implementation — one crypto
 * implementation, zero drift. Rows already carrying the `enc:v1:` prefix are skipped, which is
 * what makes a second run report 0. Each column update is verified readable back through
 * `decryptField` before commit; any mismatch aborts the whole transaction.
 *
 * It refuses to run at all when the key is unset (encrypting with a passthrough would do
 * nothing) — and prints exactly which env var to set.
 *
 * Usage (from the repo root, against the running stack — the container must have
 * PII_ENCRYPTION_KEY in its environment, i.e. recreate it after adding the key to .env.docker):
 *   docker compose exec backend node scripts/reencrypt-pii.js --report   # counts only
 *   docker compose exec backend node scripts/reencrypt-pii.js           # encrypt
 */

const path = require('path');
const { Client } = require('pg');

const REPORT_ONLY = process.argv.includes('--report');

let enc;
try {
  // The application's own compiled crypto — the dev container's tsc watch keeps dist/ current.
  enc = require(path.join(__dirname, '..', 'dist', 'infrastructure', 'security', 'field-encryption'));
} catch (e) {
  console.error(
    'Could not load the compiled encryption module (dist/infrastructure/security/field-encryption).\n' +
      'Run `npm run build` in packages/backend first — this script deliberately reuses the ' +
      "application's own implementation rather than duplicating the cipher.",
  );
  process.exit(1);
}

if (!process.env.PII_ENCRYPTION_KEY) {
  console.error(
    'PII_ENCRYPTION_KEY is not set in this environment, so there is nothing to encrypt with.\n' +
      'Add it to .env.docker (local) or the deploy env (production; generate with ' +
      '`openssl rand -hex 32`), recreate the backend container, and run again.',
  );
  process.exit(1);
}

/** table → columns the transformer protects. Extend here when a new column gains it. */
const TARGETS = [
  { table: 'assayers', id: 'id', label: (r) => r.assayer_code, extra: 'assayer_code', columns: ['pan_number', 'bank_account_number', 'aadhaar_number'] },
  { table: 'assayer_documents', id: 'id', label: (r) => r.id, extra: 'id', columns: ['document_number'] },
];

async function main() {
  const client = new Client({
    host: process.env.DB_HOST || 'postgres',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME || 'fapoms',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'fapoms',
  });
  await client.connect();

  try {
    let grandTotal = 0;

    for (const t of TARGETS) {
      for (const col of t.columns) {
        const { rows } = await client.query(
          // Plaintext = present, non-empty, and not already carrying the version prefix.
          `SELECT ${t.id} AS id, ${t.extra} AS extra, ${col} AS value
             FROM ${t.table}
            WHERE ${col} IS NOT NULL AND ${col} <> '' AND ${col} NOT LIKE 'enc:v1:%'`,
        );

        console.log(`${t.table}.${col}: ${rows.length} plaintext value(s)`);
        if (REPORT_ONLY || rows.length === 0) continue;

        await client.query('BEGIN');
        try {
          for (const r of rows) {
            const cipher = enc.encryptField(r.value);
            if (!enc.isEncrypted(cipher) || enc.decryptField(cipher) !== r.value) {
              // Round-trip proof per value. If this ever fires, the key or module is wrong and
              // NOTHING should be written — a half-encrypted table is worse than a plaintext one.
              throw new Error(`round-trip failed for ${t.table}.${col} on ${r.extra}`);
            }
            await client.query(`UPDATE ${t.table} SET ${col} = $1 WHERE ${t.id} = $2`, [cipher, r.id]);
          }
          await client.query(
            // `entity_id` is NOT NULL with no default. Passing NULL aborted the transaction AFTER
            // every UPDATE had run, so the rollback discarded the whole column's encryption and the
            // script exited 1 having changed nothing — while `--report` still looked healthy. This
            // event is about the system rather than one record, so it carries the nil UUID.
            `INSERT INTO audit_events (id, category, event_type, entity_type, entity_id, user_id, remarks, metadata, occurred_at)
             VALUES (uuid_generate_v4(), 'OPERATIONAL', 'PII_ENCRYPTION_BACKFILL', 'SYSTEM',
                     '00000000-0000-0000-0000-000000000000'::uuid, NULL,
                     'scripts/reencrypt-pii.js encrypted ' || $1 || ' ' || $2 || '.' || $3 ||
                     ' value(s) at rest (AES-256-GCM). Values were legacy plaintext from before the key was set.',
                     jsonb_build_object('table', $2, 'column', $3, 'count', $1::int), now())`,
            [rows.length, t.table, col],
          );
          await client.query('COMMIT');
          console.log(`  encrypted ${rows.length} — verified round-trip on every value`);
          grandTotal += rows.length;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    }

    if (REPORT_ONLY) {
      console.log('\n--report: nothing changed.');
    } else {
      console.log(`\nDone: ${grandTotal} value(s) now encrypted. A second run must report 0 everywhere.`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`Backfill aborted, transaction rolled back: ${err.message}`);
  process.exit(1);
});
