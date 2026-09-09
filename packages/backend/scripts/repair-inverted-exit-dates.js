#!/usr/bin/env node
/**
 * Blanks an exit date that falls BEFORE the joining date, keeping a verbatim copy of what it
 * removes.
 *
 * ## Why this is separate from repair-corrupt-dates.js
 *
 * That script removes values that are not dates for a person at all — year 5750, year 0591 — by
 * asking a question about a single column: is this value inside a plausible window? Every row it
 * touches is unambiguous, because 5750-01-01 is wrong whatever else the row says.
 *
 * These rows are different. Both values are ordinary, plausible dates. The only thing wrong is
 * their ORDER, and the question "which of the two is the mistake?" cannot be answered by looking
 * at either one on its own. So it needed evidence, and then it needed a decision.
 *
 * ## The evidence, and the decision it supported
 *
 * Measured on the live roster before choosing. The exit dates involved are shared batch markers:
 * `2023-12-31` appears on 49 records, `2024-04-30` on 20, `2024-08-31` on 15 — month and year
 * ends, the shape of a bulk "everyone who left by then" fill rather than a real last working day.
 * The joining dates on the same rows are near-unique: each is shared by between 0 and 4 other
 * people, the shape of a real, specific date.
 *
 * So the exit date is the less trustworthy of the two, and it is the one this removes. The
 * joining date — which the qualification score reads for tenure — is kept.
 *
 * Nothing is invented. A removed exit date becomes NULL, which reads as "we do not know when
 * they left", because we do not.
 *
 * ## What is lost, stated plainly
 *
 * For a row whose lifecycle is RESIGNED or TERMINATED, nothing much: `hasLeftWorkforce` reads
 * the lifecycle status for those two, so the person still counts as departed everywhere it
 * matters. For a row whose lifecycle is INACTIVE, more: INACTIVE alone does not mean departed,
 * so blanking the date returns that person to the "still workable" population and they will
 * reappear on the roster's chase lists. That is the honest consequence of admitting we do not
 * know their leaving date, and it is visible rather than hidden — which is the point.
 *
 * ## Why it has to happen before repair-corrupt-dates.js
 *
 * `chk_assayers_employment_dates_sane` is evaluated against the WHOLE candidate row on every
 * update. A row that carries both an impossible birth date and an inverted employment pair
 * cannot have its birth date blanked while the pair is still inverted — the unrelated column
 * write is refused by the date constraint. Run this first, then the other.
 *
 * Idempotent: it selects only rows where the inversion is still present.
 *
 * Usage (from packages/backend, against the running stack):
 *   node scripts/repair-inverted-exit-dates.js --report   # list only
 *   node scripts/repair-inverted-exit-dates.js            # repair
 */
const { Client } = require('pg');

const REPORT_ONLY = process.argv.includes('--report');

/**
 * Rows this script will NOT touch: one where the joining date is itself outside the plausible
 * window. There, the inversion is a symptom of the garbage date, not a separate question, and
 * `repair-corrupt-dates.js` owns it — blanking the exit date as well would destroy a real value
 * to work around a fake one.
 */
const PLAUSIBLE_JOINING = `joining_date >= DATE '1900-01-01' AND joining_date < DATE '2100-01-01'`;
const INVERTED = `exit_date IS NOT NULL AND joining_date IS NOT NULL AND exit_date < joining_date`;

async function main() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME || process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE || process.env.DB_NAME || 'fapoms',
  });
  await client.connect();

  try {
    const { rows } = await client.query(
      `SELECT id, assayer_code, display_name, lifecycle_status, joining_date, exit_date
         FROM assayers
        WHERE ${INVERTED} AND ${PLAUSIBLE_JOINING}
        ORDER BY assayer_code`,
    );

    if (rows.length === 0) {
      console.log('Nothing to repair: no assayer has an exit date before their joining date.');
      return;
    }

    console.log(`${rows.length} assayer(s) left before they joined:`);
    for (const r of rows) {
      const j = String(r.joining_date).slice(0, 10);
      const e = String(r.exit_date).slice(0, 10);
      console.log(`  ${r.assayer_code}  ${r.lifecycle_status}  joined=${j}  exit=${e}  (removing exit)`);
    }

    if (REPORT_ONLY) {
      console.log('\n--report: nothing changed.');
      return;
    }

    await client.query('BEGIN');

    // Same backup table the other repair uses, so every removed value lives in one place. Append
    // only where this appraiser has no row yet: an earlier backup holds the ORIGINAL values and
    // must not be overwritten by today's already-partial ones.
    await client.query(`
      CREATE TABLE IF NOT EXISTS _fix_backup_corrupt_dates (
        id uuid, assayer_code varchar(50), display_name varchar(200),
        old_date_of_birth date, old_joining_date date, old_exit_date date,
        old_termination_date date, captured_at timestamptz
      )`);
    await client.query(
      `ALTER TABLE _fix_backup_corrupt_dates ADD COLUMN IF NOT EXISTS old_termination_date date`,
    );
    await client.query(
      `INSERT INTO _fix_backup_corrupt_dates
         (id, assayer_code, display_name, old_date_of_birth, old_joining_date, old_exit_date,
          old_termination_date, captured_at)
       SELECT a.id, a.assayer_code, a.display_name, a.date_of_birth, a.joining_date, a.exit_date,
              a.termination_date, now()
         FROM assayers a
        WHERE ${INVERTED.replace(/\b(exit_date|joining_date)\b/g, 'a.$1')}
          AND ${PLAUSIBLE_JOINING.replace(/\bjoining_date\b/g, 'a.joining_date')}
          AND NOT EXISTS (SELECT 1 FROM _fix_backup_corrupt_dates b WHERE b.id = a.id)`,
    );

    // One audit row per value removed, written BEFORE the value goes, so the event can name it.
    // `user_id` is NULL — no person did this, and the remark says what did.
    await client.query(
      `INSERT INTO audit_events
         (id, category, event_type, entity_type, entity_id, user_id, remarks, metadata, occurred_at)
       SELECT uuid_generate_v4(), 'OPERATIONAL', 'ASSAYER_INVERTED_EXIT_DATE_BLANKED', 'ASSAYER', a.id,
              NULL,
              'scripts/repair-inverted-exit-dates.js removed exit_date = ' || a.exit_date::text ||
              ' from ' || a.assayer_code || ', which fell before their joining date of ' ||
              a.joining_date::text || '. The exit date was a shared batch marker; the joining date '
              || 'is specific to this person, so the exit date was treated as the mistake. '
              || 'Original kept in _fix_backup_corrupt_dates.',
              jsonb_build_object(
                'removedExitDate', a.exit_date::text,
                'keptJoiningDate', a.joining_date::text,
                'lifecycleStatus', a.lifecycle_status::text),
              now()
         FROM assayers a
        WHERE ${INVERTED.replace(/\b(exit_date|joining_date)\b/g, 'a.$1')}
          AND ${PLAUSIBLE_JOINING.replace(/\bjoining_date\b/g, 'a.joining_date')}`,
    );

    const res = await client.query(
      `UPDATE assayers
          SET exit_date = NULL, updated_by = 'data-fix:inverted-exit-date', updated_at = now()
        WHERE ${INVERTED} AND ${PLAUSIBLE_JOINING}`,
    );

    await client.query('COMMIT');
    console.log(`\nBlanked exit_date on ${res.rowCount} row(s). Originals in _fix_backup_corrupt_dates.`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(`Repair failed, nothing was changed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
