import * as fs from 'fs';
import * as path from 'path';
import { NOTIFICATION_CATALOG } from './notification-catalog';

/**
 * Every notification must link somewhere its recipients can actually go.
 *
 * The catalog decides two things together — who hears about an event, and where clicking it
 * takes them — while the web app's `route-permissions.ts` independently decides who may open
 * that path. Nothing made the two agree, and three entries did not: a "Validation complete"
 * notification sent to the operations desk linked to `/data-entry`, which operations cannot
 * open. `ProtectedRoute` silently redirects to `/dashboard`, so the recipient taps a
 * notification about their own work and lands on a page that says nothing about it, with no
 * error and nothing to explain what happened.
 *
 * The two files live in different packages, so this reads the frontend's source rather than
 * importing it. That is deliberate: a snapshot copied into this package would be a fourth place
 * for the same rule to drift, which is the problem being solved. Parsing the real file means the
 * test cannot be satisfied by a stale duplicate.
 */

const ROUTE_PERMISSIONS_FILE = path.resolve(
  __dirname, '../../../../frontend/src/config/route-permissions.ts',
);

/** `path` → the roles allowed to open it, read out of the frontend's real source. */
function routeRoles(): Map<string, Set<string>> {
  const src = fs.readFileSync(ROUTE_PERMISSIONS_FILE, 'utf8');
  const map = new Map<string, Set<string>>();

  // Each entry is `{ path: '/x', allowedRoles: [SystemRole.A, …] }`, possibly spanning lines
  // and carrying comments between them.
  const entry = /path:\s*'([^']+)',[\s\S]*?allowedRoles:\s*(\[[\s\S]*?\]|Object\.values\(SystemRole\))/g;
  for (let m = entry.exec(src); m; m = entry.exec(src)) {
    const [, routePath, rolesBlob] = m;
    if (rolesBlob.startsWith('Object.values')) {
      map.set(routePath, new Set(['*']));
      continue;
    }
    map.set(routePath, new Set(rolesBlob.match(/SystemRole\.([A-Z_]+)/g)?.map((r) => r.split('.')[1]) ?? []));
  }
  return map;
}

describe('notification links are reachable by the people notified', () => {
  const routes = routeRoles();

  it('parses the frontend route table', () => {
    // Guards the guard: a parse that silently finds nothing would make every assertion vacuous.
    expect(routes.size).toBeGreaterThan(10);
    expect(routes.has('/dashboard')).toBe(true);
  });

  it('never sends someone to a page they will be bounced off', () => {
    const stranded: string[] = [];

    for (const [type, def] of Object.entries(NOTIFICATION_CATALOG) as [string, any][]) {
      const link: string | undefined = def.link ?? def.collapse?.link;
      // Templated links (`/assignments/${id}`) resolve to their base route; links this table
      // does not govern are outside the web app and not this test's business.
      if (!link || !link.startsWith('/')) continue;
      const base = '/' + link.split('/')[1].split('$')[0];
      const allowed = routes.get(base) ?? routes.get(link);
      if (!allowed || allowed.has('*')) continue;

      for (const role of (def.roles ?? []) as string[]) {
        if (!allowed.has(role)) stranded.push(`${type} → ${link} is closed to ${role}`);
      }
    }

    expect(stranded).toEqual([]);
  });
});
