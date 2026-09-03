import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

import { AssayerVettingTab } from './AssayerVettingTab';
import { api } from '../../services/api';

/**
 * Two things this tab was quietly getting wrong.
 *
 * **References were append-only on screen and not in the API.** `PUT /assayers/:id/reference/:id`
 * and `DELETE /assayers/reference/:id` have existed since the vetting work landed; the table
 * offered only "Record call". On 1,983 imported reference rows a misspelt name or somebody
 * else's phone number could be added and never corrected.
 *
 * **A claimed soft copy read exactly like a real one.** `soft_copy_received` is ticked on 10,977
 * document rows that carry zero files — the old import copied a column of spreadsheet ticks —
 * and the Scan column rendered a green "Yes" for them, identical to a row with a scan attached.
 * That is why a roster with not one uploaded file looked collected.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../components/ui', () => ({
  useToast: () => ({ toast: jest.fn() }),
  useConfirm: () => ({ confirm: () => Promise.resolve(true), confirmDialog: null }),
  Select: ({ value, onChange }: any) => <input value={value} onChange={(e) => onChange(e.target.value)} />,
  Modal: ({ children }: any) => <div>{children}</div>,
  AlertBanner: ({ message, children }: any) => (message || children ? <div role="alert">{message ?? children}</div> : null),
  SkeletonList: () => <div data-testid="skeleton" />,
  // The real one. This tab's five tables ARE DataTable now, so stubbing it would leave these
  // tests asserting against an empty document — and a stub of a table is a second table, which is
  // the thing the convergence removed.
  DataTable: jest.requireActual('../../components/ui/DataTable').DataTable,
}));

const mockRequest = api.request as jest.Mock;

const dossier = (over: Record<string, unknown> = {}) => ({
  references: [
    { id: 'r-1', fullName: 'Old Manager', relationship: 'Former manager', phone: '+919000000000', checkedAt: null },
  ],
  empanelments: [],
  backgroundChecks: [],
  currentCheck: null,
  onboarding: [],
  openIssues: [],
  ...over,
});

const serve = (payload: ReturnType<typeof dossier>) => {
  mockRequest.mockImplementation((url: string) => {
    if (url.endsWith('/dossier')) return Promise.resolve(payload);
    if (url.startsWith('/clients')) return Promise.resolve([]);
    return Promise.resolve({});
  });
};

beforeEach(() => mockRequest.mockReset());

describe('AssayerVettingTab — references', () => {
  it('offers Change and Remove beside a reference, not only "Record call"', async () => {
    serve(dossier());

    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);

    await waitFor(() => expect(screen.getByText('Old Manager')).toBeInTheDocument());
    expect(screen.getByText('Record call')).toBeInTheDocument();
    expect(screen.getByText('Change')).toBeInTheDocument();
    expect(screen.getByText('Remove')).toBeInTheDocument();
  });

  it('sends a correction as a PUT on that reference, clearing an emptied phone rather than keeping the old one', async () => {
    serve(dossier());
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);
    await waitFor(() => expect(screen.getByText('Old Manager')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Change'));
    // The form opens pre-filled with what is on file, which is what makes it a correction.
    const name = screen.getByDisplayValue('Old Manager');
    fireEvent.change(name, { target: { value: 'Correct Manager' } });
    fireEvent.change(screen.getByDisplayValue('+919000000000'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/assayers/a-1/reference/r-1',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const [, options] = mockRequest.mock.calls.find(([url]) => url === '/assayers/a-1/reference/r-1')!;
    // `undefined` would be dropped from the JSON and the server would keep the old number
    // (`dto.phone ?? row.phone`) — the very correction the operator opened this form to make.
    expect(JSON.parse(options.body)).toEqual({
      fullName: 'Correct Manager', relationship: 'Former manager', phone: null,
    });
  });

  it('deletes through the reference route when Remove is confirmed', async () => {
    serve(dossier());
    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);
    await waitFor(() => expect(screen.getByText('Old Manager')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Remove'));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(
      '/assayers/reference/r-1',
      expect.objectContaining({ method: 'DELETE' }),
    ));
  });
});

describe('AssayerVettingTab — background checks', () => {
  it('says on screen that a check cannot be edited, instead of leaving people hunting for the control', async () => {
    serve(dossier({
      currentCheck: { id: 'c-1', verdict: 'CLEAR', checkedOn: '2025-06-01' },
      backgroundChecks: [{ id: 'c-1', verdict: 'CLEAR', checkedOn: '2025-06-01' }],
    }));

    render(<AssayerVettingTab assayerId="a-1" canManage section="checks" />);

    await waitFor(() => expect(screen.getByText(/Checks cannot be edited or deleted/)).toBeInTheDocument());
    expect(screen.getByText(/record a new check/)).toBeInTheDocument();
  });
});

describe('AssayerVettingTab — documents', () => {
  const paperwork = (over: Record<string, unknown>) => ({
    id: 'd-1',
    requirement: 'NDA',
    label: 'NDA',
    identity: false,
    filePaths: [],
    softCopyReceived: false,
    hardCopyReceived: false,
    hardCopyLocation: null,
    ...over,
  });

  it('does not call a spreadsheet tick a scan', async () => {
    serve(dossier({ onboarding: [paperwork({ softCopyReceived: true })] }));

    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);

    await waitFor(() => expect(screen.getByText(/Claimed on the old sheet — no scan/)).toBeInTheDocument());
    // The header counts evidence and the claim separately, so a roster with no files does not
    // read as collected.
    expect(screen.getByText(/0 of 1 have a scan on file/)).toBeInTheDocument();
    expect(screen.getByText(/1 other was ticked as received on the old roster sheet/)).toBeInTheDocument();
    // Never a green "Yes" — that is what made 10,977 empty rows read as collected.
    expect(screen.queryByText('Yes')).not.toBeInTheDocument();
  });

  it('counts a row with a file as having a scan, and says nothing about claims', async () => {
    serve(dossier({ onboarding: [paperwork({ softCopyReceived: true, filePaths: ['nda/1.pdf'] })] }));

    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);

    await waitFor(() => expect(screen.getByText(/1 of 1 have a scan on file/)).toBeInTheDocument());
    expect(screen.queryByText(/ticked as received on the old roster sheet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Claimed on the old sheet/)).not.toBeInTheDocument();
  });

  it('asks for a scan in words a clerk holding a photocopy would look for', async () => {
    serve(dossier({ onboarding: [paperwork({})] }));

    render(<AssayerVettingTab assayerId="a-1" canManage section="documents" />);

    // Was "Attach" (email vocabulary) and "Original in" (filing-room shorthand for a toggle).
    await waitFor(() => expect(screen.getByText(/Upload scan/)).toBeInTheDocument());
    expect(screen.getByText('Signed paper is here')).toBeInTheDocument();
    expect(screen.queryByText(/^Attach$/)).not.toBeInTheDocument();
  });
});
