/**
 * De-envelope codemod for Phase E of the 2026-09-12 remediation plan.
 *
 * ResponseInterceptor (infrastructure/http/response.interceptor.ts) has been idempotent since it
 * shipped: an already-enveloped `{ success, ... }` body passes through untouched, anything else
 * gets wrapped in `{ success: true, data }`. That is what makes it safe to de-envelope one
 * controller at a time — the wire response is unchanged either way, whichever side of the change
 * a given handler is on. Nothing has actually done so yet.
 *
 * This tool only ever transforms the one shape it can prove safe: a `return` statement, directly
 * inside a method decorated with an HTTP-verb decorator (no `@Res()` param on that method, no
 * `@NoEnvelope()` on the method or class), whose expression is an object literal with EXACTLY two
 * properties — `success: true` and `data: <expr>`. That return is rewritten to `return <expr>;`.
 *
 * Everything else that merely LOOKS like a candidate (a `success: true` literal found anywhere
 * else) is reported, never touched:
 *   - a bare `{ success: true }` with no `data` key — `data: null` vs no `data` key is a real,
 *     if minor, wire difference and must be judged by hand;
 *   - `success: true` alongside keys other than `data` (e.g. a sibling `documentUrl`) — collapsing
 *     this automatically would drop those keys from the response;
 *   - a `return` reachable only through a nested function/callback, not the handler's own body;
 *   - most importantly, a `success: true` literal found in a method that is NOT itself an
 *     HTTP-decorated handler. `scope.controller.ts`'s `computeOptions()` is exactly this shape:
 *     a private helper whose return value flows out through `cache.wrap(...)` unchanged, so the
 *     fix is identical, but proving that requires reading the call chain, not scanning syntax —
 *     this tool does not attempt it and never touches a non-handler method.
 *
 * The per-file grep count (informational; not authoritative) is compared against how many sites
 * this tool actually classifies (automated + manual-review) so a mismatch — most likely a
 * helper-method indirection like the one above — is visible instead of silently under-counted.
 *
 * Usage:
 *   npx ts-node scripts/codemods/de-envelope-controllers.ts --dry-run [file...]   # report only
 *   npx ts-node scripts/codemods/de-envelope-controllers.ts [file...]            # apply + report
 * With no files given, scans every src/**\/*.controller.ts.
 */
import { Project, SyntaxKind, Node, MethodDeclaration, ObjectLiteralExpression } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

const HTTP_METHOD_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete']);
const REPO_ROOT = path.resolve(__dirname, '../..');

