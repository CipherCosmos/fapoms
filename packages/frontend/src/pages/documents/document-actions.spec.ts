import * as fs from 'fs';
import * as path from 'path';
import { SystemRole } from '@fapoms/shared';
import { documentActionsFor } from './document-actions';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));

/**
 * The paperwork page is open to more roles than any one of its buttons: each flag mirrors its own
 * server route (document.controller / customer-master), and every panel is handed the same flags.
 */
describe('documentActionsFor', () => {
  it('AUDITOR reads the trail but downloads nothing and acts on nothing', () => {
    expect(documentActionsFor([SystemRole.AUDITOR])).toEqual({
      upload: false, dispatch: false, markReceived: false, sendToOcr: false, uploadExcel: false, download: false,
    });
  });

  it('OPERATIONS dispatches and downloads but does not push to the OCR vendor', () => {
    expect(documentActionsFor([SystemRole.OPERATIONS])).toMatchObject({ dispatch: true, download: true, sendToOcr: false, uploadExcel: false });
  });

  it('DESK_OPERATOR only downloads; ADMIN and DEVELOPER get everything', () => {
    expect(documentActionsFor([SystemRole.DESK_OPERATOR])).toMatchObject({ download: true, dispatch: false, upload: false });
    for (const r of [SystemRole.ADMIN, SystemRole.DEVELOPER]) {
      expect(Object.values(documentActionsFor([r])).every(Boolean)).toBe(true);
    }
  });

  it('a custom role gets none (these routes carry no permission fallback)', () => {
    expect(Object.values(documentActionsFor(['PAPERWORK_CLERK' as SystemRole])).some(Boolean)).toBe(false);
  });
});

describe('Documents page hands every panel the flags', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'Documents.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  it.each(['BranchDocumentPanel', 'DocumentControlPanel'])('%s receives actions', (panel) => {
    const at = src.indexOf(`<${panel}`);
    expect(src.slice(at, src.indexOf('/>', at))).toMatch(/actions=\{documentActions\}/);
  });
  it('DailyRunPanel receives upload and download flags', () => {
    const at = src.indexOf('<DailyRunPanel');
    const block = src.slice(at, src.indexOf('/>', at));
    expect(block).toMatch(/canUpload=\{documentActions\.upload\}/);
    expect(block).toMatch(/canDownload=\{documentActions\.download\}/);
  });
});
