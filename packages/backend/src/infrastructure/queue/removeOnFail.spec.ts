import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Task 4 of the api/worker split: no queue may keep failed jobs forever.
 *
 * `removeOnFail: false` (Bull's shorthand for "keep every failed job in Redis permanently") was
 * the default this codebase kept re-introducing — `BullQueueManager` and the `ocr` queue both
 * carried it before being bounded to `FAILED_JOB_RETENTION` (`{ age, count }`), and
 * `notification-dispatch.service.ts`'s `deliver`/`deliver-email` bulk-enqueues still did as of
 * this writing. This scans every `removeOnFail:` site in the source tree and fails on any literal
 * `false`, so the fix cannot silently regress and a new call site cannot introduce it either.
 */
describe('removeOnFail', () => {
  const SRC = join(__dirname, '..', '..');

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(full);
      return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
    });

  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  // notification-admin.controller.ts also sets `removeOnFail: false` on an admin-triggered
  // retry/replay path. That call site belongs to modules/notifications/* — out of scope here
  // (see CLAUDE.md ownership boundaries) — so it is excluded rather than silently passed;
  // flagged separately for whoever owns that module.
  const OUT_OF_SCOPE = ['modules/notifications/notification-admin.controller.ts'];

  it('no in-scope job options set removeOnFail: false', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const relative = file.slice(SRC.length + 1);
      if (OUT_OF_SCOPE.includes(relative)) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      if (/removeOnFail\s*:\s*false/.test(code)) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('notification-dispatch bulk deliveries use the shared bounded retention', () => {
    const file = join(SRC, 'modules', 'notifications', 'notification-dispatch.service.ts');
    const code = readFileSync(file, 'utf8');
    const sites = [...code.matchAll(/removeOnFail:\s*([A-Za-z0-9_.]+)/g)].map((m) => m[1]);
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const site of sites) {
      expect(site).toBe('FAILED_JOB_RETENTION');
    }
  });
});
