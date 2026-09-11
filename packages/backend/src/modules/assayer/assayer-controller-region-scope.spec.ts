import * as fs from 'fs';
import * as path from 'path';

/**
 * Region-scope fitness test for `assayer.controller.ts`.
 *
 * Found 2026-09-05: 19 of 23 routes that read or write one assayer by id had no region check at
 * all — including `resetAssayerPassword` and `issueAppAccess` — so a region-scoped account could
 * act on any assayer nationwide by UUID alone. `RegionGuardService` is deliberately "a service
 * the handler calls, not an `APP_GUARD`" (see its own file), which is exactly what let this many
 * routes go unguarded one at a time without anything failing. This is the third time this
 * session an identically-shaped gap turned up in a different controller (platform-settings,
 * planning.controller, now this one) — a fix that is only ever applied by hand to the routes
 * someone happened to look at is not a fix that stays fixed. This test reads the controller's own
 * source and fails if a NEW route shaped like the ones that were missing it ships without the
 * guard, rather than relying on the next person noticing.
 *
 * Static text analysis, not a NestJS test module — same technique as
 * `../planning/planning-architecture.spec.ts` — because what is being asserted is a property of
 * the source (every matching handler's body contains the guard call), not of runtime behaviour
 * another kind of test would have to construct a request to observe.
 */
