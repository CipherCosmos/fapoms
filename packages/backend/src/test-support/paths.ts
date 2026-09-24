import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Where things are, for specs that read or scan the source tree.
 *
 * Found by walking up to the package manifest, never by counting `..` from the spec's own folder.
 * A counted path is correct only while the spec stays at the depth it was written at: move it one
 * folder deeper and `join(__dirname, '..', '..')` quietly lands on a sub-folder, so a guard that
 * was meant to scan the whole backend scans a slice of it and goes on passing. Walking up to a
 * named manifest gives the same answer from anywhere, and throws if it cannot find it.
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

/** `packages/backend` — the backend package root. */
export function backendRoot(): string {
  return findUp(__dirname, (d) => manifest(d)?.name === '@fapoms/backend', 'the @fapoms/backend package');
}

/** `packages/backend/src`. */
export function backendSrc(): string {
  return join(backendRoot(), 'src');
}

/** The monorepo root (the manifest that declares the workspaces). */
export function repoRoot(): string {
  return findUp(__dirname, (d) => Array.isArray(manifest(d)?.workspaces), 'the workspace root');
}
