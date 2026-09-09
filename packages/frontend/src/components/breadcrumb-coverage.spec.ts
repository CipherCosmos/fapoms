import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Every page names itself in the header.
 *
 * The header's one job is to say where you are. A route with no entry in `BREADCRUMBS` falls back
 * to the brand text, so the line that should read "Administration / Security & Compliance" reads
 * "FAPOMS" — on an incident register, on a queue of pending destructive-action approvals, and on
 * the list of work that has slipped. Three pages were in that state, and nothing would have said
 * so: the fallback is silent by design, which is right for the brand and wrong for a missing page.
 *
 * This reads both files rather than importing them. `BREADCRUMBS` is private to Header.tsx and
 * should stay that way — exporting it only so a test could see it would make an internal table
 * part of the component's surface — and App.tsx cannot be imported at all under jest's CommonJS
 * transform, because it pulls in Login.tsx and its `import.meta`.
 */

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), 'utf8');

const app = read('..', 'App.tsx');
const header = read('Header.tsx');

/** The prefixes the header knows about. */
const crumbs = [...header.matchAll(/prefix:\s*'([^']+)'/g)].map((m) => m[1]);

/**
 * Routes that render a page, as opposed to bouncing somewhere else.
 *
 * A `<Route>` whose element is `<Navigate>` is a redirect kept alive for old links; it never draws
 * a header, so it needs no breadcrumb. Same for the catch-all and for anything parameterised — a
 * deep link like `/assayers/:id` hands off to the page it redirects into.
 */
const pageRoutes = [...app.matchAll(/<Route\s+path="([^"]+)"\s+element=\{<(\w+)/g)]
  .filter(([, path, element]) =>
    path.startsWith('/')
    && !path.includes(':')
    && element !== 'Navigate'
    && path !== '/login',
  )
  .map(([, path]) => path);

describe('the header can name every page', () => {
  it('found routes and breadcrumbs to compare', () => {
    // If either regex stops matching — the files are reformatted, the table is renamed — this
    // suite would pass by comparing two empty lists and prove nothing.
    expect(pageRoutes.length).toBeGreaterThan(15);
    expect(crumbs.length).toBeGreaterThan(15);
  });

  it.each(pageRoutes)('%s has a breadcrumb rather than falling back to the brand text', (path) => {
    const covered = crumbs.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
    expect(covered).toBe(true);
  });
});
