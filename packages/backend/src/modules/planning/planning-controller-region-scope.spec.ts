import * as fs from 'fs';
import * as path from 'path';

/**
 * Region-scope fitness test for `planning.controller.ts`.
 *
 * Found 2026-09-04: 10 of ~19 routes that read or act on a project, coverage plan, or several
 * branches at once carried no `@GlobalScopeFilter()` parameter at all — `optimize`,
 * `scenarios/simulate`, all four day-plan routes, and the coverage-plan create/transition/
 * execute path — so a region-scoped account could plan, optimise or DEPLOY assignments (creating
 * real assignment rows) across every region by project or plan id alone. Same shape of gap as
 * `assayer-controller-region-scope.spec.ts` (read that file's own comment for the general
 * argument for why this needs a standing test, not just a one-time fix), adapted here because
 * this controller mixes two legitimate patterns rather than one: some routes call
 * `regionGuard.assert*InScope` directly, others hand `scope` down into an engine/service that
 * narrows or refuses internally (`getProjectCoveragePlan` → `CoveragePlanningEngine
 * .generateCoveragePlan`, for one). This test enforces the strong check (a direct call) on the
 * routes proven to use it, and the weaker but still real check — `scope` is at least sourced via
 * `@GlobalScopeFilter()`, so it is not simply absent the way the original bug left it — everywhere
 * else a project/plan id appears in the route path.
 */
describe('PlanningController region-scope fitness test', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'planning.controller.ts'), 'utf8');
  // See the sibling assayer-controller fitness test for why comments are blanked (not deleted,
  // so brace/paren offsets stay valid) before any of this runs — this file has the same
  // "a doc comment names a decorator verbatim" shape that produced false positives there.
  const content = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

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
    throw new Error('Unbalanced braces while scanning planning.controller.ts — fitness test cannot parse it.');
  }

  const methodStarts = [...content.matchAll(/\n {2}async (\w+)\(/g)];
  const blocks = methodStarts.map((m, i) => ({
    name: m[1],
    text: content.slice(i === 0 ? 0 : bodyEndAfter(methodStarts[i - 1].index!), bodyEndAfter(m.index!)),
  }));

  /** A route path naming a project, a coverage plan, or a branch directly. */
  const SCOPE_RELEVANT_ROUTE = /@(?:Get|Post|Put|Delete|Patch)\(\s*['"`][^'"`]*:(?:projectId|planId|branchId)[^'"`]*['"`]/;
  // `getMultiProjectDayPlans`/`queueMultiProjectDayPlans` take a comma-separated `projectIds`
  // query param instead of a path param, so the route-path regex above cannot see them.
  const QUERY_PARAM_ROUTES = new Set(['getMultiProjectDayPlans', 'queueMultiProjectDayPlans']);

  /**
   * Routes proven to enforce scope with a direct `regionGuard.assert*InScope` call — held to the
   * strong check. Growing this list to include a route that doesn't actually call the guard would
   * be caught by the assertion itself; shrinking it silently (removing a route that used to be
   * here) is exactly the regression this file exists to catch, so removals should read as
   * deliberate in review, not as a stray line dropped from a list.
   */
  const DIRECT_CALL_ROUTES = new Set([
    'getProjectCoverage', 'createOrRegeneratePlan', 'transitionPlan', 'executePlan',
    'optimizeProjectDeployment', 'simulateScenario', 'suggestAuditDate', 'getRecommendations',
    'getMultiProjectDayPlans', 'queueMultiProjectDayPlans', 'getDayPlans', 'queueDayPlans',
  ]);

  /**
   * Routes that source `scope` via `@GlobalScopeFilter()` and hand it to an engine/service
   * trusted to narrow or refuse internally, rather than asserting in the controller itself. Named
   * explicitly rather than inferred, because "does the callee actually use scope correctly" is
   * exactly what a text-only fitness test cannot check — that trust is a human decision, recorded
   * here so it is visible and reviewable, not because the test verified it.
   */
  const DELEGATES_TO_SERVICE = new Set([
    'getProjectCoveragePlan', 'queueProjectCoveragePlan', 'getProjectCandidates',
    'queueProjectCandidates', 'commandCenter',
  ]);

  // The path regex is a safety net for a route nobody has classified yet, not the sole source of
  // truth: `suggestAuditDate`/`getRecommendations` take `branchId` as a QUERY param, and
  // `simulateScenario` takes `projectId` on its request body — neither appears in the route path
  // a decorator declares, so the regex alone would silently drop three routes this session
  // already reviewed and fixed. The two curated sets below are reviewed, actual knowledge; a
  // route named in either is scope-relevant regardless of what its path string looks like.
  const scopeRelevantRoutes = blocks.filter(
    (b) => SCOPE_RELEVANT_ROUTE.test(b.text) || QUERY_PARAM_ROUTES.has(b.name)
      || DIRECT_CALL_ROUTES.has(b.name) || DELEGATES_TO_SERVICE.has(b.name),
  );

  it('finds the project/plan/branch routes it expects to find', () => {
    expect(scopeRelevantRoutes.length).toBeGreaterThanOrEqual(17);
  });

  for (const block of scopeRelevantRoutes) {
    if (DIRECT_CALL_ROUTES.has(block.name)) {
      it(`${block.name} calls regionGuard directly`, () => {
        expect(block.text).toMatch(/regionGuard\.assert(?:Project(?:s)?InScope|CoveragePlanInScope|BranchInScope)/);
      });
    } else if (DELEGATES_TO_SERVICE.has(block.name)) {
      it(`${block.name} at least sources a scope to hand to its (trusted) service`, () => {
        expect(block.text).toMatch(/@GlobalScopeFilter\(\)/);
      });
    } else {
      // A project/plan/branch route that is in NEITHER reviewed list — a new route, or one
      // renamed since the lists above were written. Fails on purpose: the two patterns above are
      // both fine, but only because a human decided which one applies here; defaulting either
      // way for an unrecognised route would be exactly the silent gap this file exists to close.
      it(`${block.name} must be added to DIRECT_CALL_ROUTES or DELEGATES_TO_SERVICE above`, () => {
        expect(`${block.name} is unclassified`).toBe('add it to one of the two lists, having checked which applies');
      });
    }
  }

  it('does not list a route in both the direct-call and delegate sets', () => {
    const overlap = [...DIRECT_CALL_ROUTES].filter((n) => DELEGATES_TO_SERVICE.has(n));
    expect(overlap).toEqual([]);
  });

  it('does not allowlist a method that no longer exists', () => {
    const blockNames = new Set(blocks.map((b) => b.name));
    const stale = [...DIRECT_CALL_ROUTES, ...DELEGATES_TO_SERVICE].filter((name) => !blockNames.has(name));
    expect(stale).toEqual([]);
  });
});
