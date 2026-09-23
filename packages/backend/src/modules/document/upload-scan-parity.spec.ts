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

  it.each(['mobileUpload', 'completeUpload', 'finalizeUpload'])(
    '%s (no FileScanInterceptor — base64/assembled) scans the buffer with fileScanner.scanOrThrow',
    (method) => {
      const body = handlerBody(src, method);
      expect(body).not.toBe('');
      expect(body).toContain('fileScanner.scanOrThrow');
    },
  );
});

/**
 * The rule above, app-wide. The two checks in this file used to read `document.controller.ts` only,
 * while file uploads had spread to ten controllers — interviews, hiring, public registration, BGV
 * reports, feedback, imports, validation queries. Every multipart route must pair its file
 * interceptor with a scanning one in the same `@UseInterceptors(...)`, or name itself below with the
 * reason it does not need to.
 */
const NOT_A_WHOLE_FILE: Record<string, string> = {
  // One chunk of a resumable upload is a fragment, not a file: it cannot be scanned or typed on
  // its own. `completeUpload` scans and content-checks the assembled object (pinned above).
  'upload/session/:uploadId/chunk/:index': 'resumable chunk — the assembled file is scanned at complete',
};

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) controllerFiles(full, out);
    else if (name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

/** Each `@UseInterceptors(...)` argument list, with the route path of the decorator block it sits in. */
function interceptorBlocks(src: string): Array<{ args: string; route: string }> {
  const clean = stripComments(src);
  const blocks: Array<{ args: string; route: string }> = [];
  const re = /@UseInterceptors\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    let depth = 0, end = m.index + m[0].length - 1;
    for (let i = end; i < clean.length; i++) {
      if (clean[i] === '(') depth++;
      else if (clean[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    const args = clean.slice(m.index + m[0].length, end);
    // The route decorator nearest above this one, within the same decorator stack.
    const before = clean.slice(Math.max(0, m.index - 600), m.index);
    const routes = [...before.matchAll(/@(?:Post|Put|Patch)\(\s*'([^']*)'/g)];
    blocks.push({ args, route: routes.length ? routes[routes.length - 1][1] : '' });
  }
  return blocks;
}

describe('every file-accepting route in every controller is scanned', () => {
  const files = controllerFiles(path.join(__dirname, '..', '..'));

  it('finds the upload routes (the scan itself works)', () => {
    const uploads = files.flatMap((f) =>
      interceptorBlocks(fs.readFileSync(f, 'utf8')).filter((b) => /(?:File|Files|FileFields|AnyFiles)Interceptor\(/.test(b.args)),
    );
    expect(uploads.length).toBeGreaterThanOrEqual(15);
  });

  it('pairs each file interceptor with FileScanInterceptor or DiskUploadScanInterceptor', () => {
    const unscanned: string[] = [];
    for (const file of files) {
      for (const block of interceptorBlocks(fs.readFileSync(file, 'utf8'))) {
        if (!/(?:File|Files|FileFields|AnyFiles)Interceptor\(/.test(block.args)) continue;
        if (/\b(?:FileScanInterceptor|DiskUploadScanInterceptor)\b/.test(block.args)) continue;
        if (NOT_A_WHOLE_FILE[block.route]) continue;
        unscanned.push(`${path.relative(path.join(__dirname, '..', '..'), file)} → ${block.route || '(route?)'}`);
      }
    }
    expect(unscanned).toEqual([]);
  });

  it('every controller that decodes a base64 file body scans it', () => {
    const offenders = files.filter((f) => {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      return /Buffer\.from\([^)]*'base64'\)/.test(src) && !src.includes('scanOrThrow');
    });
    expect(offenders).toEqual([]);
  });
});
