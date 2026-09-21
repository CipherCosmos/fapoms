import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { CoveragePlanModal } from './CoveragePlanModal';
import { api } from '../../services/api';

/**
 * THE COVERAGE-PLAN MODAL FOLLOWS SERVER JOBS, AND SAYS WHERE THEY HAVE GOT TO.
 *
 * "Deploy whole project" held one request open while every assignment was created. On a 166-branch
 * plan that passed the 30 s client budget: the modal showed an error while the server carried on
 * deploying, and the natural next move — pressing Deploy again — started a second deploy. The preview
 * likewise ran the engine per branch inside a GET. The modal now starts jobs and polls them; these
 * hold it to showing the job's stage while it runs, and the job's result (not the POST's) at the end.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../services/queued-job', () => {
  const actual = jest.requireActual('../../services/queued-job');
  return {
    ...actual,
    waitForQueuedJob: jest.fn((path: string, opts: Record<string, unknown> = {}) =>
      actual.waitForQueuedJob(path, { ...opts, pollMs: 5 })),
  };
});

const mockRequest = api.request as jest.Mock;

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

const PREVIEW = {
  coveragePercentage: 92, estimatedDurationDays: 6, estimatedOperationalCost: 120000,
  requiredWorkforceCount: 4, availableWorkforceCount: 9, confidenceScore: 81,
  uncoveredBranches: [], clusters: [{ name: 'Pune', assignedAssayerName: 'Ravi', branchIds: ['b-1'], estimatedTotalFee: 1800 }],
};

beforeEach(() => mockRequest.mockReset());

it('loads the preview through the preview job and shows its stage while it runs', async () => {
  const finish = deferred<unknown>();
  let polls = 0;
  mockRequest.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/planning/projects/p-1/coverage-plan/jobs') {
      expect(init?.method).toBe('POST');
      return Promise.resolve({ jobId: '11', deduplicated: false });
    }
    if (url === '/planning/jobs/11') {
      polls += 1;
      return polls === 1
        ? Promise.resolve({ jobId: '11', state: 'running', progress: { percent: 30, stage: 'Scoring branches (60/200)' } })
        : finish.promise;
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });

  render(<CoveragePlanModal projectId="p-1" projectName="SBI Gold" onClose={jest.fn()} onDeployed={jest.fn()} />);

  expect(await screen.findByTestId('coverage-plan-progress')).toHaveTextContent('Scoring branches (60/200)');
  finish.resolve({ jobId: '11', state: 'done', progress: { percent: 100, stage: 'Complete' }, result: PREVIEW });
  expect(await screen.findByText('92%')).toBeInTheDocument();
  expect(mockRequest.mock.calls.some(([url, init]) => url === '/planning/projects/p-1/coverage-plan' && !init?.method)).toBe(false);
});

it('deploys through the write job, shows how far it has got, and reports the job\'s result', async () => {
  const deployDone = deferred<unknown>();
  let deployPolls = 0;
  const onDeployed = jest.fn();
  mockRequest.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    switch (url) {
      case '/planning/projects/p-1/coverage-plan/jobs':
        return Promise.resolve({ jobId: '1', deduplicated: false });
      case '/planning/jobs/1':
        return Promise.resolve({ jobId: '1', state: 'done', progress: { percent: 100, stage: 'Complete' }, result: PREVIEW });
      case '/planning/projects/p-1/coverage-plan/versions/jobs':
        return Promise.resolve({ jobId: '2', deduplicated: false });
      case '/planning/write-jobs/2':
        return Promise.resolve({ jobId: '2', state: 'done', progress: { percent: 100, stage: 'Complete' }, result: { id: 'plan-1', status: 'GENERATED', currentVersion: 1 } });
      case '/planning/coverage-plans/plan-1/transition':
        return Promise.resolve({ id: 'plan-1', status: 'APPROVED', currentVersion: 1 });
      case '/planning/coverage-plans/plan-1/execute':
        expect(init?.method).toBe('POST');
        return Promise.resolve({ jobId: '3', deduplicated: false });
      case '/planning/write-jobs/3':
        deployPolls += 1;
        return deployPolls === 1
          ? Promise.resolve({ jobId: '3', state: 'running', progress: { percent: 25, stage: 'Creating offers (41/166)' } })
          : deployDone.promise;
      default:
        return Promise.reject(new Error(`unexpected ${url}`));
    }
  });

  render(<CoveragePlanModal projectId="p-1" projectName="SBI Gold" onClose={jest.fn()} onDeployed={onDeployed} />);
  // The generate button is on screen, disabled, while the preview job runs.
  await screen.findByText('92%');
  fireEvent.click(screen.getByRole('button', { name: /Generate plan version/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Approve plan/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Deploy whole project/ }));

  expect(await screen.findByTestId('coverage-plan-progress')).toHaveTextContent('Creating offers (41/166)');
  expect(onDeployed).not.toHaveBeenCalled();

  deployDone.resolve({
    jobId: '3', state: 'done', progress: { percent: 100, stage: 'Complete' },
    result: {
      message: 'Coverage plan deployed', deployedCount: 160, skippedCount: 6, deployed: [], skipped: [],
      skippedReasons: [{ reason: 'Plan carries no quoted fee for this branch.', count: 6 }],
      fullySkipped: false, dateRange: { start: '2026-10-01', end: '2026-10-19' }, alreadyDeployedCount: 40,
    },
  });

  expect(await screen.findByText(/160 assignment\(s\) deployed/)).toBeInTheDocument();
  expect(screen.getByText(/40 of these had already been booked by an earlier, interrupted deploy/)).toBeInTheDocument();
  await waitFor(() => expect(onDeployed).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId('coverage-plan-progress')).not.toBeInTheDocument();
});

it('shows the deploy job\'s own failure in its words', async () => {
  mockRequest.mockImplementation((url: string) => {
    switch (url) {
      case '/planning/projects/p-1/coverage-plan/jobs': return Promise.resolve({ jobId: '1', deduplicated: false });
      case '/planning/jobs/1': return Promise.resolve({ jobId: '1', state: 'done', progress: { percent: 100, stage: 'Complete' }, result: PREVIEW });
      case '/planning/projects/p-1/coverage-plan/versions/jobs': return Promise.resolve({ jobId: '2', deduplicated: false });
      case '/planning/write-jobs/2': return Promise.resolve({ jobId: '2', state: 'done', progress: { percent: 100, stage: 'Complete' }, result: { id: 'plan-1', status: 'APPROVED', currentVersion: 1 } });
      case '/planning/coverage-plans/plan-1/execute': return Promise.resolve({ jobId: '3', deduplicated: false });
      case '/planning/write-jobs/3': return Promise.resolve({ jobId: '3', state: 'failed', progress: { percent: 10, stage: 'Failed' }, error: 'Execution denied: only APPROVED plans can be deployed.' });
      default: return Promise.reject(new Error(`unexpected ${url}`));
    }
  });

  render(<CoveragePlanModal projectId="p-1" projectName="SBI Gold" onClose={jest.fn()} onDeployed={jest.fn()} />);
  await screen.findByText('92%');
  fireEvent.click(screen.getByRole('button', { name: /Generate plan version/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Deploy whole project/ }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Execution denied: only APPROVED plans can be deployed.');
});
