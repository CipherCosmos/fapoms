import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BackgroundJobSummary } from '@fapoms/shared';

import { AssayerRoster } from './AssayerRoster';
import { api } from '../../services/api';

/**
 * The roster import as the page runs it now: a background job (`ROSTER_IMPORT`) the server keeps.
 *
 * Every import is rehearsed first. The upload goes to `POST /assayers/roster/import` with the
 * rehearsal flag in the job's params and is answered at once; the rehearsal (the whole import,
 * rolled back) runs on the server and ends waiting for review; the page shows what it would do and
 * offers the import, which commits the reviewed rehearsal (`POST /jobs/:id/commit`).
 *
 * The point of the move is that none of this lives in the tab: after a refresh or a hard refresh the
 * page reads `GET /jobs` and shows the same run — still going, or still waiting for its answer. The
 * hook and the job card are real; only the network, the socket and the confirm dialog are stubbed.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../services/socket', () => ({
  connectSocket: () => null,
  subscribeToConnection: (cb: (live: boolean) => void) => { cb(true); return () => undefined; },
}));
jest.mock('../../hooks/useCurrentRoles', () => ({
  ...jest.requireActual('../../hooks/useCurrentRoles'),
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

const JOBS_URL = '/jobs?status=active%2Crecent&kind=ROSTER_IMPORT&scopeType=ROSTER&limit=5';

const summary = (dryRun: boolean) => ({
  rowsRead: 1155, created: 40, updated: 1115, skipped: 2, references: 0, onboardingDocuments: 0,
  backgroundChecks: 0, empanelments: 0, issues: 3, notes: ['ICICI will be created as a client.'], dryRun,
});

const job = (over: Partial<BackgroundJobSummary> = {}): BackgroundJobSummary => ({
  id: 'job-r',
  kind: 'ROSTER_IMPORT',
  status: 'RUNNING',
  title: 'Check 1,155 roster row(s) from roster.xlsx',
  requestedBy: 'u-1',
  scopeType: 'ROSTER',
  scopeId: null,
  progress: { processed: 400, total: 1155, percent: 34, stage: 'Checking rows', message: null },
  result: null,
  error: null,
  inputFileName: 'roster.xlsx',
  inputSize: 2048,
  parentJobId: null,
  cancelRequested: false,
  hasResultFile: false,
  resultFileName: null,
  createdAt: '2026-09-24T10:00:00.000Z',
  startedAt: '2026-09-24T10:00:01.000Z',
  finishedAt: null,
  updatedAt: '2026-09-24T10:01:00.000Z',
  ...over,
});

const awaitingReview = () => job({
  status: 'AWAITING_REVIEW',
  progress: { processed: 1155, total: 1155, percent: 100, stage: 'Needs your review', message: null },
  result: { summary: 'Checked 1,155 row(s).', counts: { rowsRead: 1155 }, details: summary(true) },
  finishedAt: '2026-09-24T10:05:00.000Z',
});

/** Answers the page's reads; `/jobs` for this page's own roster jobs comes from `jobs`. */
const serve = (initial: { active: BackgroundJobSummary[]; recent: BackgroundJobSummary[] }) => {
  let jobs = initial;
  mockRequest.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    if (url === JOBS_URL) return Promise.resolve(jobs);
    if (url.startsWith('/jobs/') && url.endsWith('/commit') && init?.method === 'POST') {
      // As the server does: a child job starts, and the rehearsal it was reviewed from is closed.
      const child = job({
        id: 'job-i', parentJobId: 'job-r', status: 'QUEUED', title: 'Import 1,155 roster row(s) from roster.xlsx',
        progress: { processed: 0, total: 1155, percent: 0, stage: 'Waiting to start', message: null },
        createdAt: '2026-09-24T10:06:00.000Z', updatedAt: '2026-09-24T10:06:00.000Z', startedAt: null,
      });
      jobs = { active: [child], recent: [{ ...jobs.active[0], status: 'SUCCEEDED', updatedAt: '2026-09-24T10:06:00.000Z' }] };
      return Promise.resolve({ job: child, deduplicated: false });
    }
    if (url.startsWith('/jobs')) return Promise.resolve({ active: [], recent: [] });
    return Promise.resolve({ data: [], meta: { pagination: { total: 0 } } });
  });
};

const mount = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><AssayerRoster /></MemoryRouter></QueryClientProvider>);
};

beforeEach(() => {
  mockRequest.mockReset();
  mockConfirm.mockReset();
});

/** A controllable XMLHttpRequest — the upload goes by XHR so it can report real progress. */
class FakeXhr {
  static last: FakeXhr | null = null;
  upload: { onprogress: unknown } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = '';
  url = '';
  body: FormData | null = null;
  open(_method: string, url: string) { this.url = url; }
  setRequestHeader() { /* the token */ }
  send(body: FormData) { this.body = body; FakeXhr.last = this; }
  abort() { this.onabort?.(); }
  respond(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.(); }
}

