import { toCsv } from './csv';

describe('toCsv formula-injection guard', () => {
  it.each(['=1+1', '+1', '-1', '@A1', '\t=1+1', '\r=1+1'])('prefixes an apostrophe to %j', (lead) => {
    const out = toCsv(['h'], [[lead]]);
    expect(out.split('\r\n')[1]).toBe(`"'${lead}"`);
  });

  it('leaves ordinary values alone and doubles quotes', () => {
    expect(toCsv(['a', 'b'], [['Ravi', 'say "hi"'], [null, 5]])).toBe('"a","b"\r\n"Ravi","say ""hi"""\r\n"","5"');
  });
});

describe('every browser-side CSV download goes through this encoder', () => {
  // A hand-rolled `new Blob([...], { type: 'text/csv' })` is how the formula guard gets skipped:
  // the Projects export did exactly that. Only utils/csv.ts may build a CSV blob.
  it('no other source file builds a text/csv blob', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const root = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!/\.tsx?$/.test(p) || /\.spec\.tsx?$/.test(p) || p.endsWith(path.join('utils', 'csv.ts'))) continue;
        const src = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        if (/type:\s*['"`]text\/csv/.test(src)) offenders.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
