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
function assayerQueries(): { line: number; statement: string }[] {
  const lines = fs.readFileSync(SERVICE, 'utf8').split('\n');
  const found: { line: number; statement: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    // Skip comments, which quote the very SQL this test is about — including the single-line
    // `/** … */` form above ON_ROSTER_A.
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    if (!/FROM assayers\b/.test(lines[i])) continue;

    // The statement runs to the end of the template literal, or 12 lines, whichever is first.
    const window = lines.slice(i, Math.min(i + 12, lines.length)).join('\n');
    const end = window.indexOf('`');
    found.push({ line: i + 1, statement: end > 0 ? window.slice(0, end) : window });
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
      .filter(({ statement }) => !/is_active|ON_ROSTER/.test(statement))
      .map(({ line }) => `hr-workforce.service.ts:${line}`);

    expect(leaking).toEqual([]);
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
