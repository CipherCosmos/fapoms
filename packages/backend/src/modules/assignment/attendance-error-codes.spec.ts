import { readFileSync } from 'fs';
import { join } from 'path';
import * as shared from '@fapoms/shared';

/**
 * Check-in and check-out refuse with HTTP 200 `{ success: false, error, message }` — a shape
 * installed apps read, so it stays. What changed is where the `error` value comes from: every one
 * was a bare string literal (`'NOT_SCHEDULED_TODAY'`, `'TOO_FAR_FROM_BRANCH'`, …) that existed
 * nowhere in `@fapoms/shared`, so the app could not name them from the shared list and a typo on
 * either side would have gone unnoticed. They are now constants from the shared catalogue.
 *
 * Read from source rather than by driving the transaction, because the property is "no literal
 * anywhere in these two methods", which one path through them cannot show.
 */
describe('check-in / check-out refusal codes come from the shared catalogue', () => {
  const source = readFileSync(join(__dirname, 'assignment.service.ts'), 'utf8');

  const body = (name: string): string => {
    const start = source.indexOf(`  async ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = source.indexOf('\n  async ', start + 10);
    return source.slice(start, next === -1 ? undefined : next);
  };

  it.each(['recordCheckIn', 'recordCheckOut'])('%s has no string-literal error code', (name) => {
    const text = body(name);
    expect(text).toMatch(/error: [A-Z_]+_ERROR_CODES\.[A-Z_]+/);
    expect(text).not.toMatch(/error:\s*['"`]/);
  });

  it.each(['recordCheckIn', 'recordCheckOut'])('%s names only codes the shared catalogue exports', (name) => {
    const refs = [...body(name).matchAll(/error: ([A-Z_]+_ERROR_CODES)\.([A-Z_]+)/g)];
    expect(refs.length).toBeGreaterThan(5);
    for (const [, group, code] of refs) {
      const catalogue = (shared as unknown as Record<string, Record<string, string>>)[group];
      expect(catalogue).toBeDefined();
      // Wire value unchanged: the constant's value is the literal the app already compares against.
      expect(catalogue[code]).toBe(code);
      expect(shared.isApiErrorCode(code)).toBe(true);
    }
  });

  it('keeps the two refusals the audit named, with their original wire values', () => {
    expect(shared.ATTENDANCE_ERROR_CODES.NOT_SCHEDULED_TODAY).toBe('NOT_SCHEDULED_TODAY');
    expect(shared.ATTENDANCE_ERROR_CODES.TOO_FAR_FROM_BRANCH).toBe('TOO_FAR_FROM_BRANCH');
    // Both refusals are now decided by the capability evaluators the field app's list is built
    // from (assignment-capabilities.ts) and passed through by the route as `error: <gate>.code`.
    const evaluators = readFileSync(join(__dirname, 'assignment-capabilities.ts'), 'utf8');
    expect(evaluators).toContain('ATTENDANCE_ERROR_CODES.NOT_SCHEDULED_TODAY');
    expect(evaluators).toContain('ATTENDANCE_ERROR_CODES.TOO_FAR_FROM_BRANCH');
    expect(body('recordCheckIn')).toContain('evaluateCheckInDay(');
    expect(body('recordCheckIn')).toContain('evaluateCheckInPosition(');
  });
});
