import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Every size in the app comes off the scale.
 *
 * `index.css` has defined a ten-step type scale since the beginning, and before this guard was
 * written thirteen call sites used it. The other 2,487 hard-coded a number, across twenty-five
 * distinct sizes — including six that exist on no scale anywhere: 9.5, 10.5, 11.5, 12.5, 13.5 and
 * 14.5px, together 568 uses. A half-pixel difference is not a decision anybody can see or defend;
 * it is what happens when a screen is nudged until it looks right in isolation. Put two such
 * screens side by side and the app reads as unfinished, which was the complaint.
 *
 * Nothing enforces this but this file: a font size is never wrong enough to throw.
 *
 * The rule is deliberately absolute — no numeric literal reaches `fontSize` at all — because a
 * threshold ("close enough to the scale") is the same argument that produced 12.5px.
 */

const SRC = join(__dirname, '..');
const STYLESHEET = join(SRC, 'index.css');

/**
 * Documents that leave this app and are rendered by something else.
 *
 * A print window is its own document and never sees `:root`, so `var(--text-xs)` would resolve to
 * nothing there and the sheet would fall back to the browser default. An email is the same
 * argument carried further: it is rendered by Gmail, Outlook and a dozen phone clients, none of
 * which has this stylesheet — and several of which strip `<style>` entirely, which is why email
 * HTML carries its sizes inline as literal pixels.
 *
 * Each entry is a file that produces a foreign document and nothing else. That is the test for
 * belonging here: `email-template-html.ts` was split out of the admin screen precisely so the
 * exemption covers the email and not the screen around it.
 */
const OFF_SCALE_BY_DESIGN = [
  'pages/hr/assayerProfilePrint.ts',
  'pages/billing/invoicePrint.ts',
  'pages/admin/email-template-html.ts',
];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.spec\.tsx?$/.test(entry) ? [full] : [];
  });

const sources = walk(SRC).map((file) => ({
  path: relative(SRC, file),
  text: readFileSync(file, 'utf8'),
}));

describe('type scale', () => {
  const css = readFileSync(STYLESHEET, 'utf8');

  /*
    The scale itself. Ten steps and no more: the point of a scale is that the next screen has to
    pick one of these rather than invent the size between two of them, so adding an eleventh is a
    decision that should require editing this number and saying why.
  */
  it('has ten steps and no more', () => {
    const steps = [...css.matchAll(/^\s*--text-([a-z0-9]+): *([0-9.]+)rem;/gm)].map((m) => m[1]);
    expect(steps).toEqual(['3xs', '2xs', 'xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl', '3xl']);
  });

  /*
    Sizes and colours share the `--text-` prefix (`--text-xs` is a size, `--text-muted` a colour),
    so this asks the weaker but self-maintaining question: is the token declared at all. Listing
    which names are colours would be a list that goes stale the day somebody adds one.
  */
  it('every --text-* a component asks for is declared', () => {
    const declared = new Set([...css.matchAll(/--text-([a-z0-9-]+):/g)].map((m) => m[1]));
    const asked = new Set<string>();
    for (const { text } of sources) {
      for (const m of text.matchAll(/var\(--text-([a-z0-9-]+)[,)]/g)) asked.add(m[1]);
    }
    expect([...asked].filter((n) => !declared.has(n)).sort()).toEqual([]);
    // Canary: a regex that stopped matching would make this test vacuous.
    expect(asked.size).toBeGreaterThan(5);
  });

  it.each(sources.map((s) => [s.path, s.text]))('%s sets no font size of its own', (path, text) => {
    if (OFF_SCALE_BY_DESIGN.includes(path as string)) return;

    const offenders = [
      // fontSize: '12.5px' / fontSize: 12.5 / fontSize: '0.8rem'
      ...(text as string).matchAll(/fontSize: *'?[0-9][0-9.]*(px|rem|em)?'?/g),
      // font-size: 12.5px inside a CSS string
      ...(text as string).matchAll(/font-size: *[0-9][0-9.]*(px|rem|em)/g),
    ].map((m) => m[0]);

    expect(offenders).toEqual([]);
  });
});
