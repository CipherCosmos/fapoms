import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { BackgroundJobSummary } from '@fapoms/shared';
import { JobsTray } from './JobsTray';
import { ToastProvider } from '../ui/Toast';
import { api } from '../../services/api';
import { useSocketInvalidation } from '../../hooks/useSocketInvalidation';

/**
 * The Jobs tray keeps no memory of its own. These pin the three ways it learns what is happening:
 * from the server when it mounts (which is what a refresh or a hard refresh is), from a pushed
 * `job:updated`, and — only while something is in flight and the socket is down — by polling.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

type Handler = (...args: unknown[]) => void;
let listeners: Record<string, Handler[]> = {};
let socketLive = true;
const fakeSocket = {
  on: (event: string, h: Handler) => { (listeners[event] ??= []).push(h); },
  off: (event: string, h: Handler) => { listeners[event] = (listeners[event] ?? []).filter((x) => x !== h); },
};
jest.mock('../../services/socket', () => ({
  connectSocket: () => fakeSocket,
  subscribeToConnection: (cb: (live: boolean) => void) => { cb(socketLive); return () => undefined; },
}));

// The real live-update hook, against the real query client the tray reads — so the socket path
// tested here is the one the app runs, not a copy of it.
let testClient: QueryClient;
jest.mock('../../queryClient', () => ({
  get queryClient() { return testClient; },
}));

const job = (over: Partial<BackgroundJobSummary> = {}): BackgroundJobSummary => ({
  id: 'job-1',
  kind: 'BRANCH_IMPORT',
  status: 'RUNNING',
  title: '5,000 branches for SBI',
  requestedBy: 'u-1',
  scopeType: 'CLIENT',
  scopeId: 'c-1',
  progress: { processed: 1240, total: 5000, percent: 24, stage: 'Importing branches', message: null },
  result: null,
  error: null,
  inputFileName: 'sbi.xlsx',
  inputSize: 1000,
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

const Live: React.FC = () => { useSocketInvalidation(); return null; };

function mount() {
  testClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={testClient}>
      <ToastProvider>
        <MemoryRouter>
          <Live />
          <JobsTray />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listeners = {};
  socketLive = true;
  mockRequest.mockReset();
});

describe('JobsTray', () => {
  it('restores what is running from the SERVER on mount — nothing from browser storage', async () => {
    const getItem = jest.spyOn(Storage.prototype, 'getItem');
    mockRequest.mockResolvedValue({ active: [job()], recent: [] });
    mount();

    expect(await screen.findByTestId('jobs-tray-count')).toHaveTextContent('1');
    expect(mockRequest).toHaveBeenCalledWith(expect.stringMatching(/^\/jobs\?status=active%2Crecent/), expect.anything());
    // The tray reads no job state from storage (the only storage read allowed is the auth token,
    // which this tray never touches — the api module is mocked).
    expect(getItem.mock.calls.filter(([k]) => /job/i.test(String(k)))).toEqual([]);
    getItem.mockRestore();

    fireEvent.click(screen.getByRole('button', { name: /Background jobs, 1 in progress/ }));
    expect(screen.getByText('5,000 branches for SBI')).toBeInTheDocument();
    expect(screen.getByText('Importing branches')).toBeInTheDocument();
    expect(screen.getByText(/1,240 of 5,000/)).toBeInTheDocument();
  });

  it('is quiet when nothing is happening: no badge, and it never opens itself', async () => {
    mockRequest.mockResolvedValue({ active: [], recent: [job({ id: 'old', status: 'SUCCEEDED', result: { summary: 'Done: 5,000' } })] });
    mount();
    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
    expect(screen.queryByTestId('jobs-tray-count')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('applies a pushed job:updated without refetching', async () => {
    mockRequest.mockResolvedValue({ active: [job()], recent: [] });
    mount();
    await screen.findByTestId('jobs-tray-count');
    fireEvent.click(screen.getByRole('button', { name: /Background jobs/ }));
    const callsBefore = mockRequest.mock.calls.length;

    act(() => {
      for (const h of listeners['job:updated'] ?? []) {
        h(job({ status: 'SUCCEEDED', finishedAt: '2026-09-24T10:05:00.000Z', updatedAt: '2026-09-24T10:05:00.000Z', result: { summary: '4,980 imported; 20 skipped.' } }));
      }
    });

    expect(await screen.findByText('4,980 imported; 20 skipped.')).toBeInTheDocument();
    expect(screen.getByText('Finished recently')).toBeInTheDocument();
    expect(screen.queryByTestId('jobs-tray-count')).toBeNull();
    expect(mockRequest.mock.calls.length).toBe(callsBefore);
  });

  it('ignores a stale update that arrives after a newer one', async () => {
    mockRequest.mockResolvedValue({ active: [job({ updatedAt: '2026-09-24T10:02:00.000Z', progress: { processed: 3000, total: 5000, percent: 60, stage: 'Importing branches' } })], recent: [] });
    mount();
    await screen.findByTestId('jobs-tray-count');
    fireEvent.click(screen.getByRole('button', { name: /Background jobs/ }));
    expect(listeners['job:updated']?.length).toBeGreaterThan(0);
    act(() => { for (const h of listeners['job:updated'] ?? []) h(job()); }); // older: 1,240 at 10:01
    // React Query notifies on its own tick; give a wrongly-applied update the chance to render.
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.getByText(/3,000 of 5,000/)).toBeInTheDocument();
    expect(screen.queryByText(/1,240 of 5,000/)).toBeNull();
  });

  it('polls every 5 s while a job is in flight and the socket is down — and stops when it settles', async () => {
    jest.useFakeTimers();
    try {
      socketLive = false;
      mockRequest.mockResolvedValue({ active: [job()], recent: [] });
      mount();
      await act(async () => { await Promise.resolve(); });
      await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));

      await act(async () => { jest.advanceTimersByTime(5_100); });
      await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));

      mockRequest.mockResolvedValue({ active: [], recent: [job({ status: 'SUCCEEDED', updatedAt: '2026-09-24T10:09:00.000Z' })] });
      await act(async () => { jest.advanceTimersByTime(5_100); });
      await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(3));
      await act(async () => { jest.advanceTimersByTime(20_000); });
      expect(mockRequest).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never offers a branch review file as a download — waiting, committed or discarded — but does offer the commit report', async () => {
    const review = { hasResultFile: true, resultFileName: 'branch-review.json', result: { summary: 'Ready to review: 5,000 rows.' } };
    mockRequest.mockResolvedValue({
      active: [job({ id: 'waiting', status: 'AWAITING_REVIEW', ...review })],
      recent: [
        job({ id: 'reviewed', status: 'SUCCEEDED', ...review }),
        job({ id: 'discarded', status: 'CANCELLED', ...review }),
        job({ id: 'commit', status: 'SUCCEEDED', parentJobId: 'reviewed', hasResultFile: true, resultFileName: 'branch-import-report.xlsx', result: { summary: '4,980 saved.' } }),
        // Another kind's rehearsal file IS its report.
        job({ id: 'roster', kind: 'ROSTER_IMPORT', status: 'AWAITING_REVIEW', hasResultFile: true, resultFileName: 'roster-dry-run.xlsx', result: { summary: 'Dry run.' } }),
      ],
    });
    mount();
    await screen.findByTestId('jobs-tray-count');
    fireEvent.click(screen.getByRole('button', { name: /Background jobs/ }));
    const download = (id: string) => within(screen.getByTestId(`job-${id}`)).queryByRole('button', { name: /Download report/ });
    expect(download('waiting')).toBeNull();
    expect(download('reviewed')).toBeNull();
    expect(download('discarded')).toBeNull();
    expect(download('commit')).not.toBeNull();
    expect(download('roster')).not.toBeNull();
    // The waiting review still leads to its page.
    expect(within(screen.getByTestId('job-waiting')).getByRole('button', { name: 'Open page' })).toBeInTheDocument();
  });

  it('cancels from the tray and shows the answer', async () => {
    mockRequest.mockImplementation(async (url: string) => {
      if (url === '/jobs/job-1/cancel') return job({ cancelRequested: true, updatedAt: '2026-09-24T10:03:00.000Z' });
      return { active: [job()], recent: [] };
    });
    mount();
    await screen.findByTestId('jobs-tray-count');
    fireEvent.click(screen.getByRole('button', { name: /Background jobs/ }));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(await screen.findByText(/stopping…/)).toBeInTheDocument();
    expect(mockRequest).toHaveBeenCalledWith('/jobs/job-1/cancel', { method: 'POST' });
  });
});
