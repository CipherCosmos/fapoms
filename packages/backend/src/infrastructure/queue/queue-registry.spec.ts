import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { ALL_QUEUE_NAMES } from './worker-concurrency';

/**
 * The guard for task 1 of the api/worker split: one queue registry, derived from
 * `WORKER_CONCURRENCY` (`ALL_QUEUE_NAMES`), consumed by `pauseLocalQueues` (main.ts), the
 * job-failure monitor and Bull Board.
 *
 * Before this, three call sites each hand-maintained their own six-name list while Redis actually
 * held twelve queues — `retention`, `geo-precision`, `import-jobs`, `planning-jobs`,
 * `report-jobs` and `billing-jobs` were registered with Bull but invisible to all three. This test
 * scans the source for every `BullModule.registerQueue({ name: ... })` call (resolving the simple
 * `const X = 'literal'` constants those calls reference) and fails if any registered queue name is
 * missing from `ALL_QUEUE_NAMES` — so adding a queue to Bull without adding it to
 * `WORKER_CONCURRENCY` breaks the build instead of silently going unpaused/unmonitored/unlisted.
 */
describe('queue registry', () => {
  const SRC = join(__dirname, '..', '..');

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(full);
      return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
    });

  /** Resolve `const REF = 'literal'` (optionally exported) anywhere in the source tree. */
  const resolveExportedConst = (ref: string, files: string[]): string | null => {
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      const m = new RegExp(`(?:export\\s+)?const\\s+${ref}\\s*=\\s*['"]([^'"]+)['"]`).exec(code);
      if (m) return m[1];
    }
    return null;
  };

  /** Resolve `registerQueue({ name: X })` where X is either a string literal or a const. */
  const registeredQueueNames = (): string[] => {
    const files = sourceFiles(SRC);
    const names: string[] = [];
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      for (const m of code.matchAll(/registerQueue\(\s*\{\s*name:\s*([^,}\s]+)/g)) {
        const ref = m[1];
        const literal = /^['"]([^'"]+)['"]$/.exec(ref);
        if (literal) {
          names.push(literal[1]);
          continue;
        }
        // A local const, or one imported from another module — search the same file first,
        // then the whole tree (cheap enough here; the tree is small and this only runs in tests).
        const local = new RegExp(`const\\s+${ref}\\s*=\\s*['"]([^'"]+)['"]`).exec(code);
        const resolved = local ? local[1] : resolveExportedConst(ref, files);
        if (resolved) {
          names.push(resolved);
        } else {
          throw new Error(`queue-registry.spec: could not resolve queue name "${ref}" in ${file}`);
        }
      }
    }
    return names;
  };

  it('every queue registered with Bull appears in ALL_QUEUE_NAMES', () => {
    const registered = new Set(registeredQueueNames());
    const registry = new Set(ALL_QUEUE_NAMES);

    const missing = [...registered].filter((name) => !registry.has(name));
    expect(missing).toEqual([]);
  });

  it('ALL_QUEUE_NAMES has no name absent from Bull registration (no stale entries)', () => {
    const registered = new Set(registeredQueueNames());
    const stale = ALL_QUEUE_NAMES.filter((name) => !registered.has(name));
    expect(stale).toEqual([]);
  });
});
