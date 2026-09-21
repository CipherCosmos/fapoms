import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Business dates are Asia/Kolkata. The UTC shortcut may not come back.
 *
 * README: "Business dates are `Asia/Kolkata`, independent of server timezone — use
 * `businessDateKey` / `formatDateOnly` from shared, never `toISOString().split('T')[0]`." That
 * line has been in the README throughout, and on 2026-09-19 a sweep found **33 live violations
 * across 25 files** — in billing, assignment scheduling, the planner, registration and the HR
 * roster. A rule nothing enforces is a suggestion.
 *
 * Why it matters, concretely. IST is UTC+5:30, so the UTC calendar day is still YESTERDAY for
 * every moment between 00:00 and 05:30 IST, and for any date-picker value that arrived with an
 * IST offset. Found by that sweep:
 *
 *   - `daysUntilExpiry` (shared/labels.ts) read the stored day in UTC and today in IST, then
 *     subtracted them — two calendars in one sum, inside the file that defines the rule.
 *   - `HolidayService.isHoliday` built BOTH its query and its cache key from the UTC day, so
 *     they agreed with each other while both asked about the wrong date: a real public holiday
 *     read as an ordinary working day, and that answer was then cached.
 *   - `DayPlannerService.resolveWorkingDate` formatted in UTC while stepping the candidate with
 *     server-LOCAL `getDate`/`setDate` — two clocks in one loop.
 *   - A candidate's date of birth moved a day just by opening the registration form.
 *
 * The earlier audit recorded only the `.split('T')[0]` spelling and counted four sites. The
 * `.slice(0, 10)` spelling accounted for the other twenty-nine, which is why this guard matches
 * the SHAPE rather than a remembered list — see the standing lesson that a rule written down as
 * the instances that existed that day goes stale.
 *
 * Exemptions are named below, each with its reason. Adding one is a deliberate edit to this
 * file; it is not something a commit can do by accident.
 */
describe('business dates use the Asia/Kolkata helper, never the UTC slice', () => {
  const REPO = join(__dirname, '..', '..', '..');

  /** The two spellings of "take the UTC calendar day", both banned. */
  const BANNED = /\.toISOString\(\)\s*\.\s*(?:split\('T'\)\[0\]|slice\(\s*0\s*,\s*10\s*\))/;

  /**
   * Genuinely not business dates. Each is exempt for a stated reason, not for convenience.
   */
  const EXEMPT: Array<{ file: string; why: string }> = [
    {
      file: 'packages/backend/src/modules/pricing/transport-rate.service.ts',
      why: 'Asks "is this STRING a real calendar date", parsing as UTC midnight and comparing '
         + 'against its own UTC serialisation. Both sides are the same clock, so they cannot '
         + 'drift; reading it back in another zone would start rejecting valid input.',
    },
  ];
  const EXEMPT_FILES = new Set(EXEMPT.map((e) => e.file));

  const PACKAGES = ['backend', 'frontend', 'shared', 'mobile'];

  const sourceFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry)) continue;
        // Tests may legitimately construct an expected UTC value to assert against.
        if (/\.spec\.tsx?$/.test(entry)) continue;
        out.push(full);
      }
    };
    for (const pkg of PACKAGES) walk(join(REPO, 'packages', pkg, 'src'));
    return out;
  };

  /** Prose that documents the ban is not a use of it. */
  const isComment = (line: string): boolean => {
    const t = line.trim();
    return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
  };

  it('has at least the whole source tree to check', () => {
    // A guard that silently scans nothing passes forever.
    expect(sourceFiles().length).toBeGreaterThan(500);
  });

  it('finds no UTC calendar-day shortcut outside the named exemptions', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const rel = file.slice(REPO.length + 1);
      if (EXEMPT_FILES.has(rel)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (isComment(line) || !BANNED.test(line)) return;
        offenders.push(`${rel}:${i + 1}\n      ${line.trim().slice(0, 120)}`);
      });
    }

    // Listed in full on failure: each offender is a file:line plus the offending source.
    expect(offenders).toEqual([]);
  });

  it('keeps every exemption justified', () => {
    for (const { file, why } of EXEMPT) {
      // An exemption for a file that no longer offends is stale and should be deleted.
      const body = readFileSync(join(REPO, file), 'utf8');
      const offends = body.split('\n').some((l) => !isComment(l) && BANNED.test(l));
      expect({ file, offends, reasonLength: why.length > 40 })
        .toEqual({ file, offends: true, reasonLength: true });
    }
  });
});
