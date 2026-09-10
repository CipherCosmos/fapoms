import { readdirSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';
import { Region, REGION_LABELS, resolveRegion } from '@fapoms/shared';

/**
 * A REGION STORED AS ITS DISPLAY LABEL IS A REGION NOTHING WILL EVER MATCH.
 *
 * `branches.region` and `users.regions` are both free-text columns, and every consumer compares
 * them with `=` or `IN`: `RegionGuardService.assertRegionAllowed`, the `region = ANY($1::text[])`
 * predicates in `billing-region-scope.ts`, the scope selector's counts. So the two sides have to
 * agree on one spelling, and the enum decides it — `WEST`, not `West`.
 *
 * `seed.ts` wrote the labels. Ten branches went in as `'West'`, `'South'` and `'Central'` while
 * `users.regions` holds enum codes, so on any freshly seeded deployment a region-scoped operator
 * matched NOTHING: no branches, no assignments, no documents, and — once the finance overview
 * started scoping too — no money. Not an error, not an empty state anybody would question. Just a
 * quietly empty application for every scoped account, and a region control that looked like it
 * was working because it certainly was not letting anything through.
 *
 * Found while setting up a live check of the overview fix: a WEST-scoped account returned zeros
 * for everything, which is the same answer a correct filter gives when a region genuinely has no
 * work, and the two are indistinguishable from the response alone.
 *
 * The real write path never had this problem — `BranchService` passes every value through
 * `resolveRegion`, which accepts a label, a state name or a code and returns the code. The seed
 * was the one place that assigned the column directly.
 */
describe('a stored region is always the enum code, never the label', () => {
  const SRC = join(__dirname, '..', '..');
  const LABELS = new Set(Object.values(REGION_LABELS));
  const CODES = new Set<string>(Object.values(Region));

  const sources = (() => {
    const out: Array<{ file: string; text: string }> = [];
    (function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!['node_modules', '_historical'].includes(entry.name)) walk(p);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) {
          out.push({
            file: relative(SRC, p).split(sep).join('/'),
            // Comments blanked: the prose in regions.ts names every label out loud.
            text: readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' '),
          });
        }
      }
    })(SRC);
    return out;
  })();

  it('reads the labels and codes apart, so this file is testing something', () => {
    expect(LABELS.has('West')).toBe(true);
    expect(CODES.has('West')).toBe(false);
    expect(CODES.has('WEST')).toBe(true);
    // And the label is not merely a case variant everywhere: NORTH_EAST is "North East".
    expect(REGION_LABELS[Region.NORTH_EAST]).toBe('North East');
  });

  it('assigns no region column a literal that is not an enum code', () => {
    // `region: 'West'` in seed.ts is the exact defect. A value that has to be resolved from a
    // state name or a legacy spelling goes through `resolveRegion`, which is what BranchService
    // does; a literal in the source has no excuse not to be the code already.
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      for (const m of text.matchAll(/\bregions?\s*:\s*'([^']*)'/g)) {
        const value = m[1];
        if (value === '' || CODES.has(value)) continue;
        offenders.push(`${file}: region: '${value}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('leaves the seed writing regions the guard can actually match', () => {
    // Named directly, because "no offenders" is also what an empty scan says. The seed must
    // still assign regions, and they must still be codes.
    const seed = sources.find((s) => s.file === 'infrastructure/database/seed.ts')!;
    expect(seed).toBeDefined();
    const assignments = [...seed.text.matchAll(/\bregion:\s*(Region\.[A-Z_]+)/g)].map((m) => m[1]);
    expect(assignments.length).toBeGreaterThanOrEqual(10);
    for (const a of assignments) {
      expect(CODES.has(a.replace('Region.', ''))).toBe(true);
    }
  });

  it('resolves every label back to its code, which is why the write path was never wrong', () => {
    // The safety net the seed bypassed. Documented here so a future writer reaches for it rather
    // than assigning the column, and so a change to `resolveRegion` that stopped accepting
    // labels would fail beside the rule that depends on it.
    for (const region of Object.values(Region)) {
      expect(resolveRegion(REGION_LABELS[region])).toBe(region);
      expect(resolveRegion(region)).toBe(region);
    }
    expect(resolveRegion('north east')).toBe(Region.NORTH_EAST);
    expect(resolveRegion('Maharashtra')).toBe(Region.WEST);
    // And it refuses to guess, which is what keeps an unrecognised branch visible under "All
    // regions" instead of silently filed under whichever region sorts first.
    expect(resolveRegion('Atlantis')).toBeNull();
  });
});