function hasDecoratorNamed(node: MethodDeclaration | { getDecorators: () => any[] }, name: string): boolean {
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

/**
 * `@Res({ passthrough: true })` leaves Nest's normal pipeline (interceptors included) in charge
 * of the return value — it exists so a handler can set a status code or header while still
 * returning a body. Bare `@Res()` (or an explicit `{ passthrough: false }`) hands the response
 * object to the handler outright; ResponseInterceptor's own `headersSent` check is what excludes
 * that case at runtime, and this codemod must not touch its return values statically either,
 * since the handler is expected to end the response itself. Only the bare form disqualifies a
 * method from automation here.
 */
function hasBareResParam(method: MethodDeclaration): boolean {
  return method.getParameters().some((p) => {
    const dec = p.getDecorators().find((d) => {
      const expr = d.getExpression();
      const callee = Node.isCallExpression(expr) ? expr.getExpression() : expr;
      return callee.getText() === 'Res';
    });
    if (!dec) return false;
    const expr = dec.getExpression();
    if (!Node.isCallExpression(expr) || expr.getArguments().length === 0) return true; // bare @Res()
    const arg = expr.getArguments()[0];
    if (!Node.isObjectLiteralExpression(arg)) return true;
    const passthrough = arg.getProperties().find(
      (p2) => Node.isPropertyAssignment(p2) && p2.getName() === 'passthrough',
    );
    return !(passthrough && Node.isPropertyAssignment(passthrough) && Node.isTrueLiteral(passthrough.getInitializer()));
  });
}

/** Exactly `{ success: true, data: <expr> }` — order-independent, no other keys. */
function matchSafeShape(obj: ObjectLiteralExpression): { dataExpr: Node; dataProp: Node } | null {
  const props = obj.getProperties();
  if (props.length !== 2) return null;
  let successOk = false;
  let dataExpr: Node | null = null;
  let dataProp: Node | null = null;
  for (const p of props) {
    if (!Node.isPropertyAssignment(p)) return null;
    const name = p.getName();
    if (name === 'success') {
      const init = p.getInitializer();
      if (init && Node.isTrueLiteral(init)) successOk = true;
      else return null;
    } else if (name === 'data') {
      dataExpr = p.getInitializer() ?? null;
      dataProp = p;
    } else {
      return null;
    }
  }
  return successOk && dataExpr && dataProp ? { dataExpr, dataProp } : null;
}

/**
 * Leading `//`/`/** *\/` comments immediately before `node`, as source text — e.g. a doc comment
 * explaining a security- or product-relevant fact about the value being computed. `.getText()` on
 * the value we keep never includes these (they precede it), and `ReturnStatement#replaceWithText`
 * replaces the statement's own leading-trivia range too when nothing but whitespace separates a
 * comment from the statement it annotates — so either one is silently dropped unless captured and
 * re-emitted explicitly.
 */
function leadingCommentsText(node: Node): string {
  const ranges = node.getLeadingCommentRanges();
  if (ranges.length === 0) return '';
  return ranges.map((r) => r.getText()).join('\n') + '\n';
}

/** True if `obj` has a `success: true` property, regardless of what else it carries. */
function hasSuccessTrue(obj: ObjectLiteralExpression): boolean {
  return obj.getProperties().some(
    (p) =>
      Node.isPropertyAssignment(p) &&
      p.getName() === 'success' &&
      Node.isTrueLiteral(p.getInitializer()),
  );
}

interface FileResult {
  file: string;
  automated: number;
  manualNotHandler: number;
  manualShape: number;
  excludedResOrNoEnvelope: number;
  skippedFile: boolean;
  skippedFileReason?: string;
  grepCount: number;
}

function grepCount(filePath: string): number {
  try {
    const out = execSync(`grep -o "success: true\\|success:true" "${filePath}"`, { encoding: 'utf8' });
    return out.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function processFile(filePath: string, project: Project, apply: boolean): FileResult {
  const sourceFile = project.addSourceFileAtPath(filePath);
  const relPath = path.relative(REPO_ROOT, filePath);
  const result: FileResult = {
    file: relPath,
    automated: 0,
    manualNotHandler: 0,
    manualShape: 0,
    excludedResOrNoEnvelope: 0,
    skippedFile: false,
    grepCount: grepCount(filePath),
  };

  const classes = sourceFile.getClasses();
  const controllerClass = classes.find((c) => hasDecoratorNamed(c as any, 'Controller'));
  if (!controllerClass) {
    result.skippedFile = true;
    result.skippedFileReason = 'no @Controller() class found';
    return result;
  }

  const classNoEnvelope = hasDecoratorNamed(controllerClass as any, 'NoEnvelope');

  for (const method of controllerClass.getMethods()) {
    const methodIsHandler = isHttpHandler(method);
    const methodNoEnvelope = classNoEnvelope || hasDecoratorNamed(method as any, 'NoEnvelope');
    const methodHasRes = hasBareResParam(method);

    const body = method.getBody();
    if (!body) continue;

    // Every return statement whose innermost enclosing function-like ancestor is THIS method —
    // i.e. not one more level in, inside a nested arrow function/callback.
    const returns = body
      .getDescendantsOfKind(SyntaxKind.ReturnStatement)
      .filter((r) => {
        const enclosing = r.getFirstAncestor(
          (a) =>
            Node.isFunctionDeclaration(a) ||
            Node.isFunctionExpression(a) ||
            Node.isArrowFunction(a) ||
            Node.isMethodDeclaration(a),
        );
        return enclosing === method;
      });

    for (const ret of returns) {
      const expr = ret.getExpression();
      if (!expr || !Node.isObjectLiteralExpression(expr)) continue;
      if (!hasSuccessTrue(expr)) continue;

      if (!methodIsHandler) {
        result.manualNotHandler++;
        continue;
      }
      if (methodNoEnvelope || methodHasRes) {
        // Deliberately excluded scope, not a shape problem — do not count as manual-review noise.
        result.excludedResOrNoEnvelope++;
        continue;
      }

      const safe = matchSafeShape(expr);
      if (!safe) {
        result.manualShape++;
        continue;
      }

      result.automated++;
      if (apply) {
        // Preserve both: a comment leading the whole `return` statement (e.g. explaining why the
        // value is shaped this way at all) and one leading the `data:` property specifically
        // (e.g. explaining the value itself) — two different, both real, attachment points.
        const preserved = leadingCommentsText(ret) + leadingCommentsText(safe.dataProp);
        ret.replaceWithText(`${preserved}return ${safe.dataExpr.getText()};`);
      }
    }
  }

  if (apply && result.automated > 0) {
    sourceFile.saveSync();
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const files = args.filter((a) => a !== '--dry-run');

  const targets =
    files.length > 0
      ? files.map((f) => path.resolve(process.cwd(), f))
      : execSync(`find "${REPO_ROOT}/src" -name "*.controller.ts"`, { encoding: 'utf8' })
          .split('\n')
          .filter(Boolean);

  const project = new Project({
    tsConfigFilePath: path.join(REPO_ROOT, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });

  const results: FileResult[] = [];
  for (const f of targets) {
    if (!fs.existsSync(f)) continue;
    results.push(processFile(f, project, !dryRun));
  }

  let totalAuto = 0;
  let totalManual = 0;
  let totalMismatch = 0;
  for (const r of results) {
    if (r.skippedFile) {
      console.log(`SKIP  ${r.file} — ${r.skippedFileReason}`);
      continue;
    }
    const classified = r.automated + r.manualNotHandler + r.manualShape + r.excludedResOrNoEnvelope;
    const mismatch = classified !== r.grepCount;
    if (mismatch) totalMismatch++;
    totalAuto += r.automated;
    totalManual += r.manualNotHandler + r.manualShape;
    console.log(
      `${mismatch ? 'MISMATCH' : 'ok      '}  ${r.file}  ` +
        `grep=${r.grepCount} automated=${r.automated} manual(not-handler)=${r.manualNotHandler} ` +
        `manual(shape)=${r.manualShape} excluded(res/noEnvelope)=${r.excludedResOrNoEnvelope}`,
    );
  }
  console.log('---');
  console.log(`Total: automated=${totalAuto} manual=${totalManual} files-with-mismatch=${totalMismatch}`);
  if (dryRun) console.log('(dry run — no files written)');
}

main();
