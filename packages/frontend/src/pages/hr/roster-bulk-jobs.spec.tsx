import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AssayerLifecycleStatus } from '@fapoms/shared';

import { AssayerRoster } from './AssayerRoster';
import { api } from '../../services/api';
import { waitForQueuedJob } from '../../services/queued-job';

/**
 * The roster's bulk credential and notify runs, now that they are background jobs.
 *
 * `POST /assayers/app-access/bulk` used to do the whole run inside the request — about half an hour
 * for 540 people — while the browser gave up at 30 s and told the clerk it had failed, so they ran
 * it again and people got two sets of credentials. The routes now answer 202 `{ jobId }` and the
 * roster polls `/assayers/bulk-jobs/:jobId`. These tests hold the page to that shape: it must not
 * read the three result buckets off the POST (they are not there any more, so it would report
 * "0 people"), it must show where the run has got to while it runs, it must report the job's own
 * failure in words, and it must follow the emails and texts the run queued instead of calling them
 * sent.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../services/socket', () => ({ connectSocket: () => null }));
// The roster import's background-job hook reads `GET /jobs`; this suite is not about the import
// (roster-import-rehearsal.spec.tsx is), so the page sees no roster job.
jest.mock('../../hooks/useBackgroundJob', () => ({
  useBackgroundJob: () => ({
    job: null, active: [], recent: [], isLoading: false, upload: { phase: 'idle' },
    start: jest.fn(), abortUpload: jest.fn(), cancel: jest.fn(), commit: jest.fn(),
    downloadResult: jest.fn(), resetUpload: jest.fn(),
  }),
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
// The roster's own "are you sure?" auto-confirms; the toolbar's dialog (imported directly from
// ConfirmDialog) stays real and is clicked through, as the clerk would.
jest.mock('../../components/ui', () => {
  const actual = jest.requireActual('../../components/ui');
  return { ...actual, useConfirm: () => ({ confirm: jest.fn().mockResolvedValue(true), confirmDialog: null }) };
});
// The real poller, watched, with a short interval so the test is not waiting 1.5 s per read.
jest.mock('../../services/queued-job', () => {
  const actual = jest.requireActual('../../services/queued-job');
  return {
    ...actual,
    waitForQueuedJob: jest.fn((path: string, opts: Record<string, unknown> = {}) =>
      actual.waitForQueuedJob(path, { ...opts, pollMs: 10 })),
  };
});

const mockRequest = api.request as jest.Mock;
const mockWait = waitForQueuedJob as jest.Mock;

const person = (id: string, code: string, name: string) => ({
  id, assayerCode: code, displayName: name, phone: '+919000000000', email: `${id}@example.in`,
  city: 'Kochi', district: 'Ernakulam', state: 'Kerala', latitude: 9.9, longitude: 76.2,
  panNumber: 'ABCDE1234F', bankAccountNumber: '000111222333', ifscCode: 'HDFC0000001',
  joiningDate: '2024-01-01', emergencyContactPhone: '+919000000001',
  lifecycleStatus: AssayerLifecycleStatus.ACTIVE, employmentType: 'INTERNAL', experienceYears: 4,
  skills: ['Gold'], exitDate: null, terminationDate: null,
});
const roster = [person('b-1', 'AS0201', 'Bulk One'), person('b-2', 'AS0202', 'Bulk Two')];

type Route = (url: string, init?: { method?: string; body?: string }) => Promise<unknown> | undefined;

/** Serves the roster read, and hands every other request to `route`. */
const serve = (route: Route) => {
  mockRequest.mockImplementation((url: string, init?: { method?: string; body?: string }) =>
    route(url, init) ?? Promise.resolve({ data: roster, meta: { pagination: { total: roster.length } } }));
};

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

const renderRoster = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><MemoryRouter><AssayerRoster /></MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect(screen.getByText('Bulk Two')).toBeInTheDocument());
  for (const name of ['Bulk One', 'Bulk Two']) {
    fireEvent.click(within(screen.getByText(name).closest('tr') as HTMLElement).getByRole('checkbox'));
  }
};

