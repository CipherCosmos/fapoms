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
   * A route path that names the assayer directly: `:assayerId` anywhere in the path, or one of
   * the two historical `:id`-named exceptions (`findOne`'s bare `:id`, and `transitionLifecycle`'s
   * `:id/lifecycle` — both predate the `assayerId` naming convention). Deliberately NOT a bare
   * `:id` match on its own: `commercial/:id`, `reference/:id`, `workforce-attribute/:id` and
   * friends all use `:id` for a SUB-RESOURCE id, not the assayer's, and need a different,
   * join-based check this test does not ask for — see the allowlist below.
   */
  const ASSAYER_ID_ROUTE = /@(?:Get|Post|Put|Delete|Patch)\(\s*['"`](?:[^'"`]*:assayerId[^'"`]*|:id|:id\/lifecycle)['"`]/;

  /**
   * Routes that reach an assayer only through a SUB-RESOURCE id (a reference, empanelment,
   * workforce-attribute, commercial-profile, score-override or document id) are a real, currently
   * accepted gap, not an oversight this test is failing to notice: fixing them needs a new
   * join-based guard method per sub-resource type (mirroring `assertAssignmentInScope`'s
   * sub-resource → owner → region shape), which is follow-up work, not this fix. Named here so
   * growing this list is a decision someone makes on purpose, in a code review, rather than a
   * route silently staying unguarded because nobody's route path happened to say `:assayerId`.
   */
  const KNOWN_SUB_RESOURCE_GAP = new Set([
    'markReferenceChecked', 'removeReference', 'removeEmpanelment',
    'updateWorkforceAttribute', 'removeWorkforceAttribute', 'updateCommercial',
    'clearScoreOverride', 'removeDocumentFile', 'verifyDocument',
  ]);

  const assayerIdRoutes = blocks.filter((b) => ASSAYER_ID_ROUTE.test(b.text));

  // A canary for the fitness test itself: if this drops much below 23, the regex above has
  // stopped matching real routes (a decorator style changed) rather than the app having gotten
  // safer, and the per-route assertions below would be silently checking nothing.
  it('finds the assayer-id-shaped routes it expects to find', () => {
    expect(assayerIdRoutes.length).toBeGreaterThanOrEqual(23);
  });

  for (const block of assayerIdRoutes) {
    if (KNOWN_SUB_RESOURCE_GAP.has(block.name)) continue;
    it(`${block.name} checks the caller's region against the assayer's`, () => {
      expect(block.text).toMatch(/regionGuard\.assertAssayerInScope/);
    });
  }

  /**
   * The allowlist itself must name only what it needs to. A method removed from the controller,
   * or renamed, leaves a dead entry here that looks like an active exemption to the next reader —
   * this fails loudly instead, so the list is trimmed as part of whatever change made it stale.
   */
  it('does not allowlist a method that no longer exists', () => {
    const blockNames = new Set(blocks.map((b) => b.name));
    const stale = [...KNOWN_SUB_RESOURCE_GAP].filter((name) => !blockNames.has(name));
    expect(stale).toEqual([]);
  });
});
