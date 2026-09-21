import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

import { Documents } from './Documents';
import { api } from '../services/api';
import { waitForQueuedJob } from '../services/queued-job';

/**
 * The Documents page's batch dispatch, now that it is a background job.
 *
 * `POST /documents/dispatch-batch` used to email every document to the branch inside the request.
 * Thirty of them outlived this client's 30-second timeout, so the page said "failed" while the server
 * kept sending, and Send again emailed the branch a second copy. The route now answers 202
 * `{ jobId }` and the page follows `/documents/dispatch-batch/:jobId`. These hold the page to that
 * shape: it must not read the outcome off the POST (it is not there any more), it must show where
 * the batch has got to while it runs, it must name each document that did not go and why, and it
 * must report the job's own failure in words.
 */

jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../services/socket', () => ({ connectSocket: () => null, getSocket: () => null }));
jest.mock('../services/http', () => ({ fetchWithTimeout: jest.fn() }));
jest.mock('../hooks/useCurrentRoles', () => ({
  useCurrentRoles: () => ['DESK'],
  useCurrentPermissions: () => [],
  canReadCustomerMaster: () => false,
  hasAnyRole: () => true,
}));
jest.mock('../components/LoadFailure', () => ({ LoadFailure: () => null, caughtLoad: jest.fn() }));
jest.mock('./CustomerMasterVersions', () => ({ CustomerMasterVersions: () => null }));
jest.mock('./documents/DailyRunPanel', () => ({ DailyRunPanel: () => null }));
jest.mock('./documents/DocumentControlPanel', () => ({ DocumentControlPanel: () => null }));
jest.mock('./documents/DocumentModelLegend', () => ({ DocumentModelLegend: () => null }));
// The branch view is the one this role lands on; its Send button is all these tests need of it.
jest.mock('./documents/BranchDocumentPanel', () => ({
  BranchDocumentPanel: ({ onDispatch }: { onDispatch: (ids: string[]) => Promise<void> }) => (
    <button type="button" onClick={() => { void onDispatch(['d-1', 'd-2']); }}>Send both</button>
  ),
}));
// The address prompt answers as a desk operator typing the branch's address would.
jest.mock('../components/ui', () => {
  const actual = jest.requireActual('../components/ui');
  return {
    ...actual,
    useConfirm: () => ({
      confirm: jest.fn().mockResolvedValue(true),
      confirmWithReason: jest.fn().mockResolvedValue({ confirmed: true, reason: 'manager@bank.example' }),
      confirmDialog: null,
    }),
  };
});
// The real poller, watched, with a short interval so the test is not waiting 1.5 s per read.
jest.mock('../services/queued-job', () => {
  const actual = jest.requireActual('../services/queued-job');
  return {
    ...actual,
    waitForQueuedJob: jest.fn((path: string, opts: Record<string, unknown> = {}) =>
      actual.waitForQueuedJob(path, { ...opts, pollMs: 10 })),
  };
});

const mockRequest = api.request as jest.Mock;
const mockWait = waitForQueuedJob as jest.Mock;

const row = (id: string, fileName: string, branchName: string, projectBranchId: string) => ({
  id, fileName, branchName, projectBranchId, fileSize: 1, type: 'PRE_FIELD_AUDIT_PDF', status: 'UPLOADED',
  createdAt: '2026-09-17T00:00:00Z', assessmentId: null, solId: null, projectName: null, clientName: null,
  scheduledDate: null, trail: {},
});
const overview = {
  documents: [row('d-1', 'kolhapur.pdf', 'Kolhapur Main', 'pb-1'), row('d-2', 'sangli.pdf', 'Sangli', 'pb-2')],
  pipeline: [], totals: {}, awaitingDispatch: [], blockingFieldWork: [], branches: [], neverPrepared: [],
  branchPagination: { page: 1, limit: 25, total: 0 }, documentPagination: { page: 1, limit: 25, total: 2 },
};

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

type Route = (url: string, init?: { method?: string; body?: string }) => Promise<unknown> | undefined;