describe('AssayerController region-scope fitness test', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'assayer.controller.ts'), 'utf8');
  /**
   * Comments stripped before any of the analysis below runs. Several doc comments in this file
   * explain Nest's route-declaration-order rule by naming a sibling route verbatim — e.g.
   * "declared above `@Get(':id')` deliberately" — which is real, correct prose about a route
   * that takes only a sub-resource id, not a second occurrence of an assayer-id route. Matching
   * against the raw text found exactly that: two false positives, both a decorator-shaped
   * mention inside a comment rather than a real decorator. Blanking comments first (not removing
   * lines, so character offsets stay usable for the brace/paren scanners below) means only real
   * code can match `ASSAYER_ID_ROUTE`.
   */
  const content = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

  /**
   * The index just after the `}` that closes a handler's own body, given the index of its
   * `async` keyword.
   *
   * The naive version of this — find the first `{` after `async`, then depth-count from there —
   * breaks the moment a parameter default constructs an object literal before the parameter
   * list's own closing paren: `async f(@Query('limit', new ParseLimitPipe({ default: 20 })) …)`
   * has a `{` inside `ParseLimitPipe(...)` that is not the method body's brace at all, and the
   * naive scan matches IT instead, returning a position still inside the signature. So the
   * parameter list is skipped first, paren-depth-aware for the same reason, and only the first
   * `{` after ITS closing `)` is taken as the body's own opening brace.
   */
  function bodyEndAfter(asyncKeywordIndex: number): number {
    const openParen = content.indexOf('(', asyncKeywordIndex);
    let parenDepth = 0;
    let paramListEnd = openParen;
    for (; paramListEnd < content.length; paramListEnd++) {
      if (content[paramListEnd] === '(') parenDepth++;
      else if (content[paramListEnd] === ')') {
        parenDepth -= 1;
        if (parenDepth === 0) break;
      }
    }

    const openBrace = content.indexOf('{', paramListEnd + 1);
    let depth = 0;
    for (let i = openBrace; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    throw new Error('Unbalanced braces while scanning assayer.controller.ts — fitness test cannot parse it.');
  }

  /**
   * One block per handler, spanning exactly its own decorators through its own closing brace:
   * from the end of the PREVIOUS handler's body (found by matching braces from ITS `async`
   * keyword, not by guessing a text window) to the end of THIS handler's own body (same
   * technique, from this one's `async` keyword). A naive slice between consecutive `\n  async`
   * matches instead pairs each handler's body with the NEXT handler's decorators — which failed
   * this test's own dry run by reporting real, guarded routes as unguarded once their decorators
   * had been silently reassigned to their neighbour.
   */
  const methodStarts = [...content.matchAll(/\n {2}async (\w+)\(/g)];
  const blocks = methodStarts.map((m, i) => ({
    name: m[1],
    text: content.slice(i === 0 ? 0 : bodyEndAfter(methodStarts[i - 1].index!), bodyEndAfter(m.index!)),
  }));

  /**
   * A route path that names the assayer directly: `:assayerId` anywhere, or a `:id` in the FIRST
   * segment. On this controller a leading `:id` is always the assayer — `:id`, `:id/lifecycle`,
   * `:id/sensitive/:field`, `:id/payables`, `:id/base-location`, `:id/live`,
   * `:id/recovery/…` — because the routes that predate the `assayerId` naming convention put the
   * person first and everything since puts a noun first.
   *
   * This used to name `:id` and `:id/lifecycle` as the two historical exceptions, literally, and
   * so matched only those two: `:id/base-location`, `:id/live-location`, `:id/location-pings`,
   * `:id/live`, `:id/payables`, `:id/sensitive/:field` and the three `:id/recovery/…` routes
   * were invisible to this file — nine routes, including the one that hands over a bank account
   * number. Position is the rule that was always meant; spelling out two instances of it is what
   * made the rest unexamined.
   */
  const ASSAYER_ID_ROUTE = /@(?:Get|Post|Put|Delete|Patch)\(\s*['"`](?:[^'"`]*:assayerId[^'"`]*|:id(?:\/[^'"`]*)?)['"`]/;

  /**
   * A route keyed on a SUB-RESOURCE id: `:id` somewhere other than the first path segment, and
   * no `:assayerId` anywhere. `commercial/:id`, `reference/:id/checked`,
   * `qualification/override/:id`, `document/:id/file/:index`,
   * `roster/import-issues/:id/resolve` — in every one of them the `:id` is a child row's own id
   * and the assayer is reached by a join the handler cannot see. Position is what tells the two
   * apart, and it is a property of the route string: `:id/live` is the assayer's, `commercial/
   * :id` is not.
   *
   * These used to be a hand-written set of nine method names called KNOWN_SUB_RESOURCE_GAP,
   * recorded as an accepted gap because closing them needed a join-based guard per child table
   * and none existed. All nine were closed on 2026-09-11, along with seven more, once
   * `RegionGuardService` grew those guards. The set is not shortened here, it is deleted: a list
   * of names somebody maintains by hand is the same instrument that let nineteen of twenty-three
   * routes go unguarded in the first place, and a route added next month under
   * `background-check/:id` would inherit the exemption by never being written down. Derived from
   * the route strings, it cannot.
   */
  const SUB_RESOURCE_ROUTE =
    /@(?:Get|Post|Put|Delete|Patch)\(\s*['"`](?![^'"`]*:assayerId)[^'"`]*[A-Za-z0-9-]\/:id(?:\/[^'"`]*)?['"`]/;

  const assayerIdRoutes = blocks.filter((b) => ASSAYER_ID_ROUTE.test(b.text));
  const subResourceRoutes = blocks.filter((b) => SUB_RESOURCE_ROUTE.test(b.text));

  // A canary for the fitness test itself: if either of these drops, a regex above has stopped
  // matching real routes (a decorator style changed) rather than the app having gotten safer,
  // and the per-route assertions below would be silently checking nothing. 34 and 12 are what
  // the controller declares today; the floors are the counts themselves rather than a round
  // number below them, because a route disappearing from a scan is the failure being guarded
  // against and a slack floor is how it goes unnoticed.
  it('finds the assayer-id-shaped routes it expects to find', () => {
    expect(assayerIdRoutes.length).toBeGreaterThanOrEqual(34);
  });

  it('finds the sub-resource-keyed routes it expects to find', () => {
    expect(subResourceRoutes.length).toBeGreaterThanOrEqual(12);
  });

  for (const block of assayerIdRoutes) {
    it(`${block.name} checks the caller's region against the assayer's`, () => {
      expect(block.text).toMatch(/regionGuard\.assertAssayerInScope/);
    });
  }

  for (const block of subResourceRoutes) {
    it(`${block.name} reaches the assayer's region through its child row`, () => {
      // Some join-based guard, not a named one: which of them is right depends on which table
      // the `:id` belongs to, and that is not readable from the route string. What IS readable
      // is that it must not be `assertAssayerInScope` — passing a child row's id to a lookup
      // that expects an assayer's would compare a reference id against `assayers.id`, find
      // nothing, and pass. A guard that always passes is worse than none, because the route
      // then reads as guarded.
      expect(block.text).toMatch(/regionGuard\.assert[A-Za-z]+InScope/);
      expect(block.text).not.toMatch(/regionGuard\.assertAssayerInScope/);
      // And the scope it asserts against has to arrive. Every guard returns on its first line
      // when `scope` is undefined, so the call without the parameter refuses nothing at all.
      expect(block.text).toMatch(/GlobalScopeFilter/);
    });
  }
});
