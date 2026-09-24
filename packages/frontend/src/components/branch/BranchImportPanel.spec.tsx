import React from 'react';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BackgroundJobSummary, BranchReviewReport, BranchReviewRow } from '@fapoms/shared';
import { useBranchImport, type BranchImportScope } from '../../hooks/useBranchImport';
import { BranchImportPanel } from './BranchImportPanel';
import { ToastProvider } from '../ui/Toast';
import { api } from '../../services/api';
import { applyJobUpdate } from '../../services/background-jobs';

/**
 * A branch import as the page shows it — always rebuilt from the server. The cases are the owner's:
 * a refresh (or a hard refresh, or the next morning) must bring back the running job's progress or
 * the review that is waiting, and the commit must carry the person's decisions, not the rows.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;
jest.mock('../../services/socket', () => ({
  connectSocket: () => null,
  subscribeToConnection: (cb: (live: boolean) => void) => { cb(true); return () => undefined; },
}));
jest.mock('../geo/CoordinatePinModal', () => ({ CoordinatePinModal: () => null }));

const job = (over: Partial<BackgroundJobSummary> = {}): BackgroundJobSummary => ({
  id: 'r-1', kind: 'BRANCH_IMPORT', status: 'RUNNING', title: '3 branches for SBI', requestedBy: 'u-1',
  scopeType: 'CLIENT', scopeId: 'c-1',
  progress: { processed: 1200, total: 5000, percent: 24, stage: 'Locating 400 addresses', message: null },
  result: null, error: null, inputFileName: 'sbi.xlsx', inputSize: 10, parentJobId: null, cancelRequested: false,
  hasResultFile: false, resultFileName: null, createdAt: '2026-09-24T10:00:00.000Z', startedAt: null, finishedAt: null,
  updatedAt: '2026-09-24T10:00:00.000Z', ...over,
});

const reviewRow = (over: Partial<BranchReviewRow>): BranchReviewRow => ({
  rowNumber: 2, solId: 'S-1', name: 'Thenkurissi', state: 'Kerala', district: 'PALAKKAD', address: '1 Main Rd',
  latitude: 10.7, longitude: 76.6, geoSource: 'pincode', geoAccuracyMeters: 5000, existsInMaster: false,
  status: 'coarse', missingFields: [], ...over,
});

const REVIEW: BranchReviewReport = {
  version: 1,
  summary: { totalRows: 2, existingInMaster: 0, newBranches: 2, readyCount: 0, coarseCount: 1, needsDetailsCount: 1, clientMismatchCount: 0 },
  rows: [reviewRow({}), reviewRow({ rowNumber: 3, solId: 'S-2', state: undefined, status: 'needs_details', missingFields: ['state'] })],
  skipped: [{ row: 4, solId: 'S-1', reason: 'Duplicate of row 2 (SOL ID S-1) — the first row was kept.' }],
  notes: [],
};

const awaiting = () => job({
  status: 'AWAITING_REVIEW', hasResultFile: true, resultFileName: 'branch-review.json',
  result: { summary: 'Ready to review: 2 rows — 0 already known, 2 new, 1 missing details.', details: { phase: 'rehearse' } },
});

function serve(active: BackgroundJobSummary[]) {
  mockRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: string }) => {
    if (url.startsWith('/jobs?')) return { active, recent: [] };
    if (url === '/jobs/r-1/result') return new Blob([JSON.stringify(REVIEW)], { type: 'application/json' });
    if (opts?.method === 'POST') return { job: job({ id: 'c-1', parentJobId: 'r-1', status: 'QUEUED' }), deduplicated: false };
    throw new Error(`unexpected ${url}`);
  });
}

let client: QueryClient;
const Harness: React.FC<{ scope: BranchImportScope }> = ({ scope }) => {
  const handle = useBranchImport(scope);
  return <BranchImportPanel handle={handle} reviewTitle="Reconcile Branches: SBI" />;
};
function mount(scope: BranchImportScope = { type: 'CLIENT', id: 'c-1' }) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider><Harness scope={scope} /></ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => mockRequest.mockReset());

describe('a branch import after a refresh', () => {
  it('shows the running job\'s progress, read back from the server', async () => {
    serve([job()]);
    mount();
    expect(await screen.findByText('Locating 400 addresses')).toBeTruthy();
    expect(mockRequest).toHaveBeenCalledWith(expect.stringMatching(/^\/jobs\?.*kind=BRANCH_IMPORT.*scopeType=CLIENT.*scopeId=c-1/), expect.anything());
  });

  it('shows the waiting review — without throwing a dialog at someone who just arrived — and opens it on request', async () => {
    serve([awaiting()]);
    mount();
    expect(await screen.findByTestId('branch-review-ready')).toBeTruthy();
    expect(screen.queryByText('Reconcile Branches: SBI')).toBeNull();

    const open = await screen.findByRole('button', { name: 'Review & commit' });
    await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(open);
    expect(await screen.findByText('Reconcile Branches: SBI')).toBeTruthy();
    // The stored review, including what the rehearsal set aside.
    expect(screen.getByTestId('review-file-notes').textContent).toMatch(/row 4: Duplicate of row 2/);
  });

  it('opens the review by itself when a rehearsal the person was watching finishes', async () => {
    serve([job()]);
    mount();
    await screen.findByText('Locating 400 addresses');
    serve([awaiting()]);
    act(() => applyJobUpdate(client, { ...awaiting(), updatedAt: '2026-09-24T10:05:00.000Z' }));
    expect(await screen.findByText('Reconcile Branches: SBI')).toBeTruthy();
  });
});

describe('committing a review', () => {
  it('sends the decisions — removed rows, typed-over fields — to the client route, never the rows', async () => {
    serve([awaiting()]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review & commit' }).then(async (b) => {
      await waitFor(() => expect((b as HTMLButtonElement).disabled).toBe(false));
      return b;
    }));
    await screen.findByText('Reconcile Branches: SBI');
    fireEvent.click(await screen.findByRole('button', { name: /All Branches/ }));

    // Give row 3 its missing state, then commit everything valid.
    const stateInputs = screen.getAllByPlaceholderText(/state/i) as HTMLInputElement[];
    fireEvent.change(stateInputs[1], { target: { value: 'Kerala' } });
    fireEvent.click(screen.getByRole('button', { name: /Commit & Link All Valid/ }));

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/branches/import/c-1/jobs/r-1/commit', expect.objectContaining({ method: 'POST' })));
    const [, opts] = mockRequest.mock.calls.find(([url]) => url === '/branches/import/c-1/jobs/r-1/commit')!;
    expect(JSON.parse(opts.body)).toEqual({ decisions: { mode: 'all_valid', excluded: [], edits: { 3: { state: 'Kerala' } } } });
  });

  it('uses the project route for a project\'s import', async () => {
    serve([awaiting()]);
    mount({ type: 'PROJECT', id: 'p-1' });
    const b = await screen.findByRole('button', { name: 'Review & commit' });
    await waitFor(() => expect((b as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(b);
    await screen.findByText('Reconcile Branches: SBI');
    fireEvent.click(screen.getByRole('button', { name: /Commit & Link All Valid/ }));
    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/projects/p-1/branches/import/r-1/commit', expect.anything()));
  });
});

it('offers a retry over the same stored file when an import failed', async () => {
  serve([]);
  mockRequest.mockImplementation(async (url: string) => {
    if (url.startsWith('/jobs?')) return { active: [], recent: [job({ status: 'FAILED', error: 'The job stopped because of a database error.' })] };
    return { job: job({ id: 'r-2', status: 'QUEUED' }), deduplicated: false };
  });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Retry with the same file/ }));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('/branches/import/c-1/jobs/r-1/retry', expect.objectContaining({ method: 'POST' })));
});
