import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Any iframe that renders HTML we hold (`srcDoc` — an email or template preview) must be
 * sandboxed and must not grant script. Unsandboxed, a `<script>` or `onerror=` in a template runs
 * in the app's origin with the viewing admin's session. Scans every component and page, so a new
 * preview is covered without anyone adding it to a list.
 */
const SRC = join(__dirname, '..', '..');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : tsxFiles(p);
    return p.endsWith('.tsx') && !p.endsWith('.spec.tsx') ? [p] : [];
  });
}

const stripComments = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('srcDoc iframes are sandboxed without script', () => {
  const found: { file: string; tag: string }[] = [];
  for (const file of tsxFiles(SRC)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/<iframe\b([\s\S]*?)\/?>/g)) {
      if (/\bsrcDoc\s*=/.test(m[1])) found.push({ file, tag: m[1] });
    }
  }

  it('finds the previews it is meant to guard', () => {
    expect(found.some((f) => f.file.endsWith('NotificationAdmin.tsx'))).toBe(true);
  });

  it.each(found.map((f) => [f.file.replace(SRC, ''), f.tag]))('%s', (_file, tag) => {
    const sandbox = /\bsandbox\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*['"`]([^'"`]*)['"`]\s*\})/.exec(tag as string);
    expect(sandbox).not.toBeNull();
    const value = sandbox![1] ?? sandbox![2] ?? sandbox![3] ?? '';
    expect(value).not.toMatch(/allow-scripts/);
  });
});
