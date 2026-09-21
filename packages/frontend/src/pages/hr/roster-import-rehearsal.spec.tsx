import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { AssayerRoster } from './AssayerRoster';
import { api } from '../../services/api';

/**
 * The roster import's rehearsal, as the page runs it.
 *
 * It used to be one awaited `POST /assayers/roster/import?dryRun=true`. The server read `dryRun` from
 * the multipart body, not the URL, so that "rehearsal" was queued as a REAL import before anyone had
 * confirmed a thing — and its 202 carried no `rowsRead`, so the page then threw and showed an error
 * while the import ran. And a genuine rehearsal is the whole import rolled back: minutes for a full
 * roster, beyond the three-minute upload timeout. The rehearsal is now queued on the server and
 * followed here with the same hook the import uses.
 *
 * These pin the page to that: the flag goes where the server reads it, the import is offered only
 * once the queued rehearsal has actually answered, and a rehearsal that fails offers nothing.
 * The hook and the progress panel are real; only the network and the confirm dialog are stubbed.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../services/socket', () => ({ connectSocket: () => null }));
jest.mock('../../hooks/useCurrentRoles', () => ({
  useCurrentRoles: () => ['ADMIN'],
  canManageAssayers: () => true,
  canCreateAssayers: () => true,
}));
jest.mock('../../hooks/useQueuedExcelExport', () => ({ useQueuedExcelExport: () => ({ download: jest.fn(), busy: false }) }));
jest.mock('../../hooks/useClients', () => ({ useClientOptions: () => ({ data: [] }) }));
jest.mock('./ImportIssuesPanel', () => ({ ImportIssuesPanel: () => null }));
jest.mock('./registration/RegistrationWizard', () => ({ RegistrationWizard: () => null }));
const mockConfirm = jest.fn();
jest.mock('../../components/ui', () => {
  const actual = jest.requireActual('../../components/ui');
  return { ...actual, useConfirm: () => ({ confirm: mockConfirm, confirmDialog: null }) };
});

const mockRequest = api.request as jest.Mock;

const IMPORT_URL = '/assayers/roster/import';
const REHEARSAL_STATUS = '/assayers/roster/import-jobs/r-1';
const IMPORT_STATUS = '/assayers/roster/import-jobs/i-1';

const summary = (dryRun: boolean) => ({
  rowsRead: 2, created: 1, updated: 1, skipped: 0, references: 0, onboardingDocuments: 0,
  backgroundChecks: 0, empanelments: 0, issues: 0, notes: [], dryRun,
});

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

/** The two POSTs to the import route, in order, as the multipart bodies the page sent. */
const importPosts = () =>
  mockRequest.mock.calls.filter(([url]) => String(url).startsWith(IMPORT_URL) && !String(url).includes('import-jobs'));

/**
 * Answers the import route as the server now does — 202 and a job to watch, for a rehearsal and an
 * import alike — and hands each job's status read to `status`.
 */
const serve = (status: (url: string) => Promise<unknown>) => {
  mockRequest.mockImplementation((url: string, init?: { method?: string; body?: FormData }) => {
    if (url === IMPORT_URL && init?.method === 'POST') {
      const rehearsal = init.body?.get('dryRun') === 'true';
      return Promise.resolve({
        queued: true, jobId: rehearsal ? 'r-1' : 'i-1', statusUrl: rehearsal ? REHEARSAL_STATUS : IMPORT_STATUS,
        totalRows: 2, message: rehearsal ? 'Checking what importing it would do.' : 'Importing in the background.',
      });
    }
    if (url.startsWith('/assayers/roster/import-jobs/')) return status(url);
    return Promise.resolve({ data: [], meta: { pagination: { total: 0 } } });
  });
};

const uploadWorkbook = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><MemoryRouter><AssayerRoster /></MemoryRouter></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /^Import$/ }));
  const input = await waitFor(() => {
    const el = document.querySelector('input[type="file"]');
    expect(el).not.toBeNull();
    return el as HTMLInputElement;
  });
  fireEvent.change(input, { target: { files: [new File(['xlsx'], 'roster.xlsx')] } });
};

beforeEach(() => {
  mockRequest.mockReset();
  mockConfirm.mockReset();
});

describe('AssayerRoster — rehearsing a roster import', () => {
  it('sends the rehearsal flag in the form, where the server reads it, not in the URL', async () => {
    serve(() => Promise.resolve({ state: 'active', progress: null, result: null, error: null, totalRows: 2 }));
    await uploadWorkbook();

    await waitFor(() => expect(importPosts()).toHaveLength(1));
    const [url, init] = importPosts()[0];
    expect(url).toBe(IMPORT_URL);
    expect(init.body.get('dryRun')).toBe('true');
    expect(init.body.get('overwrite')).toBe('false');
  });

  it('offers the import only once the queued rehearsal has answered, then queues the real import', async () => {
    const rehearsalAnswer = deferred<unknown>();
    serve((url) => (url === REHEARSAL_STATUS
      ? rehearsalAnswer.promise
      : Promise.resolve({ state: 'completed', progress: null, result: summary(false), error: null, totalRows: 2 })));
    mockConfirm.mockResolvedValue(true);
    await uploadWorkbook();

    // Accepted and running on the server — worded as a check, and nothing offered yet.
    expect(await screen.findByText(/Checking roster\.xlsx/)).toBeInTheDocument();
    expect(mockConfirm).not.toHaveBeenCalled();

    rehearsalAnswer.resolve({ state: 'completed', progress: null, result: summary(true), error: null, totalRows: 2 });

    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    expect(mockConfirm.mock.calls[0][0].title).toMatch(/Import 2 appraisers/);
    await waitFor(() => expect(importPosts()).toHaveLength(2));
    expect(importPosts()[1][1].body.get('dryRun')).toBeNull();
  });

  it('offers nothing when the rehearsal fails, and shows the reason it failed', async () => {
    serve(() => Promise.resolve({
      state: 'failed', progress: null, result: null, error: 'This does not look like the appraiser roster.', totalRows: 2,
    }));
    await uploadWorkbook();

    expect(await screen.findByText(/could not be checked/)).toBeInTheDocument();
    expect(screen.getByText(/does not look like the appraiser roster/)).toBeInTheDocument();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(importPosts()).toHaveLength(1);
  });

  /** A "check" that the server ran for real must never be followed by an offer to import it again. */
  it('does not offer a second import when the check came back as a real import', async () => {
    serve(() => Promise.resolve({ state: 'completed', progress: null, result: summary(false), error: null, totalRows: 2 }));
    await uploadWorkbook();

    expect(await screen.findByText(/imported this workbook instead of only checking it/)).toBeInTheDocument();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(importPosts()).toHaveLength(1);
  });
});
