import { csvCell, csvRow } from './csv-cell';
import { backendSrc } from '../../test-support/paths';

describe('csvCell — the one server-side CSV encoder', () => {
  it.each([
    ['=HYPERLINK("http://x","y")', `"'=HYPERLINK(""http://x"",""y"")"`],
    ['+91 98765', "'+91 98765"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\t=1+1', "'\t=1+1"],
    ['\r=1+1', `"'\r=1+1"`],
  ])('neutralises formula lead %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('leaves ordinary text and mid-string formula characters alone', () => {
    expect(csvCell('Ravi Kumar')).toBe('Ravi Kumar');
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell('AS-01')).toBe('AS-01');
  });

  it('keeps real numbers (including negatives) as numbers', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(12.5)).toBe('12.5');
  });

  it('quotes commas, quotes and newlines; null/undefined are empty', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('csvRow joins encoded cells', () => {
    expect(csvRow(['=x', 'a,b', 3, null])).toBe(`'=x,"a,b",3,`);
  });
});

describe('every server-side CSV writer uses the shared encoder', () => {
  // A new export that hand-rolls its own cell quoting is exactly how the formula guard gets
  // forgotten. Any production file that sends a text/csv response must import core/csv/csv-cell.
  it('files that set a text/csv Content-Type import csv-cell', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const root = backendSrc();
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!p.endsWith('.ts') || p.endsWith('.spec.ts')) continue;
        const src = fs.readFileSync(p, 'utf8');
        if (/['"]Content-Type['"]\s*,\s*['"]text\/csv/.test(src) && !/core\/csv\/csv-cell['"]/.test(src)) {
          offenders.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
