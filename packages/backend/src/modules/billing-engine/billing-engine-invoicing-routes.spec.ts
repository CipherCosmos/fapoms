import * as fs from 'fs';
import * as path from 'path';

/**
 * Fitness test for the two assayer-facing `invoice-invitation` routes on
 * `billing-engine.controller.ts`.
 *
 * These are the only billing routes an ASSAYER principal can WRITE through (submit) or use to
 * read money that is not yet on their statement (the reveal), and both take the assayer id from
 * the PATH — attacker-controlled. Each must therefore carry, in its own handler body:
 *
 *   1. the self-check (`req.user?.id !== assayerId` behind the billing-staff bypass), copied
 *      from the statement route it sits beside — without it any assayer can read or submit any
 *      other assayer's invitation by UUID alone;
 *   2. the region assertion (`regionGuard.assertAssayerInScope`) — the repo's fitness
 *      convention for `:assayerId` routes (see assayer-controller-region-scope.spec.ts, whose
 *      technique and helpers this file copies) so a region-scoped operator cannot reach across
 *      desks; and
 *   3. the rollout gate (`assertEnabled`) — the feature ships dark, and a new invitation route
 *      that skips the gate un-darks it for one path.
 *
 * Static text analysis rather than a NestJS test module — same reasoning as the assayer
 * controller's spec: the property being asserted belongs to the SOURCE (every matching
 * handler's body contains the calls), not to runtime behaviour.
 */
describe('BillingEngineController invoice-invitation route fitness test', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'billing-engine.controller.ts'), 'utf8');
  /**
   * Comments blanked (not removed — offsets stay usable for the scanners) before analysis, so
   * prose that names a route verbatim can never register as a second occurrence of it.
   */
  const content = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

  /**
   * The index just after the `}` that closes a handler's own body, given the index of its
   * `async` keyword. The parameter list is skipped paren-depth-aware FIRST (a decorator default
   * like `new ParseLimitPipe({ default: 20 })` owns a `{` that is not the body's), and only the
   * first `{` after its closing `)` is taken as the body's opening brace.
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
    throw new Error('Unbalanced braces while scanning billing-engine.controller.ts — fitness test cannot parse it.');
  }

  /**
   * One block per handler: from the end of the PREVIOUS handler's body to the end of THIS one's,
   * so each handler's decorators stay attached to ITS block rather than its neighbour's.
   */
  const methodStarts = [...content.matchAll(/\n {2}async (\w+)\(/g)];
  const blocks = methodStarts.map((m, i) => ({
    name: m[1],
    text: content.slice(i === 0 ? 0 : bodyEndAfter(methodStarts[i - 1].index!), bodyEndAfter(m.index!)),
  }));

  /** A route whose path names the assayer's invoice invitation. */
  const INVITATION_ROUTE = /@(?:Get|Post|Put|Delete|Patch)\(\s*['"`]assayers\/:assayerId\/invoice-invitation[^'"`]*['"`]/;

  const invitationRoutes = blocks.filter((b) => INVITATION_ROUTE.test(b.text));

  // A canary for the fitness test itself: fewer than the two known routes means the regex has
  // stopped matching real declarations (a decorator style changed), and the per-route
  // assertions below would be silently checking nothing.
  it('finds both invitation routes (the reveal, and submit)', () => {
    expect(invitationRoutes.length).toBe(2);
    expect(invitationRoutes.map((b) => b.name).sort()).toEqual(
      ['assayerInvoiceInvitation', 'submitAssayerInvoiceInvitation'].sort(),
    );
  });

  for (const block of invitationRoutes) {
    it(`${block.name} carries the self-check — an assayer touches only their OWN invitation`, () => {
      expect(block.text).toMatch(/req\.user\?\.id !== assayerId/);
      expect(block.text).toMatch(/ForbiddenException/);
    });

    it(`${block.name} carries the region assertion`, () => {
      expect(block.text).toMatch(/regionGuard\.assertAssayerInScope/);
    });

    it(`${block.name} sits behind the rollout gate`, () => {
      expect(block.text).toMatch(/assertEnabled\(\)/);
    });
  }
});
