import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppError } from '../../services/errors';

/**
 * On a screen about a person, a refused read must never be drawn as a fact about that person.
 *
 * These four screens each defaulted to `[]` or `null` and then described the absence in the
 * operator's own vocabulary, which is what makes the bug expensive: the sentences are not
 * hedged, they are conclusions, and people act on them.
 *
 *   - the audit trail:      "Nothing recorded for this person yet." — evidence of absence,
 *                           manufactured by a request nobody answered. Three roles hold
 *                           AUDIT_LOG:VIEW:PLATFORM, so being refused this is ordinary.
 *   - the skills panel:     "No skills, languages or certificates recorded — planning cannot
 *                           match this person on competency." That decides whether they are
 *                           offered a branch that requires a certificate.
 *   - the qualification tab: a skeleton that never resolved, on the scores that gate work.
 *   - the workforce roster:  EmptyState "Workforce roster is empty", over 1,155 people, under a
 *                           banner the operator could dismiss.
 *
 * Each test asserts BOTH halves: the refusal is stated, AND the screen's own empty sentence is
 * gone. Only asserting the first passes on a screen that prints both at once.
 */

jest.mock('../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../services/socket', () => ({ connectSocket: () => null, disconnectSocket: () => null }));

import { api } from '../../services/api';
import { UserActivityList, ActivityFeed } from '../users/ActivityFeed';
import { AssayerSkillsPanel } from './AssayerSkillsPanel';
import { AssayerQualificationTab } from './AssayerQualificationTab';

const request = api.request as jest.Mock;

const REFUSED = new AppError(
  'You do not have permission to perform this action. Ask an administrator if you require access.',
  'Forbidden', 403, 'permission-required',
);
const OUTAGE = new AppError(
  'The server could not complete that request.', 'Internal Server Error', 500, 'retryable',
);

function draw(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => { request.mockReset(); });

describe('Audit trail — a refused log is not a clean sheet', () => {
  it('one person: says it was refused rather than "Nothing recorded for this person yet"', async () => {
    request.mockRejectedValue(REFUSED);
    draw(<UserActivityList userId="u-1" />);

    await waitFor(() => expect(screen.getByText(/Could not load this person's activity/)).toBeInTheDocument());
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing recorded for this person yet/)).not.toBeInTheDocument();
  });

  it('one person: still says "nothing recorded" when the log really did come back empty', async () => {
    request.mockResolvedValue([]);
    draw(<UserActivityList userId="u-1" />);

    await waitFor(() => expect(screen.getByText(/Nothing recorded for this person yet/)).toBeInTheDocument());
    expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument();
  });

  it('the whole feed: says it was refused rather than "Nothing has been recorded in this category yet"', async () => {
    request.mockRejectedValue(REFUSED);
    draw(<ActivityFeed />);

    await waitFor(() => expect(screen.getByText(/Could not load the activity log/)).toBeInTheDocument());
    expect(screen.queryByText(/Nothing has been recorded in this category yet/)).not.toBeInTheDocument();
    // Nothing a retry can do about a permission.
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('the whole feed: offers Retry for an outage, which retrying could actually clear', async () => {
    request.mockRejectedValue(OUTAGE);
    draw(<ActivityFeed />);

    await waitFor(() => expect(screen.getByText(/Could not load the activity log/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('Skills panel — a refused competency list is not an unqualified person', () => {
  it('says it was refused rather than "No skills, languages or certificates recorded"', async () => {
    request.mockRejectedValue(REFUSED);
    draw(<AssayerSkillsPanel assayerId="as-1" assayerName="Ravi Pillai" canManage />);

    await waitFor(() => expect(screen.getByText(/Could not load what Ravi Pillai is qualified on/)).toBeInTheDocument());
    expect(screen.queryByText(/planning cannot match this person on competency/)).not.toBeInTheDocument();
  });

  it('still says the person has nothing recorded when the list genuinely came back empty', async () => {
    request.mockResolvedValue([]);
    draw(<AssayerSkillsPanel assayerId="as-1" assayerName="Ravi Pillai" canManage />);

    await waitFor(() => expect(screen.getByText(/planning cannot match this person on competency/)).toBeInTheDocument());
    expect(screen.queryByText(/Could not load what/)).not.toBeInTheDocument();
  });
});

describe('Qualification tab — a refused score is not a missing one', () => {
  it('names the refusal instead of holding the skeleton forever', async () => {
    request.mockRejectedValue(REFUSED);
    draw(<AssayerQualificationTab assayerId="as-1" canManage />);

    await waitFor(() =>
      expect(screen.getByText(/Could not load this assayer's qualification scores/)).toBeInTheDocument());
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
    // "Not yet assessable" is the tab's own way of saying a person has nothing scoreable on file.
    expect(screen.queryByText(/Not yet assessable/)).not.toBeInTheDocument();
  });
});
