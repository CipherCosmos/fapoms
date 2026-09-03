import * as fs from 'fs';
import * as path from 'path';

/**
 * Every route open to a registration-only session is scoped to that person's own record.
 *
 * The four joining stages can sign in so an assayer can finish registering from a phone. They have
 * not been vetted — background verification is one of those stages — so the session is confined by
 * `JwtAuthGuard` to routes carrying `@OnboardingAllowed()`. That decorator is the entire boundary.
 *
 * Deny-by-default protects against a route nobody thought about. It does NOT protect against a
 * route somebody thought about and marked, without noticing that its `:assayerId` parameter is
 * supplied by the caller. Marking a route is one line; the self-check is a different line
 * somewhere else in the handler, and adding the first while forgetting the second is the whole
 * failure mode. That is what this asserts.
 *
 * Written as a source scan for the same reason as the soft-delete guard: the fault is a *missing*
 * call in one handler among many near-identical ones, which reads fine and greps badly.
 */

const FILES = [
  path.join(__dirname, '..', 'assayer', 'assayer.controller.ts'),
  path.join(__dirname, '..', 'assayer', 'assayer-self-service.controller.ts'),
  path.join(__dirname, 'auth.controller.ts'),
];

/** A route decorator line — where one handler's text ends and the next begins. */
const ROUTE_DECORATOR = /^\s*@(Get|Post|Put|Patch|Delete)\(/;

interface Route { file: string; line: number; route: string; body: string }

/**
 * Each onboarding-allowed handler, sliced from its own route decorator to the START of the next
 * one — never a fixed window.
 *
 * A fixed lookahead is how a sibling guard came to read its neighbours' text and pass 8 queries
 * that carried no guard of their own. Slicing on the next route decorator means a handler is
 * judged on its own body and nothing else.
 */
function onboardingRoutes(): Route[] {
  const found: Route[] = [];

  for (const file of FILES) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*@OnboardingAllowed\(\)/.test(lines[i])) continue;

      // The route decorator sits immediately above or below the marker; find the nearest one up.
      let start = i;
      while (start > 0 && !ROUTE_DECORATOR.test(lines[start])) start -= 1;

      let end = start + 1;
      while (end < lines.length && !ROUTE_DECORATOR.test(lines[end])) end += 1;

      found.push({
        file: path.basename(file),
        line: start + 1,
        route: lines[start].trim(),
        body: codeOnly(lines.slice(start, end)),
      });
    }
  }
  return found;
}

/**
 * The handler's code with its comments removed.
 *
 * Written after this suite failed to notice a real self-check being deleted: the docblock above
 * that handler says "still authenticated and self-scoped (`assertSelfOrPrivileged` below)", and
 * the scan was matching those words. So the guard read a sentence *describing* the control as
 * proof the control was there, and would have gone on passing after somebody removed it — the
 * exact failure this file exists to prevent, one level up.
 *
 * Line-based rather than a real parser: every comment in this codebase sits on its own line in
 * these files, and a scan that quietly mis-parses is worse than one whose limits are stated.
 */
function codeOnly(lines: string[]): string {
  return lines
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('routes open to a registration-only session', () => {
  it('finds the routes to check', () => {
    // Guards the guard: a restructure that made the scan find nothing would otherwise pass by
    // vacuously checking an empty list.
    expect(onboardingRoutes().length).toBeGreaterThanOrEqual(8);
  });

  it('every one of them is scoped to the caller, not to a caller-supplied id', () => {
    const unscoped = onboardingRoutes()
      .filter(({ route, body }) => {
        // A route that takes no id acts on `req.user.id` by construction — `me/change-password`
        // and `logout`. There is no other record it could reach.
        const takesAnId = /:(id|assayerId)\b/.test(route);
        if (!takesAnId) return false;

        // Either the shared helper, or an explicit comparison against the session's own id.
        return !/assertSelfOrPrivileged/.test(body)
          && !/req\.user\??\.id !== /.test(body);
      })
      .map(({ file, line, route }) => `${file}:${line} ${route}`);

    expect(unscoped).toEqual([]);
  });

  /**
   * The decorator must not be applied at class level, which would open every route on a
   * controller at once — including ones added later by somebody who never saw this decision.
   */
  it('is never applied to a whole controller', () => {
    for (const file of FILES) {
      const source = fs.readFileSync(file, 'utf8');
      const beforeClass = source.slice(0, source.search(/^export class /m));
      expect(beforeClass).not.toMatch(/@OnboardingAllowed\(\)/);
    }
  });
});
