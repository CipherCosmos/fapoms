import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * The shell pads and centres the content. No page does it again.
 *
 * `Layout.tsx` wraps every screen in a scrolling region with `--content-pad` of padding and a
 * container capped at `--content-max-width` and centred. On top of that, about a third of the
 * pages set a root padding of their own — 0, 16px, 24px, `20px 24px`, `0 8px 16px` — and six set
 * a second max width with its own `margin: 0 auto`: 900, 1000, 1100, 1200, 1500 and, in the
 * registration wizard, 1600 — the shell's own number, written out again one level down. Each was
 * defensible on the screen it was written for; together they are why the left edge of the content
 * moved as you navigated, which is the sort of thing nobody can see one page at a time.
 *
 * `<Page>` decides it now, in one place, and this file keeps it the one place.
 */

const SRC = join(__dirname, '..');
const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');

/**
 * Which files are pages is read from the router itself rather than listed here — a list of
 * screens is exactly the kind of rule that is true on the day it is written and quietly wrong
 * three pages later.
 */
const routed = [...app.matchAll(
  /const (\w+) = React\.lazy\(\(\) => import\('([^']+)'\)/g,
)].map(([, name, file]) => ({
  name,
  path: join(SRC, file.replace(/^\.\//, '') + '.tsx'),
})).filter((r) => existsSync(r.path));

/**
 * Screens that are not inside the shell, so there is no shell padding to double up on: the two
 * sign-in pages render against the bare viewport, and the two link-authorised pages are opened
 * from a phone's browser with no session and no chrome around them.
 */
const OUTSIDE_THE_SHELL = ['Login', 'ForcePasswordChange', 'NotFound', 'PublicRegistration', 'ViewMark'];

describe('page container', () => {
  const css = readFileSync(join(SRC, 'index.css'), 'utf8');
  const layout = readFileSync(join(SRC, 'components/Layout.tsx'), 'utf8');

  it('reads the router, so this cannot quietly stop covering anything', () => {
    expect(routed.length).toBeGreaterThan(30);
  });

  it('the shell owns the padding and the cap', () => {
    expect(css).toContain('.page-scroll');
    expect(css).toContain('.page-container');
    expect(css).toContain('--content-max-width:');
    expect(layout).toContain('className="page-scroll"');
    expect(layout).toContain('className="page-container"');
  });

  it('and states them once — not again, inline, in the markup beside the class', () => {
    // The two numbers this file is about. If either reappears in Layout the stylesheet has
    // stopped being where they live, and the next person will change the one that does nothing.
    expect(layout).not.toMatch(/maxWidth: '1600px'/);
    expect(layout).not.toMatch(/padding: '20px'/);
  });

  it.each(routed.map((r) => [r.name, r.path]))(
    '%s draws its root with <Page>, or delegates to something that does',
    (name, path) => {
      if (OUTSIDE_THE_SHELL.includes(name as string)) return;
      const text = readFileSync(path as string, 'utf8');
      // A page that hands its whole body to one other component — `HrRosterPage` is `<AssayerRoster/>`
      // — has no root of its own to get wrong, and the component it delegates to is covered here
      // in its own right if the router names it.
      const hasOwnRoot = /\n  return \(\n(?:\s*\/\*[\s\S]*?\*\/\n)?    <(div|section|main)\b/.test(text);
      if (!hasOwnRoot) return;
      expect(text).toMatch(/<Page[\s>]/);
    },
  );

  it.each(routed.map((r) => [r.name, r.path]))(
    '%s does not cap and centre a second time',
    (name, path) => {
      if (OUTSIDE_THE_SHELL.includes(name as string)) return;
      const text = readFileSync(path as string, 'utf8');
      /*
        A px max width next to `margin: 0 auto` is an element saying "I am the page". Prose widths
        in `ch`, and the narrow centred paragraph inside a card, are not that and stay allowed —
        the tell is the unit, not a threshold on the number.
      */
      const recentring = [...text.matchAll(/style=\{\{([^}]*)\}\}/g)]
        .map((m) => m[1].replace(/\s+/g, ' '))
        .filter((s) => /maxWidth: '?\d+(px)?'?/.test(s) && /margin(Inline)?: '0 auto'|marginInline: 'auto'/.test(s))
        .filter((s) => /padding|display: 'flex'/.test(s));
      expect(recentring).toEqual([]);
    },
  );
});
