import { Project, SyntaxKind, Node, MethodDeclaration, ObjectLiteralExpression } from 'ts-morph';
import * as path from 'path';
import { execSync } from 'child_process';
import { backendRoot } from '../../test-support/paths';

/**
 * Ratchet fitness test for Phase E of the 2026-09-12 remediation plan: 47 controllers hand-built
 * `{ success: true, data }` at roughly 458 separate return sites (a plain-text count; a few of
 * those were a code comment quoting the shape, not a real site), when `ResponseInterceptor` has
 * applied that same envelope automatically — and passed an already-enveloped body straight
 * through — since it shipped. Around 371 real sites are gone as of this file; 80 remain, each
 * requiring a human judgment call this file does not attempt to make (a lone `{ success: true }`
 * with no `data` key, or `success: true` beside other sibling keys a blind rewrite would silently
 * drop).
 *
 * What this file actually guards against is regression: a return shaped like the old envelope
 * creeping back into a route that already dropped it, or appearing on a brand new route that
 * copy-pasted the pattern instead of just returning the value. Per `[[rules-written-down-as-lists-go-stale]]`,
 * the fix is not "assert zero violations" (81 real ones still exist and are not this file's job to
 * remove) but a RATCHET: an allowlist of exactly today's remaining sites, which
 *   - fails if a violation appears that is NOT on the list (a new one, or a bare `@Res()`/
 *     `@NoEnvelope()` route that stopped being exempt some other way) — regression;
 *   - fails if a listed site is NOT found violating any more (it was fixed, and the entry was
 *     never deleted) — a STALE entry, which would otherwise silently mask a REAL new violation at
 *     the same key once one method starts hand-rolling the envelope again after being fixed once;
 *   - fails if the total ever exceeds today's count — a hard ceiling that can only move down.
 * The allowlist is derived data (a fixed set of `file :: method` strings), not a mechanism anyone
 * has to keep in sync with the source by re-reading it — the three checks above do that.
 */

const BACKEND_ROOT = backendRoot();

const HTTP_METHOD_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete']);

function hasDecoratorNamed(node: { getDecorators(): any[] }, name: string): boolean {
  return node.getDecorators().some((d: any) => {
    const expr = d.getExpression();
    const callee = Node.isCallExpression(expr) ? expr.getExpression() : expr;
    return callee.getText() === name;
  });
}

function isHttpHandler(method: MethodDeclaration): boolean {
  return method.getDecorators().some((d) => {
    const expr = d.getExpression();
    const callee = Node.isCallExpression(expr) ? expr.getExpression() : expr;
    return HTTP_METHOD_DECORATORS.has(callee.getText());
  });
}

/** Same reasoning as the codemod: `@Res({ passthrough: true })` stays subject to the envelope. */
function hasBareResParam(method: MethodDeclaration): boolean {
  return method.getParameters().some((p) => {
    const dec = p.getDecorators().find((d) => {
      const expr = d.getExpression();
      const callee = Node.isCallExpression(expr) ? expr.getExpression() : expr;
      return callee.getText() === 'Res';
    });
    if (!dec) return false;
    const expr = dec.getExpression();
    if (!Node.isCallExpression(expr) || expr.getArguments().length === 0) return true;
    const arg = expr.getArguments()[0];
    if (!Node.isObjectLiteralExpression(arg)) return true;
    const passthrough = arg
      .getProperties()
      .find((p2) => Node.isPropertyAssignment(p2) && p2.getName() === 'passthrough');
    return !(
      passthrough &&
      Node.isPropertyAssignment(passthrough) &&
      Node.isTrueLiteral(passthrough.getInitializer())
    );
  });
}

function hasSuccessTrueLiteral(obj: ObjectLiteralExpression): boolean {
  return obj
    .getProperties()
    .some(
      (p) =>
        Node.isPropertyAssignment(p) && p.getName() === 'success' && Node.isTrueLiteral(p.getInitializer()),
    );
}

/**
 * True when `method` — a route handler this codebase does not otherwise exempt — returns a
 * hand-built `{ success: true, ... }` envelope anywhere in its own body (not a nested callback's).
 * This is independent of, not shared with, the codemod's own classification (scripts/codemods/
 * de-envelope-controllers.ts): the two are asking different questions — "is this specific site
 * safe to auto-rewrite" versus "has this method's envelope been dealt with at all" — and giving
 * them separate implementations means a bug in one cannot silently make the other blind to the
 * same case. Mutation-tested below against literal fixtures, independently of any real file.
 */
