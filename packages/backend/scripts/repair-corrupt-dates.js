#!/usr/bin/env node
/**
 * Blanks appraiser dates that are not dates, keeping a verbatim copy of every value it removes.
 *
 * Why this exists: the roster importer's date reader used to fall through to `new Date(s)`, and
 * JavaScript reads a bare number as a YEAR — `new Date("5484")` is 1 January 5484. Any date cell
 * holding a plain number (a fee, an employee number, a code in the wrong column) became a
 * confident, valid-looking date, every one landing on `01-01`. Measured on the real 1,155-person
 * roster: 75 dates of birth between year 0138 and 9952, 58 joining dates, 26 exit dates. They
 * were worse than blanks — the qualification score reads `joining_date` for tenure, so "joined in
 * 6333" scored on a negative career length with nothing on screen looking wrong.
 *
 * The parser is fixed (`RosterImportService.readDate` now bounds its result and reports the cell
 * instead of storing it), so no NEW corruption can arrive. This script repairs what is already in
 * the table. Its first, ad-hoc incarnation ran as pasted SQL: it left no audit rows, was not in
 * the repo, and missed 5 rows — which is exactly why this committed version exists.
 *
 * What it does, per out-of-range value:
 *   1. copies the row's current dates into `_fix_backup_corrupt_dates` (created if absent,
 *      appended only if this appraiser has no backup row yet — earlier backups are never
 *      overwritten, so the ORIGINAL corrupt value survives any number of runs);
 *   2. sets the offending column to NULL — a missing date reads as missing, which is the truth;
 *      nothing is ever guessed or invented;
 *   3. tags the row (`updated_by = 'data-fix:corrupt-date'`) and writes one audit event naming
 *      the appraiser, the column and the value removed.
 *
 * The bounds are the same as the parser's `isPlausibleHumanDate`, and like it they depend on what
 * the date is FOR: an employment date runs 1900-01-01 through the end of `current year + 5`, a
 * birth date 1900-01-01 through today. Checked against every legitimate date in the live table
 * before choosing — nothing real falls outside them (a genuine future-dated exit, i.e. notice
 * served in advance, stays; every future date beyond the window in this data was year 3009+
 * corruption).
 *
 * One window for all four columns was wrong at both ends, which is why they are split: `+2` years
 * refused an employment date four years out that the data-integrity scan treats as perfectly
 * plausible, and it accepted two years of birth dates that have not happened yet.
 *
 * Idempotent by construction: it selects only values outside the window, so a second run finds
 * nothing and reports 0. Safe to run on production as-is.
 *
 * Usage (from the repo root, against the running stack):
 *   docker compose exec backend node scripts/repair-corrupt-dates.js --report   # count only
 *   docker compose exec backend node scripts/repair-corrupt-dates.js           # repair
 */

const { Client } = require('pg');

const REPORT_ONLY = process.argv.includes('--report');

/**
 * The calendar day a `date` column actually holds, as `YYYY-MM-DD` — for the console listing.
 *
 * `pg` parses a `date` into a JS Date at LOCAL midnight, so neither obvious shortcut works east
 * of Greenwich, and this script's home deployment runs in IST:
 *   - comparing against `new Date('1900-01-01')` compares local midnight to UTC midnight, so a
 *     genuine 1900-01-01 lands 5h30m BEFORE the bound and is listed as impossible;
 *   - `toISOString().slice(0, 10)` converts local midnight back to UTC and lands on the previous
 *     day, printing 2026-07-24 as 2026-07-23.
 * Together they made the printed listing name the wrong column, or none at all, on the very
 * screen an operator reads before letting the script write. The UPDATE was never affected — it
 * runs in SQL against parameterised date strings — but `--report` is nothing BUT this listing,
 * so the report mode was the whole safety check and it was lying.
 *
 * Reading the local components back out returns the original Y/M/D unchanged, which is what the
 * SQL bounds are compared against. The year is padded to four so lexicographic comparison holds
 * for the real corrupt values, which run from year 0138 to 9952.
 */
