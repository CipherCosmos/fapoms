import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Where things are, for specs that read or scan the source tree. Test-only: excluded from the app
 * build (tsconfig) and never imported by application code.
 *
 * Found by walking up to the package manifest, never by counting `..`. A counted path is right only
 * while the spec stays at the depth it was written at; moved one folder deeper, `join(__dirname,
 * '..')` quietly lands on a sub-folder and a guard that should scan all of src scans a slice and
 * keeps passing. Walking up to a named manifest is right from anywhere, and throws if it cannot.
 */
function findUp(from: string, isIt: (dir: string) => boolean, what: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (isIt(dir)) return dir;
    if (dirname(dir) === dir) throw new Error(`test-support/paths: could not find ${what} above ${from}`);
  }
}

function manifest(dir: string): { name?: string; workspaces?: unknown } | null {
  const p = join(dir, 'package.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/** `packages/frontend`. */
export function frontendRoot(): string {
  return findUp(__dirname, (d) => manifest(d)?.name === '@fapoms/frontend', 'the @fapoms/frontend package');
}

/** `packages/frontend/src`. */
export function frontendSrc(): string {
  return join(frontendRoot(), 'src');
}

/** The monorepo root (the manifest that declares the workspaces). */
export function repoRoot(): string {
  return findUp(__dirname, (d) => Array.isArray(manifest(d)?.workspaces), 'the workspace root');
}