function hasEnvelopeViolation(method: MethodDeclaration): boolean {
  if (!isHttpHandler(method)) return false;
  if (hasBareResParam(method)) return false;
  if (hasDecoratorNamed(method, 'NoEnvelope')) return false;
  const cls = method.getParentIfKind(SyntaxKind.ClassDeclaration);
  if (cls && hasDecoratorNamed(cls, 'NoEnvelope')) return false;
  const body = method.getBody();
  if (!body) return false;
  const returns = body.getDescendantsOfKind(SyntaxKind.ReturnStatement).filter((r) => {
    const enclosing = r.getFirstAncestor(
      (a) =>
        Node.isFunctionDeclaration(a) ||
        Node.isFunctionExpression(a) ||
        Node.isArrowFunction(a) ||
        Node.isMethodDeclaration(a),
    );
    return enclosing === method;
  });
  return returns.some((r) => {
    const expr = r.getExpression();
    return !!expr && Node.isObjectLiteralExpression(expr) && hasSuccessTrueLiteral(expr);
  });
}

describe('envelope-violation extraction — mutation fixtures', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  let counter = 0;

  /** Compiles `body` as one handler method inside a throwaway @Controller class. */
  function methodFor(body: string, opts: { decorators?: string; classDecorators?: string } = {}): MethodDeclaration {
    const file = project.createSourceFile(
      `/fixture-${counter++}.controller.ts`,
      `
      import { Controller, Get, Res, SetMetadata } from '@nestjs/common';
      ${opts.classDecorators ?? ''}
      @Controller('x')
      class FixtureController {
        ${opts.decorators ?? '@Get()'}
        async handler(${opts.decorators?.includes('Res') ? '' : ''}) {
          ${body}
        }
      }
      `,
      { overwrite: true },
    );
    const cls = file.getClasses()[0];
    return cls.getMethods()[0];
  }

  it('flags a real violation: { success: true, data }', () => {
    const m = methodFor('return { success: true, data: 1 };');
    expect(hasEnvelopeViolation(m)).toBe(true);
  });

  it('does not flag an already-migrated bare return', () => {
    const m = methodFor('return 1;');
    expect(hasEnvelopeViolation(m)).toBe(false);
  });

  it('does not flag a success:false error-shaped return (a different, legitimate shape)', () => {
    const m = methodFor('return { success: false, error: "nope" };');
    expect(hasEnvelopeViolation(m)).toBe(false);
  });

  it('does not flag an @NoEnvelope() route even with the old wrapper still in place', () => {
    const file = project.createSourceFile(
      `/fixture-${counter++}.controller.ts`,
      `
      import { Controller, Get, SetMetadata } from '@nestjs/common';
      const NoEnvelope = () => SetMetadata('noEnvelope', true);
      @Controller('x')
      class FixtureController {
        @Get()
        @NoEnvelope()
        async handler() {
          return { success: true, data: 1 };
        }
      }
      `,
      { overwrite: true },
    );
    const m = file.getClasses()[0].getMethods()[0];
    expect(hasEnvelopeViolation(m)).toBe(false);
  });

  it('does not flag a bare @Res() route even with the old wrapper still in place', () => {
    const file = project.createSourceFile(
      `/fixture-${counter++}.controller.ts`,
      `
      import { Controller, Get, Res } from '@nestjs/common';
      @Controller('x')
      class FixtureController {
        @Get()
        async handler(@Res() res: any) {
          return { success: true, data: 1 };
        }
      }
      `,
      { overwrite: true },
    );
    const m = file.getClasses()[0].getMethods()[0];
    expect(hasEnvelopeViolation(m)).toBe(false);
  });

  it('DOES flag @Res({ passthrough: true }) — the interceptor still runs for it', () => {
    const file = project.createSourceFile(
      `/fixture-${counter++}.controller.ts`,
      `
      import { Controller, Get, Res } from '@nestjs/common';
      @Controller('x')
      class FixtureController {
        @Get()
        async handler(@Res({ passthrough: true }) res: any) {
          return { success: true, data: 1 };
        }
      }
      `,
      { overwrite: true },
    );
    const m = file.getClasses()[0].getMethods()[0];
    expect(hasEnvelopeViolation(m)).toBe(true);
  });

  it('does not flag a non-handler method (no HTTP decorator) even with the old wrapper', () => {
    const file = project.createSourceFile(
      `/fixture-${counter++}.controller.ts`,
      `
      import { Controller } from '@nestjs/common';
      @Controller('x')
      class FixtureController {
        private helper() {
          return { success: true, data: 1 };
        }
      }
      `,
      { overwrite: true },
    );
    const m = file.getClasses()[0].getMethods()[0];
    expect(hasEnvelopeViolation(m)).toBe(false);
  });

  it('does not flag a violation sitting inside a nested callback, not the handler\'s own body', () => {
    const file = project.createSourceFile(
      `/fixture-${counter++}.controller.ts`,
      `
      import { Controller, Get } from '@nestjs/common';
      @Controller('x')
      class FixtureController {
        @Get()
        async handler() {
          const mapped = [1].map(() => ({ success: true, data: 1 }));
          return mapped;
        }
      }
      `,
      { overwrite: true },
    );
    const m = file.getClasses()[0].getMethods()[0];
    expect(hasEnvelopeViolation(m)).toBe(false);
  });
});

