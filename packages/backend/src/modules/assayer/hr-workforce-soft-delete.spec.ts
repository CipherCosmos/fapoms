import * as fs from 'fs';
import * as path from 'path';

/**
 * Every panel on the HR console has to agree about who is on the workforce.
 *
 * This file's service answers nine panels from ~22 hand-written SQL queries, seventeen of which
 * select `FROM assayers`. The soft-delete guard had been written into some and not others, and
 * the split was invisible because it only shows when someone actually deletes a profile.
 *
 * When that happened here — all eight assayers soft-deleted — the console contradicted itself on
 * one screen: headcount said 0, while the onboarding pipeline listed all 8 as candidates waiting
 * to be processed, the records-completeness panel reported them as incomplete records to chase,
 * and two coverage denominators divided by 8. Ops were being asked to act on people who had been
 * deleted.
 *
 * A source-level assertion rather than a behavioural one: the failure is a *missing* clause in
 * one of seventeen near-identical queries, which is exactly what a reviewer's eye skips and what
 * a grep catches.
 */

const SERVICE = path.join(__dirname, 'hr-workforce.service.ts');

/** Statements selecting from the assayers table, with the line they start on. */
function assayerQueries(): { line: number; statement: string; preamble: string }[] {
  const lines = fs.readFileSync(SERVICE, 'utf8').split('\n');
  const found: { line: number; statement: string; preamble: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    // Skip comments, which quote the very SQL this test is about — including the single-line
    // `/** … */` form above ON_ROSTER_A.
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    // `JOIN assayers a ON …`, not just `FROM assayers`. Scanning only for FROM is how six
    // queries came to omit the is_active clause unnoticed: every one of them reaches the table
    // through a JOIN from `workforce_attributes` or `assayer_government_documents`, so the
    // narrower pattern never saw them and this suite passed while the rule was broken.
    if (!/\b(FROM|JOIN)\s+assayers\b/.test(lines[i])) continue;

    // The statement runs to the end of the template literal, or 12 lines, whichever is first.
    const window = lines.slice(i, Math.min(i + 12, lines.length)).join('\n');
    const end = window.indexOf('`');
    // An exemption marker reads naturally ABOVE the FROM/JOIN it applies to, which is outside
    // the statement window — so it is looked for separately rather than by widening the window,
    // which would truncate the statement at the template literal's opening backtick.
    const preamble = lines.slice(Math.max(0, i - 6), i).join('\n');
    found.push({
      line: i + 1,
      // The statement ALONE. It used to carry the preamble concatenated onto it, and both filters
      // below read that combined string — so a query passed the soft-delete check whenever any of
      // the six lines above it happened to mention `is_active` or `ON_ROSTER`, which on this file
      // is true for 8 of the 32 queries. All 32 do carry their own guard today, so nothing was
      // wrongly passing; the test simply could not have told anyone if one stopped. A guard that
      // reads its neighbours' text is not reading the thing it is guarding.
      statement: end > 0 ? window.slice(0, end) : window,
      // Kept separate, because the exemption marker legitimately reads above the FROM/JOIN it
      // applies to — that is where a person would naturally write it.
      preamble,
    });
  }
  return found;
}

