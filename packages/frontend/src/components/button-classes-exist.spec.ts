import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Every button class the markup asks for has to exist in the stylesheet.
 *
 * `.btn-ghost`, `.btn-icon`, `.btn-sm` and `.btn-danger` were written in JSX across the app and
 * defined nowhere, so eighteen buttons rendered in a state nobody chose — a ghost button with no
 * background, a "small" button at full size, an icon button with no styling at all, and a
 * destructive action that looked exactly like a neutral one. Nothing failed, nothing warned, and
 * the only symptom was that the app looked unfinished.
 *
 * CSS does not error on an unknown class, so this is the only place that can notice.
 */

const SRC = join(__dirname, '..');
const STYLESHEET = join(SRC, 'index.css');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.spec\.tsx?$/.test(entry) ? [full] : [];
  });

describe('button classes', () => {
  const css = readFileSync(STYLESHEET, 'utf8');
  const used = new Set<string>();

  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8');
    /*
      `className="btn btn-primary"` and the template-literal forms both reduce to words here.
      The lookbehind skips `--btn-bg` and `--btn-text`, which are theme custom properties rather
      than classes — a hyphen in front means it is a variable, not something to look up in the
      stylesheet as a selector.
    */
    for (const match of source.matchAll(/(?<!-)\bbtn-[a-z0-9-]+/g)) used.add(match[0]);
  }

  it('finds the ones the app actually uses', () => {
    // A guard that matched nothing would pass forever. This is the canary.
    expect(used.size).toBeGreaterThan(3);
  });

  it.each([...used].sort().map((c) => [c]))('.%s is defined in index.css', (cls) => {
    expect(css).toContain(`.${cls}`);
  });
});
