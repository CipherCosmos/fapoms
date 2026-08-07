#!/usr/bin/env node
/**
 * Flags every account still using a well-known seeded password so it must be changed at next
 * sign-in.
 *
 * Why this exists: every account in a freshly seeded FAPOMS database shares one of a small
 * number of demo passwords. Measured on this deployment, 12 of 13 staff users and 25 of 25
 * assayers were using one. That is fine for a demo and unacceptable for a system holding
 * bank collateral-audit evidence, so this marks them all `must_change_password = true`.
 *
 * It deliberately does NOT change or clear anyone's password. Locking everyone out at once
 * would strand field assayers mid-audit with no way back in. They keep working; they are
 * required to choose a new credential the next time they sign in.
 *
 * Usage (from the repo root, against the running stack):
 *   docker compose exec backend node scripts/flag-weak-passwords.js
 *   docker compose exec backend node scripts/flag-weak-passwords.js --report
 *
 * (The container's working directory is already /app/packages/backend.)
 *
 *   --report   count only, change nothing.
 */

const bcrypt = require('bcrypt');
const { Client } = require('pg');

/** Passwords shipped in seeds/fixtures. Extend if more are introduced. */
const KNOWN_SEEDED_PASSWORDS = [
  'assayer123',
  'admin123',
  'Password@123',
  'password',
  'changeme',
  '123456',
  'admin',
];

const REPORT_ONLY = process.argv.includes('--report');

async function main() {
  const client = new Client({
    host: process.env.DB_HOST || 'postgres',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME || 'fapoms',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'fapoms',
  });
  await client.connect();

  const targets = [
    { table: 'users', label: 'username' },
    { table: 'assayers', label: 'assayer_code' },
  ];

  let grandTotal = 0;

  for (const { table, label } of targets) {
    const { rows } = await client.query(
      `SELECT id, ${label} AS label, password_hash FROM ${table} WHERE password_hash IS NOT NULL`,
    );

    const weak = [];
    for (const row of rows) {
      for (const candidate of KNOWN_SEEDED_PASSWORDS) {
        // bcrypt.compare, not a hash lookup — the stored value is salted per row.
        if (await bcrypt.compare(candidate, row.password_hash)) {
          weak.push({ id: row.id, label: row.label, password: candidate });
          break;
        }
      }
    }

    grandTotal += weak.length;
    console.log(`\n${table}: ${weak.length} of ${rows.length} accounts use a seeded password`);
    for (const w of weak) console.log(`   ${w.label}  (${w.password})`);

    if (!REPORT_ONLY && weak.length > 0) {
      await client.query(
        `UPDATE ${table} SET must_change_password = true WHERE id = ANY($1::uuid[])`,
        [weak.map((w) => w.id)],
      );
      console.log(`   -> flagged ${weak.length} account(s) for forced password change`);
    }
  }

  if (grandTotal === 0) {
    console.log('\nNo account is using a known seeded password.');
  } else if (REPORT_ONLY) {
    console.log(`\n${grandTotal} account(s) would be flagged. Re-run without --report to apply.`);
  } else {
    console.log(`\n${grandTotal} account(s) flagged. They keep their current password until they sign in, then must choose a new one.`);
  }

  await client.end();
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
