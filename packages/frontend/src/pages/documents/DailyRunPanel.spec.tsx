import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BackgroundJobSummary } from '@fapoms/shared';
import { DailyRunPanel, type DailyRun } from './DailyRunPanel';
import { ToastProvider } from '../../components/ui/Toast';
import { api } from '../../services/api';

/**
 * THE DAY'S TWO UPLOADS SURVIVE A REFRESH.
 *
 * The client's customer-master file and the day's packets each run as a background job on the
 * server. The board reads them back from `GET /jobs` when it mounts, so a refresh — or a hard
 * refresh — halfway through a reconciliation shows its progress again, and a finished packet batch
 * still lists the files that could not be placed. Nothing comes from the browser's memory.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

jest.mock('../../services/socket', () => ({
  connectSocket: () => null,
  subscribeToConnection: (cb: (live: boolean) => void) => { cb(true); return () => undefined; },
}));

const PROJECT = 'p-1';
const DATE = '2026-09-25';

const job = (over: Partial<BackgroundJobSummary>): BackgroundJobSummary => ({
  id: 'job-1',
  kind: 'CUSTOMER_MASTER_IMPORT',
  status: 'QUEUED',
  title: 'job',
  requestedBy: 'u-1',
  scopeType: 'PROJECT',
  scopeId: PROJECT,
  progress: { processed: 0, total: null, percent: null, stage: 'Waiting to start', message: null },
  result: null,
  error: null,
  inputFileName: 'client.xlsx',
  inputSize: 10,
  parentJobId: null,
  cancelRequested: false,
  hasResultFile: false,
  resultFileName: null,
  createdAt: '2026-09-24T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  updatedAt: '2026-09-24T10:00:00.000Z',
  ...over,
});

const dailyRun: DailyRun = {
  projectId: PROJECT,
  auditDate: DATE,
  batch: null,
  summary: {
    scheduledBranches: 2, inBatch: 0, awaitingClientData: 2, toGenerate: 2, toDispatch: 0,
    awaitingReturn: 0, toSendToOcr: 0, unexpectedBranchesInBatch: 0,
  },
  branches: [
    {
      projectBranchId: 'pb-1', branchId: 'b-1', branchName: 'Kolhapur Main', solId: 'SOL001', inBatch: false,
      customerCount: 0, packetCount: 0, pdf: null, nextAction: 'GENERATE_PDF' as any,
    },
  ],
};

const runningImport = job({
  id: 'cm-1',
  status: 'RUNNING',
  progress: { processed: 600, total: 1200, percent: 50, stage: 'Matching rows to branches', message: null },
});

const finishedBatch = (auditDate = DATE) => job({
  id: 'gb-1',
  kind: 'GENERATED_DOCUMENT_BATCH',
  status: 'SUCCEEDED',
  inputFileName: '3 files',
  finishedAt: '2026-09-24T10:05:00.000Z',
  result: {
    summary: 'Filed 1 of 3 packet(s). 1 could not be matched to a branch. 1 could not be filed.',
    counts: { files: 3, created: 1, unmatched: 1, failed: 1 },
    details: {
      auditDate,
      created: [{ documentId: 'd-1', fileName: 'SOL001.pdf', branchName: 'Kolhapur Main' }],
      unmatched: [{ fileName: 'mystery.pdf', reason: 'No scheduled branch matches this filename.' }],
      failed: [{ fileName: 'SOL002.pdf', reason: 'This file was rejected by malware scanning (Eicar).' }],
      branchesWithoutFile: [],
      branchesWithoutFileCount: 0,
    },
  },
});

function serve(jobs: { cm?: BackgroundJobSummary[]; batch?: BackgroundJobSummary[] }) {
  mockRequest.mockImplementation(async (url: string) => {
    if (url.startsWith('/customer-master/projects/')) return dailyRun;
    if (url.startsWith('/jobs?') && url.includes('kind=CUSTOMER_MASTER_IMPORT')) {
      const list = jobs.cm ?? [];
      return { active: list.filter((j) => j.status === 'RUNNING' || j.status === 'QUEUED'), recent: list.filter((j) => j.status === 'SUCCEEDED' || j.status === 'FAILED') };
    }
    if (url.startsWith('/jobs?') && url.includes('kind=GENERATED_DOCUMENT_BATCH')) {
      const list = jobs.batch ?? [];
      return { active: list.filter((j) => j.status === 'RUNNING' || j.status === 'QUEUED'), recent: list.filter((j) => j.status === 'SUCCEEDED' || j.status === 'FAILED') };
    }
    return { active: [], recent: [] };
  });
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <DailyRunPanel
          projectId={PROJECT}
          onDispatch={async () => undefined}
          onSendToOcr={async () => undefined}
          onDownload={() => undefined}
          onError={() => undefined}
          onSuccess={() => undefined}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** The board opens on tomorrow's date; pin it to the fixtures' date. */
