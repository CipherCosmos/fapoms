import * as fs from 'fs';
import * as path from 'path';

/**
 * Every route that accepts file bytes must malware-scan them. The multipart routes do it through
 * `FileScanInterceptor`; the two routes that DON'T take multipart — the JSON base64 `mobileUpload`
 * and the resumable `completeUpload` (which assembles chunks) — must call `fileScanner.scanOrThrow`
 * in their own body, because the interceptor cannot see a base64 body or a chunk-assembled object.
 *
 * `mobileUpload` shipped WITHOUT that scan (confirmed 2026-09-04): an audited-return PDF arriving as
 * base64 reached storage and the data-entry pipeline unscanned — a single alternate upload route
 * bypassing the control. This pins the fix so it cannot silently regress.
 */
const CONTROLLER = path.join(__dirname, 'document.controller.ts');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function handlerBody(src: string, method: string): string {
  const clean = stripComments(src);
  const sig = clean.search(new RegExp(`async\\s+${method}\\s*\\(`));
  if (sig === -1) return '';
  const parenOpen = clean.indexOf('(', sig);
  let pd = 0, afterParams = -1;
  for (let i = parenOpen; i < clean.length; i++) {
    if (clean[i] === '(') pd++;
    else if (clean[i] === ')') { pd--; if (pd === 0) { afterParams = i + 1; break; } }
  }
  const open = clean.indexOf('{', afterParams);
  let depth = 0;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}') { depth--; if (depth === 0) return clean.slice(open, i + 1); }
  }
  return '';
}

describe('every byte-accepting upload route scans before storing', () => {
  const src = fs.readFileSync(CONTROLLER, 'utf8');

  it.each(['mobileUpload', 'completeUpload'])(
    '%s (no FileScanInterceptor — base64/assembled) scans the buffer with fileScanner.scanOrThrow',
    (method) => {
      const body = handlerBody(src, method);
      expect(body).not.toBe('');
      expect(body).toContain('fileScanner.scanOrThrow');
    },
  );
});