describe('response envelope boundary — no controller hand-rolls the envelope outside the allowlist', () => {
  /**
   * Exactly today's remaining sites (`file :: method`, file relative to packages/backend). Every
   * migration should DELETE its own entry in the same commit — see the "no stale entries" test
   * below for what happens if one is forgotten. This is not a target list to leave alone; it is
   * what is left after 369 of 450 real sites were fixed, and shrinks from here.
   */
  const ALLOWLIST = new Set<string>([
    'src/core/audit/audit.controller.ts :: getEntityHistory',
    'src/core/audit/audit.controller.ts :: getRecentActivity',
    'src/core/audit/audit.controller.ts :: getUnifiedTrail',
    'src/core/audit/audit.controller.ts :: getUserActivity',
    'src/infrastructure/data-reset/data-reset.controller.ts :: listRequests',
    'src/modules/assayer-remarks/assayer-remarks.controller.ts :: listForAssayer',
    'src/modules/assayer/assayer.controller.ts :: addReference',
    'src/modules/assayer/assayer.controller.ts :: attachDocumentFile',
    'src/modules/assayer/assayer.controller.ts :: bulkIssueAppAccess',
    'src/modules/assayer/assayer.controller.ts :: bulkNotify',
    'src/modules/assayer/assayer.controller.ts :: changeMyPassword',
    'src/modules/assayer/assayer.controller.ts :: findAll',
    'src/modules/assayer/assayer.controller.ts :: getActivityTimeline',
    'src/modules/assayer/assayer.controller.ts :: getDossier',
    'src/modules/assayer/assayer.controller.ts :: getPartnerQualifications',
    'src/modules/assayer/assayer.controller.ts :: getPlanningSnapshot',
    'src/modules/assayer/assayer.controller.ts :: getQualification',
    'src/modules/assayer/assayer.controller.ts :: issueAppAccess',
    'src/modules/assayer/assayer.controller.ts :: listImportIssues',
    'src/modules/assayer/assayer.controller.ts :: markReferenceChecked',
    'src/modules/assayer/assayer.controller.ts :: recordBackgroundCheck',
    'src/modules/assayer/assayer.controller.ts :: resetAssayerPassword',
    'src/modules/assayer/assayer.controller.ts :: resolveImportIssue',
    'src/modules/assayer/assayer.controller.ts :: resolveImportIssues',
    'src/modules/assayer/assayer.controller.ts :: revealSensitiveField',
    'src/modules/assayer/assayer.controller.ts :: setDocument',
    'src/modules/assayer/assayer.controller.ts :: setEmpanelment',
    'src/modules/assayer/assayer.controller.ts :: setScoreOverride',
    'src/modules/assayer/assayer.controller.ts :: updateReference',
    'src/modules/assayer/assayer.controller.ts :: verifyDocument',
    'src/modules/assayer/public-registration.controller.ts :: uploadDocument',
    'src/modules/assignment/assignment.controller.ts :: checkIn',
    'src/modules/assignment/assignment.controller.ts :: checkOut',
    'src/modules/assignment/assignment.controller.ts :: findAll',
    'src/modules/assignment/assignment.controller.ts :: findByAssayer',
    'src/modules/auth/session.controller.ts :: forUser',
    'src/modules/auth/session.controller.ts :: mine',
    'src/modules/auth/session.controller.ts :: revoke',
    'src/modules/branch/branch.controller.ts :: findAll',
    'src/modules/calls/calls.controller.ts :: answer',
    'src/modules/calls/calls.controller.ts :: initiate',
    'src/modules/client/client.controller.ts :: findAll',
    'src/modules/customer-master/customer-master.controller.ts :: findRecords',
    'src/modules/document/document.controller.ts :: assayerBranchDocuments',
    'src/modules/document/document.controller.ts :: completeUpload',
    'src/modules/document/document.controller.ts :: dispatchBatch',
    'src/modules/document/document.controller.ts :: dispatchDocument',
    'src/modules/document/document.controller.ts :: findByProjectBranch',
    'src/modules/document/document.controller.ts :: mobileUpload',
    'src/modules/document/document.controller.ts :: mobileUploadBinary',
    'src/modules/document/document.controller.ts :: operationsOverview',
    'src/modules/document/document.controller.ts :: receiveDocument',
    'src/modules/document/document.controller.ts :: sendToExternalOcr',
    'src/modules/document/document.controller.ts :: uploadExcelReport',
    'src/modules/feedback/feedback.controller.ts :: queue',
    'src/modules/geo/geo.controller.ts :: autocomplete',
    'src/modules/holiday/holiday.controller.ts :: findAll',
    'src/modules/notifications/notification-admin.controller.ts :: update',
    'src/modules/notifications/notification.controller.ts :: findMyNotifications',
    'src/modules/notifications/notification.controller.ts :: registerDeviceToken',
    'src/modules/notifications/notification.controller.ts :: unregisterDeviceToken',
    'src/modules/organization/organization.controller.ts :: findAll',
    'src/modules/planning/planning.controller.ts :: getRecommendations',
    'src/modules/pricing/transport-rate.controller.ts :: create',
    'src/modules/pricing/transport-rate.controller.ts :: deactivate',
    'src/modules/pricing/transport-rate.controller.ts :: estimate',
    'src/modules/pricing/transport-rate.controller.ts :: update',
    'src/modules/project/project.controller.ts :: findAll',
    'src/modules/project/project.controller.ts :: getProjectBranches',
    'src/modules/scheduling/scheduling.controller.ts :: findAll',
    'src/modules/scheduling/scheduling.controller.ts :: getAssayerWorkload',
    'src/modules/search/search.controller.ts :: search',
    'src/modules/telemetry/telemetry.controller.ts :: forUser',
    'src/modules/user/user.controller.ts :: deleteRole',
    'src/modules/user/user.controller.ts :: findAll',
    'src/modules/user/user.controller.ts :: findDirectory',
    'src/modules/validation-query/validation-query.controller.ts :: findAll',
    'src/modules/validation/validation.controller.ts :: findAll',
    'src/modules/zone/zone.controller.ts :: findAll',
  ]);

  /**
   * The count ABOVE, not a re-derivation from the source: this must move only when someone edits
   * the list above by hand (a real migration or a real regression), never drift on its own the way
   * a computed value could. `toBeLessThanOrEqual` rather than `toBe` because the whole point of a
   * ratchet is to let this shrink one PR at a time without also having to edit this number in the
   * same breath — but it can never grow, which is the one direction that would mean the fitness
   * test itself has gone blind to a new violation.
   */
  const CANARY_CEILING = 80;

  const project = new Project({
    tsConfigFilePath: path.join(BACKEND_ROOT, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });

  const controllerFiles = execSync(`find "${BACKEND_ROOT}/src" -name "*.controller.ts"`, { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  const violations: string[] = [];
  for (const f of controllerFiles) {
    const sourceFile = project.addSourceFileAtPath(f);
    const rel = path.relative(BACKEND_ROOT, f);
    const controllerClass = sourceFile.getClasses().find((c) => hasDecoratorNamed(c, 'Controller'));
    if (!controllerClass) continue;
    for (const method of controllerClass.getMethods()) {
      if (hasEnvelopeViolation(method)) {
        violations.push(`${rel} :: ${method.getName()}`);
      }
    }
  }

  it(`finds no more than ${CANARY_CEILING} violations total — the ceiling only ever moves down`, () => {
    expect(violations.length).toBeLessThanOrEqual(CANARY_CEILING);
  });

  it('flags no violation outside the allowlist — a NEW or regressed site', () => {
    const unlisted = violations.filter((v) => !ALLOWLIST.has(v));
    expect(unlisted).toEqual([]);
  });

  it('has no STALE allowlist entry — a site that was fixed but never delisted', () => {
    const found = new Set(violations);
    const stale = [...ALLOWLIST].filter((entry) => !found.has(entry));
    expect(stale).toEqual([]);
  });
});