const calendarDay = (d) => `${String(d.getFullYear()).padStart(4, '0')}`
  + `-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The same windows as `RosterImportService.isPlausibleHumanDate` — keep the two in step.
 *
 * They are per-column, because how far ahead a date may plausibly sit depends on what the date is
 * for. This script and the parser both used one window of `year + 2` for all four columns, which
 * was wrong in both directions: it refused an employment date four years out that the
 * data-integrity scan considers entirely plausible, and it accepted two years of birth dates that
 * had not happened yet.
 *
 * Verified against the live table before changing: zero rows sit in either of the bands this
 * moves, so re-running the script over today's data still finds nothing.
 */
const MIN_DATE = '1900-01-01';
/** A notice period served in advance is real; so is a fixed-term engagement with an end date. */
const MAX_EMPLOYMENT_DATE = `${new Date().getFullYear() + 5}-12-31`;
/** Nobody is born on a day that has not happened yet. Local fields, not toISOString — see below. */
const MAX_BIRTH_DATE = calendarDay(new Date());

const DATE_COLUMNS = ['date_of_birth', 'joining_date', 'exit_date', 'termination_date'];

/** Which bound applies, whether or not the column arrives table-qualified (`a.date_of_birth`). */
const isBirthColumn = (col) => col.endsWith('date_of_birth');
const maxDateFor = (col) => (isBirthColumn(col) ? MAX_BIRTH_DATE : MAX_EMPLOYMENT_DATE);

async function main() {
  const client = new Client({
    host: process.env.DB_HOST || 'postgres',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME || 'fapoms',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'fapoms',
  });
  await client.connect();

  // $1 = MIN_DATE, $2 = employment ceiling, $3 = birth ceiling. Parameterised per column rather
  // than string-substituted: the previous version built the unqualified predicate and then
  // `replaceAll`-ed each column name to add the `a.` prefix for the backup query, which silently
  // depends on no column name being a substring of another.
  const outOfRange = (col) =>
    `${col} IS NOT NULL AND (${col} < $1 OR ${col} > ${isBirthColumn(col) ? '$3' : '$2'})`;
  const anyOutOfRange = (prefix = '') =>
    DATE_COLUMNS.map((c) => outOfRange(`${prefix}${c}`)).join(' OR ');
  const BOUNDS = [MIN_DATE, MAX_EMPLOYMENT_DATE, MAX_BIRTH_DATE];

  /**
   * The single-column form, and why it cannot reuse `outOfRange` above.
   *
   * `outOfRange` numbers its ceiling $2 for an employment column and $3 for a birth one, which is
   * correct only in a statement that mentions BOTH kinds — the scan at the top does, because it
   * ORs all four columns together. The per-column statements below mention one, so one of $2/$3
   * is never referenced, and Postgres cannot infer the type of a parameter that appears nowhere:
   *
   *     error: could not determine data type of parameter $2
   *
   * Every per-column statement therefore failed, the transaction rolled back, and the script
   * reported "Repair failed, nothing was changed" — while `--report` succeeded, because the
   * report only ever runs the combined scan. So the script looked like it worked right up until
   * the moment it was asked to do something, which is why 32 impossible dates were still in the
   * table months after it was committed.
   *
   * One ceiling, always $2, chosen per column.
   */
  const outOfRangeOne = (col) => `${col} IS NOT NULL AND (${col} < $1 OR ${col} > $2)`;
  const boundsFor = (col) => [MIN_DATE, maxDateFor(col)];

  try {
    const { rows } = await client.query(
      `SELECT id, assayer_code, display_name, date_of_birth, joining_date, exit_date, termination_date
         FROM assayers
        WHERE ${anyOutOfRange()}
        ORDER BY assayer_code`,
      BOUNDS,
    );

    if (rows.length === 0) {
      console.log(
        `Nothing to repair: every birth date is within ${MIN_DATE}..${MAX_BIRTH_DATE} `
        + `and every employment date within ${MIN_DATE}..${MAX_EMPLOYMENT_DATE}.`,
      );
      return;
    }

    console.log(`${rows.length} appraiser(s) carry at least one impossible date:`);
    for (const r of rows) {
      const bad = DATE_COLUMNS
        .filter((c) => r[c] && (calendarDay(r[c]) < MIN_DATE || calendarDay(r[c]) > maxDateFor(c)))
        .map((c) => `${c}=${calendarDay(r[c])}`);
      console.log(`  ${r.assayer_code}  ${bad.join('  ')}`);
    }

    if (REPORT_ONLY) {
      console.log('\n--report: nothing changed.');
      return;
    }

    await client.query('BEGIN');

    // The backup table matches the shape the first (ad-hoc) repair created, so both repairs'
    // originals live in one place. Append-only per appraiser: a row already backed up keeps its
    // FIRST captured values — those are the originals; today's values may already be partial.
    await client.query(`
      CREATE TABLE IF NOT EXISTS _fix_backup_corrupt_dates (
        id uuid, assayer_code varchar(50), display_name varchar(200),
        old_date_of_birth date, old_joining_date date, old_exit_date date,
        old_termination_date date, captured_at timestamptz
      )`);
    // The ad-hoc run created the table without termination_date; add it rather than fail.
    await client.query(
      `ALTER TABLE _fix_backup_corrupt_dates ADD COLUMN IF NOT EXISTS old_termination_date date`,
    );

    const backup = await client.query(
      `INSERT INTO _fix_backup_corrupt_dates
         (id, assayer_code, display_name, old_date_of_birth, old_joining_date, old_exit_date,
          old_termination_date, captured_at)
       SELECT a.id, a.assayer_code, a.display_name, a.date_of_birth, a.joining_date, a.exit_date,
              a.termination_date, now()
         FROM assayers a
        WHERE (${anyOutOfRange('a.')})
          AND NOT EXISTS (SELECT 1 FROM _fix_backup_corrupt_dates b WHERE b.id = a.id)`,
      BOUNDS,
    );

    let totalBlanked = 0;
    for (const col of DATE_COLUMNS) {
      // One audit row per value removed, BEFORE the value is blanked, so the event can name it.
      // `user_id` is NULL — no person did this; the remarks name the script instead.
      await client.query(
        `INSERT INTO audit_events
           (id, category, event_type, entity_type, entity_id, user_id, remarks, metadata, occurred_at)
         SELECT uuid_generate_v4(), 'OPERATIONAL', 'ASSAYER_CORRUPT_DATE_BLANKED', 'ASSAYER', a.id,
                NULL,
                'scripts/repair-corrupt-dates.js removed ' || $3 || ' = ' || a.${col}::text ||
                ' from ' || a.assayer_code ||
                ' — not a real date for a person (importer parse bug); original kept in _fix_backup_corrupt_dates.',
                jsonb_build_object('column', $3, 'removed', a.${col}::text),
                now()
           FROM assayers a
          WHERE ${outOfRangeOne(`a.${col}`)}`,
        // $1/$2 are this column's own bounds; $3 is the column NAME for the remark.
        [...boundsFor(col), col],
      );

      const { rows: affected } = await client.query(
        `SELECT count(*)::int AS n FROM assayers WHERE ${outOfRangeOne(col)}`,
        boundsFor(col),
      );
      if (affected[0].n > 0) console.log(`  blanking ${col} on ${affected[0].n} row(s)`);
      totalBlanked += affected[0].n;
    }

    /**
     * ONE update for every column, not one per column.
     *
     * `chk_assayers_employment_dates_sane` is evaluated against the whole candidate row, and 25
     * of these rows carry BOTH an impossible birth date and a joining date in the 4200s that
     * their real exit date precedes. Blanking column by column meant the birth-date write was
     * refused because the row's employment pair was still inverted — a column the statement had
     * not touched and was about to fix on the next pass. The whole transaction rolled back and
     * the script reported that nothing had changed, correctly and unhelpfully.
     *
     * Nulling every out-of-range value in a single statement takes the row from bad to good in
     * one step, so the constraint only ever sees the finished result. The audit rows above are
     * still written per column, because "which value was removed" is the question somebody will
     * actually ask.
     */
    // Each column gets its own pair of bound parameters, numbered in order, so the SET and the
    // WHERE below speak the same numbering and no parameter goes unreferenced.
    const predicate = (c, i) => `${c} IS NOT NULL AND (${c} < $${i * 2 + 1} OR ${c} > $${i * 2 + 2})`;
    const setClause = DATE_COLUMNS
      .map((c, i) => `${c} = CASE WHEN ${predicate(c, i)} THEN NULL ELSE ${c} END`)
      .join(', ');
    const whereClause = DATE_COLUMNS.map((c, i) => `(${predicate(c, i)})`).join(' OR ');
    const setParams = DATE_COLUMNS.flatMap((c) => boundsFor(c));
    await client.query(
      `UPDATE assayers
          SET ${setClause}, updated_by = 'data-fix:corrupt-date', updated_at = now()
        WHERE ${whereClause}`,
      setParams,
    );

    await client.query('COMMIT');

    const { rows: remaining } = await client.query(
      `SELECT count(*)::int AS n FROM assayers WHERE ${anyOutOfRange()}`,
      BOUNDS,
    );
    console.log(
      `\nDone: ${totalBlanked} value(s) blanked, ${backup.rowCount} new backup row(s), ` +
        `${remaining[0].n} impossible date(s) remaining (must be 0).`,
    );
    if (remaining[0].n !== 0) process.exitCode = 1;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`Repair failed, nothing was changed: ${err.message}`);
  process.exit(1);
});