describe('AssayerRoster — uploading a roster', () => {
  const realXhr = global.XMLHttpRequest;
  beforeEach(() => { (global as any).XMLHttpRequest = FakeXhr; FakeXhr.last = null; });
  afterEach(() => { (global as any).XMLHttpRequest = realXhr; });

  it('uploads for a REHEARSAL, with the flags in the job params the route reads, and shows the accepted job', async () => {
    serve({ active: [], recent: [] });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /^Import$/ }));
    const input = await waitFor(() => {
      const el = document.querySelector('input[type="file"]');
      expect(el).not.toBeNull();
      return el as HTMLInputElement;
    });
    fireEvent.change(input, { target: { files: [new File(['xlsx'], 'roster.xlsx')] } });

    await waitFor(() => expect(FakeXhr.last).not.toBeNull());
    const xhr = FakeXhr.last!;
    expect(xhr.url).toBe('/api/v1/assayers/roster/import');
    expect(xhr.body!.get('kind')).toBe('ROSTER_IMPORT');
    expect(xhr.body!.get('scopeType')).toBe('ROSTER');
    expect(JSON.parse(String(xhr.body!.get('params')))).toEqual({ dryRun: true, overwrite: false });
    expect((xhr.body!.get('file') as File).name).toBe('roster.xlsx');

    xhr.respond(202, { job: job({ status: 'QUEUED', progress: { processed: 0, total: 1155, percent: 0, stage: 'Waiting to start', message: null } }), deduplicated: false });

    expect(await screen.findByText('Check 1,155 roster row(s) from roster.xlsx')).toBeInTheDocument();
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});

describe('AssayerRoster — the roster import after a refresh', () => {
  it('shows a run still going on the server, read back from GET /jobs on mount', async () => {
    serve({ active: [job()], recent: [] });
    mount();

    expect(await screen.findByText('Check 1,155 roster row(s) from roster.xlsx')).toBeInTheDocument();
    expect(screen.getByText('Checking rows')).toBeInTheDocument();
    expect(screen.getByText(/400 of 1,155/)).toBeInTheDocument();
    expect(screen.getByText(/you can leave or refresh this page/)).toBeInTheDocument();
    expect(mockRequest).toHaveBeenCalledWith(JOBS_URL, expect.anything());
  });

  it('offers a rehearsal that finished while the page was closed, with what it would do', async () => {
    serve({ active: [awaitingReview()], recent: [] });
    mount();

    const review = await screen.findByTestId('roster-import-review');
    expect(review).toHaveTextContent('roster.xlsx was checked — nothing has been saved yet');
    expect(review).toHaveTextContent(/will add 40 and update 1,115 appraisers/);
    expect(review).toHaveTextContent(/2 row\(s\) without appraiser code will be skipped/);
    expect(review).toHaveTextContent('ICICI will be created as a client.');
    expect(screen.getByRole('button', { name: 'Import 1,155 appraisers' })).toBeInTheDocument();
  });

  it('imports only after the same confirmation, by committing the reviewed rehearsal as a real run', async () => {
    serve({ active: [awaitingReview()], recent: [] });
    mockConfirm.mockResolvedValue(true);
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Import 1,155 appraisers' }));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    expect(mockConfirm.mock.calls[0][0].title).toMatch(/Import 1,155 appraisers from this workbook/);
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/jobs/job-r/commit', expect.objectContaining({ method: 'POST' })));
    const [, init] = mockRequest.mock.calls.find(([url]) => url === '/jobs/job-r/commit')!;
    expect(JSON.parse(init.body)).toEqual({ params: { dryRun: false } });
    // The real run shows at once, from the commit's answer.
    expect(await screen.findByText('Import 1,155 roster row(s) from roster.xlsx')).toBeInTheDocument();
  });

  it('starts nothing when the operator backs out of the confirmation', async () => {
    serve({ active: [awaitingReview()], recent: [] });
    mockConfirm.mockResolvedValue(false);
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Import 1,155 appraisers' }));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    expect(mockRequest.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
  });

  /** A "check" the server ran for real must never be followed by an offer to import it again. */
  it('does not offer an import for a review whose result was not a rehearsal', async () => {
    serve({ active: [job({ ...awaitingReview(), result: { summary: 'x', details: summary(false) } })], recent: [] });
    mount();

    expect(await screen.findByText(/imported this workbook instead of only checking it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Import 1,155/ })).toBeNull();
  });

  it('says what a finished import did, in the page\'s own words', async () => {
    serve({
      active: [],
      recent: [job({
        id: 'job-i', parentJobId: 'job-r', status: 'SUCCEEDED', finishedAt: '2026-09-24T10:20:00.000Z',
        result: { summary: 'Roster imported.', details: summary(false) },
      })],
    });
    mount();

    expect(await screen.findByTestId('roster-import-outcome')).toHaveTextContent('Roster imported — 40 new, 1,115 updated.');
  });
});
