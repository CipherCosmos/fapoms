import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BackgroundJobSummary } from '@fapoms/shared';
import { useBackgroundJob } from './useBackgroundJob';
import { BackgroundJobPanel } from '../components/jobs/BackgroundJobPanel';
import { ToastProvider } from '../components/ui/Toast';
import { api } from '../services/api';

/**
 * A page's own upload: restored from the server after a refresh, a real upload bar while the bytes
 * travel (and a "leave the page?" prompt only then), and the job the instant the server has the
 * file.
 */

jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

jest.mock('../services/socket', () => ({
  connectSocket: () => null,
  subscribeToConnection: (cb: (live: boolean) => void) => { cb(true); return () => undefined; },
}));

/** A controllable XMLHttpRequest: the test decides when bytes move and when the server answers. */
class FakeXhr {
  static last: FakeXhr | null = null;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = '';
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: FormData | null = null;
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  send(body: FormData) { this.body = body; FakeXhr.last = this; }
  abort() { this.onabort?.(); }
  progress(loaded: number, total: number) { this.upload.onprogress?.({ lengthComputable: true, loaded, total }); }
  respond(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.(); }
}

const job = (over: Partial<BackgroundJobSummary> = {}): BackgroundJobSummary => ({
  id: 'job-9',
  kind: 'BRANCH_IMPORT',
  status: 'QUEUED',
  title: 'Branch import: sbi.xlsx',
  requestedBy: 'u-1',
  scopeType: 'CLIENT',
  scopeId: 'c-1',
  progress: { processed: 0, total: 5000, percent: 0, stage: 'Waiting to start', message: null },
  result: null,
  error: null,
  inputFileName: 'sbi.xlsx',
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

const Page: React.FC = () => {
  const handle = useBackgroundJob('BRANCH_IMPORT', { type: 'CLIENT', id: 'c-1' });
  return (
    <div>
      <button onClick={() => void handle.start(new File(['sol_id\n1'], 'sbi.xlsx'), { overwrite: true })}>upload</button>
      <span data-testid="phase">{handle.upload.phase}</span>
      <BackgroundJobPanel handle={handle} />
    </div>
  );
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <Page />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const realXhr = global.XMLHttpRequest;
beforeEach(() => {
  mockRequest.mockReset();
  FakeXhr.last = null;
  (global as any).XMLHttpRequest = FakeXhr;
  localStorage.setItem('fapoms_token', 'tok');
});
afterEach(() => {
  (global as any).XMLHttpRequest = realXhr;
  localStorage.clear();
});

describe('useBackgroundJob', () => {
  it('after a refresh, shows the job that is still running for this page — read from the server', async () => {
    mockRequest.mockResolvedValue({ active: [job({ status: 'RUNNING', progress: { processed: 2500, total: 5000, percent: 50, stage: 'Importing branches' } })], recent: [] });
    mount();
    expect(await screen.findByText('Importing branches')).toBeInTheDocument();
    expect(screen.getByText(/2,500 of 5,000/)).toBeInTheDocument();
    expect(screen.getByText(/you can leave or refresh this page/)).toBeInTheDocument();
    expect(mockRequest).toHaveBeenCalledWith(
      '/jobs?status=active%2Crecent&kind=BRANCH_IMPORT&scopeType=CLIENT&scopeId=c-1&limit=5',
      expect.anything(),
    );
  });

  it('uploads with a real progress bar, warns before leaving only while bytes travel, then shows the job', async () => {
    mockRequest.mockResolvedValue({ active: [], recent: [] });
    const addListener = jest.spyOn(window, 'addEventListener');
    const removeListener = jest.spyOn(window, 'removeEventListener');
    mount();
    await waitFor(() => expect(mockRequest).toHaveBeenCalled());

    fireEvent.click(screen.getByText('upload'));
    const xhr = FakeXhr.last!;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/v1/jobs');
    expect(xhr.headers.Authorization).toBe('Bearer tok');
    expect(xhr.body!.get('kind')).toBe('BRANCH_IMPORT');
    expect(xhr.body!.get('scopeType')).toBe('CLIENT');
    expect(xhr.body!.get('scopeId')).toBe('c-1');
    expect(xhr.body!.get('params')).toBe('{"overwrite":true}');
    expect(xhr.body!.get('file')).toBeInstanceOf(File);

    act(() => xhr.progress(40, 100));
    expect(screen.getByTestId('phase')).toHaveTextContent('uploading');
    expect(screen.getByRole('progressbar', { name: /Uploading sbi.xlsx/ })).toHaveAttribute('aria-valuenow', '40');
    expect(screen.getAllByText(/Keep this page open until the upload finishes/).length).toBeGreaterThan(0);
    const beforeUnload = addListener.mock.calls.find(([type]) => type === 'beforeunload');
    expect(beforeUnload).toBeDefined();

    await act(async () => { xhr.respond(202, { success: true, data: { job: job(), deduplicated: false } }); });

    expect(screen.getByTestId('phase')).toHaveTextContent('idle');
    expect(await screen.findByText('Branch import: sbi.xlsx')).toBeInTheDocument();
    expect(screen.getByText('Waiting to start')).toBeInTheDocument();
    // The file is the server's now: leaving is safe, so the prompt is gone.
    expect(removeListener).toHaveBeenCalledWith('beforeunload', beforeUnload![1]);
    expect(screen.getByText(/You can leave this page or refresh it/)).toBeInTheDocument();
    addListener.mockRestore();
    removeListener.mockRestore();
  });

  it('says so when the server returns the job already running for the same file', async () => {
    mockRequest.mockResolvedValue({ active: [], recent: [] });
    mount();
    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
    fireEvent.click(screen.getByText('upload'));
    await act(async () => { FakeXhr.last!.respond(202, { job: job({ status: 'RUNNING' }), deduplicated: true }); });
    expect(await screen.findByText(/already being processed/)).toBeInTheDocument();
  });

  it('shows the server\'s refusal in words and keeps nothing half-started', async () => {
    mockRequest.mockResolvedValue({ active: [], recent: [] });
    mount();
    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
    fireEvent.click(screen.getByText('upload'));
    await act(async () => { FakeXhr.last!.respond(400, { statusCode: 400, message: 'That sheet is the assayer roster, not branches.' }); });
    expect(screen.getByTestId('phase')).toHaveTextContent('error');
    expect(screen.getAllByText(/assayer roster, not branches/).length).toBeGreaterThan(0);
  });

  it('stopping an upload in flight leaves nothing behind', async () => {
    mockRequest.mockResolvedValue({ active: [], recent: [] });
    mount();
    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
    fireEvent.click(screen.getByText('upload'));
    act(() => FakeXhr.last!.progress(10, 100));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop uploading' })); });
    expect(screen.getByTestId('phase')).toHaveTextContent('idle');
  });
});