const callsTo = (url: string) => mockRequest.mock.calls.filter(([u]) => u === url);

beforeEach(() => {
  mockRequest.mockReset();
  mockWait.mockClear();
});

describe('AssayerRoster — issuing app access in bulk', () => {
  const issue = async () => {
    fireEvent.click(screen.getByRole('button', { name: /Issue App Access/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Give app access' }));
  };

  it('enqueues the run, shows its progress, then reports the job\'s result and follows the emails and texts it queued', async () => {
    const secondRead = deferred<unknown>();
    let reads = 0;
    serve((url, init) => {
      if (url === '/assayers/app-access/bulk') {
        expect(init?.method).toBe('POST');
        return Promise.resolve({ jobId: 'job-7', deduplicated: false });
      }
      if (url === '/assayers/bulk-jobs/job-7') {
        reads += 1;
        if (reads === 1) {
          return Promise.resolve({ jobId: 'job-7', state: 'running', progress: { percent: 50, stage: 'Issued 1 of 2' } });
        }
        return secondRead.promise;
      }
      if (url === '/outbound-messages?ids=em-1,em-2') {
        return Promise.resolve([
          { id: 'em-1', channel: 'EMAIL', status: 'SENT', to: 'b-1@example.in' },
          { id: 'em-2', channel: 'EMAIL', status: 'SENT', to: 'b-2@example.in' },
        ]);
      }
      if (url === '/outbound-messages?ids=sm-1') {
        return Promise.resolve([{ id: 'sm-1', channel: 'SMS', status: 'SENT', to: '+919000000000' }]);
      }
      return undefined;
    });
    await renderRoster();
    await issue();

    await waitFor(() => expect(screen.getByTestId('bulk-progress')).toHaveTextContent('Issued 1 of 2…'));
    expect(screen.getByTestId('bulk-progress')).toHaveTextContent('It runs on the server');
    expect(JSON.parse(callsTo('/assayers/app-access/bulk')[0][1].body).ids.sort()).toEqual(['b-1', 'b-2']);
    expect(mockWait).toHaveBeenCalledWith('/assayers/bulk-jobs/job-7', expect.objectContaining({ onProgress: expect.any(Function) }));

    secondRead.resolve({
      jobId: 'job-7', state: 'done', progress: { percent: 100, stage: 'Done' },
      result: {
        succeeded: [
          { id: 'b-1', channels: ['EMAIL', 'SMS'], emailId: 'em-1', smsId: 'sm-1' },
          { id: 'b-2', channels: ['EMAIL'], emailId: 'em-2' },
        ],
        skipped: [], failed: [],
      },
    });

    // A text on the outbound ledger is queued exactly as an email is, so it is counted the same way.
    expect(await screen.findByText('Issued app access to 2 people (2 emails queued, 1 texts queued).')).toBeInTheDocument();
    expect(screen.queryByTestId('bulk-progress')).not.toBeInTheDocument();
    // Queued is not sent: each batch line starts at zero and moves when the server says so.
    const batchLine = (words: RegExp) => screen.getAllByTestId('email-batch').find((el) => words.test(el.textContent ?? ''));
    expect(batchLine(/credential emails/)).toHaveTextContent('0 of 2 credential emails emailed · 2 still sending…');
    expect(batchLine(/credential texts/)).toHaveTextContent('0 of 1 credential texts texted · 1 still sending…');
    await waitFor(() => expect(batchLine(/credential emails/)).toHaveTextContent('2 of 2 credential emails emailed'));
    await waitFor(() => expect(batchLine(/credential texts/)).toHaveTextContent('1 of 1 credential texts texted'));
    const pollUrls = mockRequest.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/outbound-messages?ids='));
    expect(new Set(pollUrls)).toEqual(new Set(['/outbound-messages?ids=em-1,em-2', '/outbound-messages?ids=sm-1']));
  });

  it('reports the job\'s own failure in its words, and shows no progress or email line after', async () => {
    serve((url) => {
      if (url === '/assayers/app-access/bulk') return Promise.resolve({ jobId: 'job-8', deduplicated: true });
      if (url === '/assayers/bulk-jobs/job-8') {
        return Promise.resolve({ jobId: 'job-8', state: 'failed', progress: { percent: 10, stage: 'Issuing' }, error: 'The credential worker crashed.' });
      }
      return undefined;
    });
    await renderRoster();
    await issue();

    expect(await screen.findByText(/Failed to issue app access\. .*The credential worker crashed/)).toBeInTheDocument();
    expect(screen.queryByTestId('bulk-progress')).not.toBeInTheDocument();
    expect(screen.queryByTestId('email-batch')).not.toBeInTheDocument();
  });

  it('lists who was skipped or failed, and follows only the messages that were queued', async () => {
    serve((url) => {
      if (url === '/assayers/app-access/bulk') return Promise.resolve({ jobId: 'job-9', deduplicated: false });
      if (url === '/assayers/bulk-jobs/job-9') {
        return Promise.resolve({
          jobId: 'job-9', state: 'done', progress: { percent: 100, stage: 'Done' },
          result: {
            succeeded: [{ id: 'b-1', channels: ['SMS'], smsId: 'sm-9' }],
            skipped: [{ id: 'b-2', reason: 'No email or mobile on record' }],
            failed: [],
          },
        });
      }
      return undefined;
    });
    await renderRoster();
    await issue();

    expect(await screen.findByText('Issued credentials to 1 (0 emails queued, 1 texts queued), 1 skipped, 0 failed.')).toBeInTheDocument();
    expect(screen.getByText(/No email or mobile on record/)).toBeInTheDocument();
    // No email was queued, so there is no email line — only the one text is followed.
    const lines = screen.getAllByTestId('email-batch');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent('credential texts texted');
  });
});

describe('AssayerRoster — notifying in bulk', () => {
  it('enqueues the message, waits on the job, and follows the emails it queued', async () => {
    serve((url) => {
      if (url === '/assayers/bulk/notify') return Promise.resolve({ jobId: 'job-n1', deduplicated: false });
      if (url === '/assayers/bulk-jobs/job-n1') {
        return Promise.resolve({
          jobId: 'job-n1', state: 'done', progress: { percent: 100, stage: 'Done' },
          result: {
            succeeded: [
              { id: 'b-1', channels: ['IN_APP', 'EMAIL'], emailId: 'em-9' },
              { id: 'b-2', channels: ['IN_APP'] },
            ],
            skipped: [], failed: [],
          },
        });
      }
      if (url.startsWith('/outbound-messages?ids=')) return new Promise(() => undefined);
      return undefined;
    });
    await renderRoster();

    fireEvent.click(screen.getByRole('button', { name: /Notify/ }));
    fireEvent.change(await screen.findByPlaceholderText('e.g. Update your bank details'), { target: { value: 'Bank details' } });
    fireEvent.change(screen.getByPlaceholderText('What do you want them to know or do?'), { target: { value: 'Please update them.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Also send by email/ }));
    fireEvent.click(screen.getByRole('button', { name: /Send to 2/ }));

    expect(await screen.findByText('Notified 2 people (2 in-app, 1 emails queued).')).toBeInTheDocument();
    const body = JSON.parse(callsTo('/assayers/bulk/notify')[0][1].body);
    expect(body).toMatchObject({ subject: 'Bank details', body: 'Please update them.', sendEmail: true });
    expect(body.ids.sort()).toEqual(['b-1', 'b-2']);
    expect(mockWait).toHaveBeenCalledWith('/assayers/bulk-jobs/job-n1', expect.anything());
    expect(screen.getByTestId('email-batch')).toHaveTextContent('0 of 1 messages emailed · 1 still sending…');
  });
});