describe('HR workforce queries respect soft deletion', () => {
  it('finds the queries to check', () => {
    // Guards the guard: if the file is restructured so the scan finds nothing, this test would
    // otherwise pass by vacuously checking an empty list.
    expect(assayerQueries().length).toBeGreaterThan(10);
  });

  it('every query over assayers filters out deleted profiles', () => {
    const leaking = assayerQueries()
      // A query may opt out by saying so in SQL, next to itself, with a reason. The activity
      // trail is the only current case: history does not stop being true when someone leaves.
      // Declaring it at the query rather than as a line number here means the exemption moves
      // with the code and has to be re-justified if the query is rewritten.
      .filter(({ statement, preamble }) => !/soft-delete-exempt/.test(statement + preamble))
      .filter(({ statement }) => !/is_active|ON_ROSTER/.test(statement))
      .map(({ line }) => `hr-workforce.service.ts:${line}`);

    expect(leaking).toEqual([]);
  });

  /**
   * Departure is a status as well as a date, and the roster test has to read both.
   *
   * `ON_ROSTER` tested the two departure DATES, and its own comment said a person who resigned or
   * was terminated is off the roster. Those disagreed for 25 people on this data: a departed
   * lifecycle with no leaving date anywhere, because the sheet never carried one and the
   * corrupt-date repair blanked what it did carry. Reading only the dates, all 25 counted as
   * current staff — headcount 742 where it should say 717, every coverage denominator inflated by
   * them, and a clerk asked to go and complete the records of people who have left.
   *
   * Asserted at source level for the same reason as the soft-delete rule above: the fault is a
   * missing clause in one of seventeen near-identical queries, which reads fine and greps badly.
   */
  it('treats a departed lifecycle as off the roster, not only a departure date', () => {
    const source = fs.readFileSync(SERVICE, 'utf8');
    const onRoster = source.match(/^const ON_ROSTER(_A)? = .*$/gm) ?? [];

    expect(onRoster).toHaveLength(2);
    for (const definition of onRoster) {
      expect(definition).toMatch(/HAS_LEFT/);
      expect(definition).toMatch(/exit_date IS NULL/);
      expect(definition).toMatch(/termination_date IS NULL/);
      expect(definition).toMatch(/is_active = true/);
    }
  });

  /**
   * The headcount's three buckets must not let anybody fall between them.
   *
   * `active` and `onboarding` are counted from `lifecycle_status`; `exited` used to carry its own
   * hand-written status list. The comment above it already records this failing once — departures
   * counted from the dates alone made a resigned assayer appear in none of the three — and it
   * came back for the one departure the replacement list did not name. A death is filed as
   * INACTIVE with a reason rather than as a lifecycle value, so that person was in the total and
   * in none of the parts: 445 exited where the honest figure was 446.
   */
  it('counts departures through the one predicate, so nobody falls between the buckets', () => {
    const source = fs.readFileSync(SERVICE, 'utf8');
    // Sliced backwards from `AS exited` to the FILTER that owns it. A single lazy regex matches
    // from the first `COUNT(*) FILTER` in the file instead, swallowing four unrelated counters.
    const end = source.indexOf('::int AS exited');
    expect(end).toBeGreaterThan(-1);
    const exited = source.slice(source.lastIndexOf('COUNT(*) FILTER (WHERE', end), end);

    expect(exited).toContain('HAS_LEFT');
    // The dates stay too — they catch a departure entered without the lifecycle being moved.
    expect(exited).toContain('exit_date IS NOT NULL');
    expect(exited).toContain('termination_date IS NOT NULL');
    // And it must not have quietly regrown its own copy of the status list beside HAS_LEFT.
    expect(exited).not.toMatch(/lifecycle_status IN \(/);
  });

  it('names every way of having left, including the one filed as a reason', () => {
    const source = fs.readFileSync(SERVICE, 'utf8');
    const hasLeft = /const HAS_LEFT = \(p: string\) =>([\s\S]*?);\n/.exec(source)?.[1] ?? '';

    for (const status of ['RESIGNED', 'TERMINATED', 'ARCHIVED']) {
      expect(hasLeft).toContain(status);
    }
    // A death is recorded as INACTIVE plus a reason, never as a lifecycle value — so an ordinary
    // status list misses it, exactly as the data-integrity scan's own `hasLeft` had to learn.
    expect(hasLeft).toMatch(/INACTIVE[\s\S]*DECEASED/);
  });

  /**
   * The roster denominators specifically. These divide "how many have a document" by "how many
   * people are there", so a deleted profile in the denominator understates coverage and sends
   * HR chasing paperwork for someone who no longer exists.
   */
  it('counts the roster consistently wherever it is used as a denominator', () => {
    const source = fs.readFileSync(SERVICE, 'utf8');
    const denominators = source.match(/SELECT COUNT\(\*\)::int FROM assayers WHERE [^)]+\) +AS roster/g) ?? [];
    expect(denominators.length).toBeGreaterThan(0);
    for (const denominator of denominators) {
      expect(denominator).toMatch(/ON_ROSTER|is_active/);
    }
  });
});
