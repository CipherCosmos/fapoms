import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { CaseWorkspace } from './CaseWorkspace';
import { api } from '../../services/api';
import { SystemRole } from '@fapoms/shared';

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
// PdfRegionViewer pulls in pdfjs-dist, an ESM-only package Jest's CJS transform can't parse.
// It only renders once a document URL resolves, which this test never triggers — stub it out.
jest.mock('./PdfRegionViewer', () => ({ PdfRegionViewer: () => null }));
// CaseWorkspace always imports ThreadPanel (even though it never mounts one here, with no open
// queries) and ThreadPanel's module pulls in socket.ts, which reads `import.meta.env` — real ESM
// syntax Jest's CJS transform can't parse. Stub the module rather than every transitive import.
jest.mock('./ThreadPanel', () => ({ ThreadPanel: () => null }));
const mockRequest = api.request as jest.Mock;

/**
 * The case-level correction note used to be a bare textarea. It's now an input with a datalist of
 * common OCR/review correction reasons — the same suggestion mechanism the field-anchor input
 * already used a few lines above it. This pins that the suggestions are there AND that typing a
 * reason the list never offered still reaches the transition request untouched.
 */
describe('CaseWorkspace — correction note suggestions', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    localStorage.setItem('fapoms_user_cache', JSON.stringify({ roles: [SystemRole.DESK] }));
    mockRequest.mockImplementation(async (url: string) => {
      if (url.startsWith('/documents/project-branch/')) return [];
      if (url.startsWith('/validation?projectBranchId=')) {
        return [{ id: 'case-1', status: 'HUMAN_REVIEW', projectBranchId: 'pb-1', ocrResult: null }];
      }
      if (url.startsWith('/validation-queries/validation-case/')) return [];
      return {};
    });
  });
  afterEach(() => localStorage.clear());

  it('offers correction-reason suggestions and still transitions with free text typed in', async () => {
    render(<CaseWorkspace projectBranchId="pb-1" onBack={jest.fn()} />);

    const box = await screen.findByPlaceholderText('Notes (required if requesting a correction)') as HTMLInputElement;
    expect(box.tagName).toBe('INPUT');
    expect(box.getAttribute('list')).toBe('correction-note-suggestions');
    const values = Array.from(document.querySelectorAll('#correction-note-suggestions option')).map((o) => o.getAttribute('value'));
    expect(values).toContain('Wrong field extracted');
    expect(values).toContain('Value does not match the document');

    // Free text not on the list must still drive the actual decision.
    fireEvent.change(box, { target: { value: 'Bank seal partially covers the account number' } });
    fireEvent.click(screen.getByText('Request correction'));

    await screen.findByText('Request correction'); // still on screen; assert the request body below
    expect(mockRequest).toHaveBeenCalledWith(
      '/validation/case-1/transition',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ targetStatus: 'CORRECTION_REQUIRED', notes: 'Bank seal partially covers the account number' }),
      }),
    );
  });
});