async function pickDate() {
  const input = (await screen.findByTitle("Pick which audit date's daily run to show")) as HTMLInputElement;
  fireEvent.change(input, { target: { value: DATE } });
}

class FakeXhr {
  static last: FakeXhr | null = null;
  upload = { onprogress: null as any };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = '';
  url = '';
  body: FormData | null = null;
  open(_m: string, url: string) { this.url = url; }
  setRequestHeader() { /* the token */ }
  send(body: FormData) { this.body = body; FakeXhr.last = this; }
  abort() { this.onabort?.(); }
}
const realXhr = global.XMLHttpRequest;

beforeEach(() => {
  mockRequest.mockReset();
  FakeXhr.last = null;
  (global as any).XMLHttpRequest = FakeXhr;
});
afterEach(() => { (global as any).XMLHttpRequest = realXhr; });

describe('DailyRunPanel — background uploads', () => {
  it('after a refresh, shows the client file still reconciling, read from the server', async () => {
    serve({ cm: [runningImport] });
    mount();

    expect(await screen.findByText('Matching rows to branches')).toBeInTheDocument();
    expect(mockRequest).toHaveBeenCalledWith(
      '/jobs?status=active%2Crecent&kind=CUSTOMER_MASTER_IMPORT&scopeType=PROJECT&scopeId=p-1&limit=5',
      expect.anything(),
    );
    // The upload button waits for the run rather than inviting a second copy of the file.
    await pickDate();
    expect(await screen.findByText('Uploading…')).toBeInTheDocument();
  });

  it("after a refresh, a finished packet batch still lists the files it could not place, and why", async () => {
    serve({ batch: [finishedBatch()] });
    mount();
    await pickDate();

    expect(await screen.findByText(/1 file\(s\) could not be matched to a branch/)).toBeInTheDocument();
    expect(screen.getByText('mystery.pdf')).toBeInTheDocument();
    expect(screen.getByText(/No scheduled branch matches this filename/)).toBeInTheDocument();
    expect(screen.getByText('SOL002.pdf')).toBeInTheDocument();
    expect(screen.getByText(/rejected by malware scanning/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Dismiss'));
    expect(screen.queryByText('mystery.pdf')).not.toBeInTheDocument();
  });

  it("does not show another audit date's batch result on this date's board", async () => {
    serve({ batch: [finishedBatch('2026-09-30')] });
    mount();
    await pickDate();

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith(expect.stringContaining(`auditDate=${DATE}`)));
    expect(screen.queryByText('mystery.pdf')).not.toBeInTheDocument();
  });

  it('sends the packets as one set to the batch route, with the date and project as job parameters', async () => {
    serve({});
    const { container } = mount();
    await pickDate();
    await screen.findByText(/Upload all 2 packets together/);

    const input = container.querySelector('input[type="file"][multiple]') as HTMLInputElement;
    const files = [new File(['%PDF'], 'SOL001.pdf'), new File(['%PDF'], 'SOL002.pdf')];
    fireEvent.change(input, { target: { files } });

    await waitFor(() => expect(FakeXhr.last).not.toBeNull());
    const xhr = FakeXhr.last!;
    expect(xhr.url).toBe('/api/v1/documents/upload-generated-batch');
    expect(xhr.body!.get('kind')).toBe('GENERATED_DOCUMENT_BATCH');
    expect(xhr.body!.getAll('files')).toHaveLength(2);
    expect(JSON.parse(xhr.body!.get('params') as string)).toEqual({ projectId: PROJECT, auditDate: DATE, customerMasterVersionId: null });
  });
});
