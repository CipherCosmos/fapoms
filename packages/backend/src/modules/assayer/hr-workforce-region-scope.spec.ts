import * as fs from 'fs';
import * as path from 'path';

/**
 * Region-scope fitness test for the HR workforce overview.
 *
 * `/hr/workforce` used to answer for the whole organisation regardless of who asked, while the
 * roster one click away on the same screen was already region-scoped — so a territorial desk's
 * headcount tile and its own roster page could disagree about how many people exist. Fixing the
 * ~20 raw queries `HrWorkforceService` runs is only a fix for as long as it STAYS fixed: this same
 * file has already grown a new panel, and a new query inside an existing one, more than once (see
 * the soft-delete and departed-lifecycle history recorded throughout it), each time without
 * whatever discipline the existing queries had already learned the hard way. This is the
 * region-scoping version of that guard: a new raw query lands here unscoped, silently, unless a
 * human either scopes it or names it on the allowlist below with a reason.
 *
 * Same technique as `assayer-controller-region-scope.spec.ts`: static analysis of the source
 * itself, not a NestJS test module, because the property being asserted — every query calls the
 * shared scope helper — is a fact about the CODE, not runtime behaviour a request would have to be
 * constructed to observe.
 *
 * ## Per query, not per method
 *
 * The first version of this test checked "does this METHOD'S body contain a `scopeSql(` call
 * anywhere" — and a deliberate dry-run mutation (deleting just `deployment()`'s `demandRaw` scope
 * call, leaving `supplyRaw`'s in place two lines below) exposed exactly why that is too coarse:
 * the method-level check kept passing, because the neighbouring query's `scopeSql(` call was still
 * somewhere in the same body. Half the methods in this file run more than one query, so a
 * per-method check would only ever catch the FIRST query in a method losing its scope, not the
 * second. Each query is therefore checked over its own slice of text — from just after the
 * PREVIOUS query's template literal closes, to the end of this query's own template literal — so a
 * neighbour's scoping can never stand in for this query's own.
 */
