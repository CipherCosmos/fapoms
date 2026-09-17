import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { AUDIT_READ_KEY } from '../../core/audit/audit-read.decorator';
import { AssayerController } from './assayer.controller';
import { AssayerSelfServiceController } from './assayer-self-service.controller';
import { HrApplicationsController } from './hr-applications.controller';

/**
 * WHO OPENED WHOSE AADHAAR CARD.
 *
 * Opening an assayer's record, revealing a full PAN and downloading an ID card were all written to
 * the access log. Opening the SCAN of an identity card was not, on any route — an audit of the live
 * database found zero such events. So the one question a breach investigation asks first had no
 * answer. Every route that serves an identity scan, or the details read off one, is recorded now,
 * and none of them lets a browser keep a cached copy.
 */
const ROUTES: Array<{ name: string; controller: any; method: string; file: string }> = [
  { name: 'staff opening a document scan', controller: AssayerController, method: 'getDocumentFile', file: 'assayer.controller.ts' },
  { name: 'staff or auditor opening an older version', controller: AssayerController, method: 'getDocumentVersionFile', file: 'assayer.controller.ts' },
  { name: 'an assayer opening their own scan', controller: AssayerSelfServiceController, method: 'getOwnDocumentFile', file: 'assayer-self-service.controller.ts' },
  { name: 'HR opening a candidate’s scan', controller: HrApplicationsController, method: 'readDocument', file: 'hr-applications.controller.ts' },
];

/** A handler's own source, with comments removed so a comment cannot satisfy the check. */
function handlerSource(file: string, method: string): string {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const start = src.search(new RegExp(`async ${method}\\(`));
  expect(start).toBeGreaterThan(-1);
  const next = src.slice(start + 1).search(/\n  @(Get|Post|Put|Patch|Delete)\(/);
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}

describe('opening an identity scan leaves a record', () => {
  it.each(ROUTES)('records $name', ({ controller, method }) => {
    const options = Reflect.getMetadata(AUDIT_READ_KEY, controller.prototype[method]);
    expect(options).toBeDefined();
    expect(options.eventType).toMatch(/_VIEWED$/);
    expect(options.idParam).toBeTruthy();
  });

  it.each(ROUTES)('does not let a browser cache the scan when $name', ({ file, method }) => {
    expect(handlerSource(file, method)).toMatch(/Cache-Control['"],\s*['"]private, no-store['"]/);
  });

  it('records opening the dossier, which carries the details read off each card', () => {
    const options = Reflect.getMetadata(AUDIT_READ_KEY, AssayerController.prototype.getDossier);
    expect(options).toMatchObject({ eventType: 'ASSAYER_DOSSIER_VIEWED', idParam: 'assayerId' });
  });
});
