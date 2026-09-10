import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { AssayerLifecycleStatus, AssayerStatus, EmpanelmentStatus } from '@fapoms/shared';

/**
 * A STATUS A REQUEST BODY SENDS MUST BE ONE THE SYSTEM HAS.
 *
 * Twice in one campaign, the tenant-isolation suite sent a status that no enum contains —
 * `EMPANELLED`, then `BLACKLISTED` — and both times the DTO refused the body with a 400 long
 * before the request reached the code the case existed to exercise. The own-tenant case failed
 * outright. The cross-tenant one asserted a refusal, and a 400 is a refusal, so it looked like a
 * pass waiting to happen and would have been read as proof that the organisation boundary holds.
 * It proved nothing of the kind: probing the route directly showed the boundary does hold, and
 * the assertion was simply never reaching it.
 *
 * These suites need a live deployment, so they are held out of the unit run and can sit wrong for
 * a long time before anybody discovers it. This file runs in the unit suite and needs nothing but
 * the source, so a value that does not exist fails the build on the commit that introduces it.
 *
 * Values, not form. A literal is perfectly readable in a test; a literal naming something that
 * does not exist is the defect. The enums are the vocabulary, and there is no third source.
 */
describe('every status a database suite sends is a real member of its enum', () => {
  const SUITES = join(__dirname, '..', '..');

  const KNOWN: ReadonlySet<string> = new Set<string>([
    ...Object.values(EmpanelmentStatus),
    ...Object.values(AssayerLifecycleStatus),
    ...Object.values(AssayerStatus),
  ]);

  /** Every `.db.spec.ts` under src, which is where the live-deployment suites live. */
  const files = (() => {
    const found: string[] = [];
    (function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== 'node_modules' && entry !== '_historical') walk(full);
        } else if (full.endsWith('.db.spec.ts')) {
          found.push(full);
        }
      }
    })(SUITES);
    return found;
  })();

  /**
   * `status: 'X'` and `targetStatus: 'X'` in a request body. Only screaming-snake literals, which
   * is what an enum value looks like — a `status: 'ok'` in a fixture is not this.
   */
  const sent = files.flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(/\b(?:target)?[Ss]tatus:\s*'([A-Z][A-Z_]{2,})'/g)].map((m) => ({
      file: file.slice(SUITES.length + 1),
      value: m[1],
      // Enough to find the line without making the assertion depend on line numbers.
      line: text.slice(0, m.index ?? 0).split('\n').length,
    }));
  });

  it('finds the suites and the statuses in them, so a broken scan cannot pass as a clean result', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(sent.length).toBeGreaterThanOrEqual(3);
  });

  it('sends nothing the enums do not define', () => {
    const unknown = sent.filter((s) => !KNOWN.has(s.value));
    // Named individually: "3 unknown statuses" sends somebody hunting, and the whole failure mode
    // here is a value that looks plausible.
    expect(unknown.map((u) => `${u.file}:${u.line} sends ${u.value}`)).toEqual([]);
  });

  it('knows the two that were actually wrong, so this cannot pass by knowing nothing', () => {
    expect(KNOWN.has('EMPANELLED')).toBe(false);
    expect(KNOWN.has('BLACKLISTED')).toBe(false);
    expect(KNOWN.has(EmpanelmentStatus.ACTIVE)).toBe(true);
    expect(KNOWN.has(EmpanelmentStatus.TERMINATED)).toBe(true);
  });
});