describe('HrWorkforceService / HrController region-scope fitness test', () => {
  const SERVICE_PATH = path.join(__dirname, 'hr-workforce.service.ts');
  const CONTROLLER_PATH = path.join(__dirname, 'hr.controller.ts');

  /** Comments blanked to spaces (not removed), so line numbers and character offsets stay usable. */
  function stripComments(raw: string): string {
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  }

  const serviceSource = stripComments(fs.readFileSync(SERVICE_PATH, 'utf8'));

  /**
   * One block per class member: from its own declaration line to the line just before the NEXT
   * member's declaration (or end of file, for the last one). Declarations are found by their fixed
   * two-space indent, which nothing inside a method body shares in this file — every local
   * variable, arrow function and SQL template here sits at four spaces or deeper.
   *
   * Unlike `assayer-controller-region-scope.spec.ts`'s `bodyEndAfter`, this does not need to find
   * a member's EXACT closing brace: the checks below only need "everything belonging to this
   * member before the next one starts", and the boundary between declarations is enough to get
   * that right without a brace/paren depth scan — which `credentialsExpiringWithin`'s multi-line
   * return-type annotation (a `Promise<{ ... }[]>` spanning several lines before the body even
   * opens) would otherwise complicate exactly the way a parameter-default object literal
   * complicated it for the controller spec.
   */
  function memberBlocks(source: string): { name: string; text: string }[] {
    const starts = [
      ...source.matchAll(/^ {2}(?:private |public |protected )?(?:static )?(?:async )?([a-zA-Z_]\w*)\(/gm),
    ];
    return starts.map((m, i) => ({
      name: m[1],
      text: source.slice(m.index!, starts[i + 1]?.index ?? source.length),
    }));
  }

  /** The index just past the closing backtick of the template literal starting at or after `from`. */
  function templateLiteralEnd(text: string, from: number): number {
    const open = text.indexOf('`', from);
    const close = text.indexOf('`', open + 1);
    // No SQL template in this file contains a literal backtick, so the next one is always the
    // close — if that ever stops being true, this returns -1 + 1 = 0 and every downstream slice
    // becomes visibly wrong (an empty or whole-file segment) rather than quietly mis-slicing.
    return close + 1;
  }

  /**
   * Each `dataSource.query(` call in this block, as its OWN slice of text: from just past the
   * PREVIOUS call's template literal (or the block's own start, for the first call) through the
   * end of THIS call's template literal. Setup code — a `const xParams = […]` array, a `scopeSql(`
   * call — sits textually between one query and the next in this file's style, so it lands in the
   * slice of the query it was written for, never in its neighbour's.
   */
  function queryCallSlices(blockText: string): string[] {
    const starts = [...blockText.matchAll(/dataSource\.query\(/g)].map((m) => m.index!);
    return starts.map((idx, i) => {
      const from = i === 0 ? 0 : templateLiteralEnd(blockText, starts[i - 1]);
      const to = i === starts.length - 1 ? blockText.length : starts[i + 1];
      return blockText.slice(from, to);
    });
  }

  const blocks = memberBlocks(serviceSource);

  it('finds the class members it expects to find', () => {
    // A canary for the scanner itself: if this drops far below today's count, the regex has
    // stopped matching real declarations (a style change) rather than the file having shrunk.
    expect(blocks.length).toBeGreaterThanOrEqual(18);
  });

  const queryBearing = blocks.filter((b) => b.text.includes('dataSource.query('));

  it('finds the query-bearing methods it expects to find', () => {
    expect(queryBearing.length).toBeGreaterThanOrEqual(10);
  });

  const totalQueryCalls = queryBearing.reduce((n, b) => n + queryCallSlices(b.text).length, 0);

  it('finds the individual query call sites it expects to find', () => {
    // Another canary, at the finer grain the per-query checks below actually run at: if this
    // drops, either queries moved somewhere this scanner cannot see, or the regex broke — either
    // way the per-query assertions would be silently checking nothing.
    expect(totalQueryCalls).toBeGreaterThanOrEqual(25);
  });

  /**
   * Methods that run a raw query with no caller region to apply.
   *
   * `credentialsExpiringWithin` is invoked only by cron-triggered background sweeps
   * (`SlaScannerWorker`'s credential-expiry phase, `EmailDigestService`'s morning digest) — neither
   * call sits behind an HTTP request, so neither has a principal to derive a `GlobalScope` from,
   * and a credential about to lapse needs chasing regardless of which desk happens to have the HR
   * overview open at that moment. Growing this list is a decision made in review, not a query
   * silently staying unscoped because nobody's method body happened to already call `scopeSql(`.
   */
  const REGION_SCOPE_ALLOWLIST = new Set(['credentialsExpiringWithin']);

  for (const block of queryBearing) {
    if (REGION_SCOPE_ALLOWLIST.has(block.name)) continue;
    const slices = queryCallSlices(block.text);
    slices.forEach((slice, i) => {
      it(`${block.name} query #${i + 1} applies the caller's region scope`, () => {
        expect(slice).toMatch(/scopeSql\(/);
      });
    });
  }

  /**
   * The allowlist itself must name only what it needs to. A method removed or renamed leaves a
   * dead entry that looks like an active exemption to the next reader — this fails loudly instead,
   * so the list is trimmed as part of whatever change made it stale.
   */
  it('does not allowlist a method that no longer exists', () => {
    const blockNames = new Set(blocks.map((b) => b.name));
    const stale = [...REGION_SCOPE_ALLOWLIST].filter((name) => !blockNames.has(name));
    expect(stale).toEqual([]);
  });

  describe('the overview route carries the scope filter', () => {
    const controllerSource = stripComments(fs.readFileSync(CONTROLLER_PATH, 'utf8'));

    it("workforce() reads @GlobalScopeFilter() — without it the endpoint never derives the caller's regions from their JWT and stays national", () => {
      const start = controllerSource.indexOf('async workforce(');
      expect(start).toBeGreaterThan(-1);
      // This handler takes exactly one parameter on one line, so the first `{` after `start` is
      // safely the body's own opening brace — no parameter-list object literal to skip past, the
      // way `assayer.controller.ts`'s multi-parameter routes need a full paren-depth scan for.
      const signature = controllerSource.slice(start, controllerSource.indexOf('{', start));
      expect(signature).toMatch(/@GlobalScopeFilter\(\)/);
    });
  });
});