/** Serves the page's own reads, and hands every other request to `route`. */
const serve = (route: Route) => {
  mockRequest.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    if (url === '/projects') return Promise.resolve([]);
    if (url.startsWith('/documents/operations/overview')) {
      return Promise.resolve({ data: overview, meta: { pagination: { total: 0 } } });
    }
    return route(url, init) ?? Promise.reject(new Error(`not served: ${url}`));
  });
};

const overviewLoads = () => mockRequest.mock.calls.filter(([url]) => String(url).startsWith('/documents/operations/overview')).length;

beforeEach(() => {
  mockRequest.mockReset();
  mockWait.mockClear();
});

const openAndSend = async () => {
  render(<Documents />);
  fireEvent.click(await screen.findByRole('button', { name: 'Send both' }));
};

describe('Documents — batch dispatch', () => {
  it('follows the queued batch, shows its progress, and names each document that did not go', async () => {
    const secondPoll = deferred<unknown>();
    let polls = 0;
    serve((url, init) => {
      if (url === '/documents/dispatch-batch' && init?.method === 'POST') {
        return Promise.resolve({ jobId: 'job-7', deduplicated: false });
      }
      if (url === '/documents/dispatch-batch/job-7') {
        polls += 1;
        if (polls === 1) {
          return Promise.resolve({ jobId: 'job-7', state: 'running', progress: { percent: 50, stage: 'Emailing documents to the branch (1/2)' } });
        }
        return secondPoll.promise;
      }
      return undefined;
    });

    await openAndSend();

    expect(await screen.findByText('Emailing documents to the branch (1/2)…')).toBeTruthy();
    const post = mockRequest.mock.calls.find(([url, init]) => url === '/documents/dispatch-batch' && init?.method === 'POST');
    expect(JSON.parse(post![1].body)).toEqual({ documentIds: ['d-1', 'd-2'], branchEmail: 'manager@bank.example' });
    expect(mockWait).toHaveBeenCalledWith('/documents/dispatch-batch/job-7', expect.any(Object));
    const loadsBeforeDone = overviewLoads();

    secondPoll.resolve({
      jobId: 'job-7', state: 'done', progress: { percent: 100, stage: 'Complete' },
      result: { dispatched: ['d-1'], failed: [{ documentId: 'd-2', reason: 'Mailbox unavailable' }] },
    });

    expect(await screen.findByText(/Sent 1 of 2 documents to manager@bank\.example\. 1 did not go:/)).toBeTruthy();
    expect(screen.getByTestId('dispatch-failures').textContent).toBe('sangli.pdf (Sangli): Mailbox unavailable');
    expect(screen.queryByTestId('dispatch-progress')).toBeNull();
    // The list is re-read once the batch is done, so the page shows which packets actually left.
    await waitFor(() => expect(overviewLoads()).toBeGreaterThan(loadsBeforeDone));
  });

  it('says every document went when the batch sent them all', async () => {
    serve((url, init) => {
      if (url === '/documents/dispatch-batch' && init?.method === 'POST') return Promise.resolve({ jobId: 'job-8', deduplicated: false });
      if (url === '/documents/dispatch-batch/job-8') {
        return Promise.resolve({ jobId: 'job-8', state: 'done', progress: { percent: 100, stage: 'Complete' }, result: { dispatched: ['d-1', 'd-2'], failed: [] } });
      }
      return undefined;
    });

    await openAndSend();

    expect(await screen.findByText('Sent 2 documents to manager@bank.example.')).toBeTruthy();
    expect(screen.queryByTestId('dispatch-failures')).toBeNull();
  });

  it("reports the job's own failure in its words", async () => {
    serve((url, init) => {
      if (url === '/documents/dispatch-batch' && init?.method === 'POST') return Promise.resolve({ jobId: 'job-9', deduplicated: false });
      if (url === '/documents/dispatch-batch/job-9') {
        return Promise.resolve({ jobId: 'job-9', state: 'failed', progress: { percent: 40, stage: 'Failed' }, error: 'The queue is no longer tracking this job.' });
      }
      return undefined;
    });

    await openAndSend();

    expect(await screen.findByText(/The queue is no longer tracking this job\./)).toBeTruthy();
  });
});
