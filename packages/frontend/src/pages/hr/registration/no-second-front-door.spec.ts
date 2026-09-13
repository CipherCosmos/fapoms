import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * One way onto the roster, and this is what keeps it that way.
 *
 * `POST /assayers` creates a person. The registration wizard used to call it — a seven-step form
 * wrote a live row after step one, with no interview, no application and no review, and it was
 * what the roster's "Add assayer" button opened. That made the bypass the path everybody found
 * and made the rest of the pipeline look optional, which is the complaint this work came from.
 *
 * The route still exists: it carries the duplicate checks, the code allocation and the role guard,
 * and the tenant-isolation suite uses it as its create-through-the-API probe. What must not come
 * back is a SCREEN on it. A person becomes real when an application is approved, and in no other
 * way — `approve()` is the only caller of `AssayerService.create` left.
 *
 * Nothing else can notice this. A new create call compiles, passes every other test, and quietly
 * restores a second front door.
 */

const SRC = join(__dirname, '..', '..', '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.spec\.tsx?$/.test(entry) ? [full] : [];
  });

/**
 * A create against the roster: `api.request('/assayers', { method: 'POST' })` in any of the shapes
 * this codebase writes it, across one line or several.
 *
 * Matched on the pair rather than on the URL alone, because `GET /assayers` is the roster itself
 * and is called from a dozen places that are none of this file's business.
 */
const CREATE_CALL = /api\.request[^;]*?['"`]\/assayers['"`][\s\S]{0,200}?method:\s*['"`]POST['"`]/;

describe('the roster has one front door', () => {
  const sources = walk(SRC).map((file) => ({
    path: relative(SRC, file),
    text: readFileSync(file, 'utf8'),
  }));

  it('is reading the whole app, so this cannot pass by scanning nothing', () => {
    expect(sources.length).toBeGreaterThan(150);
  });

  it('recognises the call it exists to forbid', () => {
    // A canary for the regex itself: a pattern that stopped matching would make every assertion
    // below vacuous, and the failure would look exactly like success.
    const shape = `await api.request('/assayers', { method: 'POST', body: JSON.stringify(x) });`;
    expect(CREATE_CALL.test(shape)).toBe(true);
    const multiline = `api.request<Assayer>('/assayers', {\n  method: 'POST',\n  body,\n});`;
    expect(CREATE_CALL.test(multiline)).toBe(true);
    // And does not fire on the roster read, which is a different request entirely.
    expect(CREATE_CALL.test(`api.request('/assayers', { method: 'GET' })`)).toBe(false);
  });

  it('and no screen in the app makes one', () => {
    // Named rather than counted: a failure should print the file that reopened the door.
    const offenders = sources
      .filter(({ text }) => CREATE_CALL.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});
