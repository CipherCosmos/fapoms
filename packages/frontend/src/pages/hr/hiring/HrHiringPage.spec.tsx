import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApplicationStatus, AssayerLifecycleStatus, InterviewOutcome } from '@fapoms/shared';

import { HrHiringPage } from './HrHiringPage';
import { api } from '../../../services/api';

/**
 * ONE QUEUE FOR THE WHOLE FUNNEL.
 *
 * Hiring was three tabs: a passed interview opened an application, an approval created the assayer
 * record, and joining carried them to Active. Nobody could answer "who needs me today" without
 * visiting all three, and the same person could appear twice under two different words for one
 * state. These tests hold the merged page to listing each candidate exactly once, under the step
 * they are actually on, and to opening the surface that matches.
 */

jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));
jest.mock('../../../hooks/useCurrentRoles', () => ({
  ...jest.requireActual('../../../hooks/useCurrentRoles'),
  useCurrentRoles: () => ['ADMIN'],
  useCurrentUserId: () => 'hr-1',
  canManageAssayers: () => true,
}));
jest.mock('../../../services/assayer-roster', () => ({
  fetchWholeAssayerRoster: jest.fn(),
}));
// The two detail surfaces are covered by their own specs; here we only care WHICH one opens.
jest.mock('../applications/ApplicationDetailDrawer', () => ({
  ApplicationDetailDrawer: ({ id }: { id: string }) => <div data-testid="application-drawer">{id}</div>,
}));
jest.mock('../OnboardingVerificationDrawer', () => ({
  OnboardingVerificationDrawer: ({ candidateId }: { candidateId: string }) => (
    <div data-testid="joining-drawer">{candidateId}</div>
  ),
}));

import { fetchWholeAssayerRoster } from '../../../services/assayer-roster';

const applications = [
  { id: 'app-review', fullName: 'Ramesh Kumar', mobile: '9876543210', email: null, status: ApplicationStatus.PENDING_VALIDATION, createdAt: '2026-09-01T00:00:00.000Z' },
  { id: 'app-draft', fullName: 'Priya Sharma', mobile: '9876543211', email: null, status: ApplicationStatus.DRAFT, createdAt: '2026-09-05T00:00:00.000Z' },
  // Approved: the assayer row below is the same person, further along.
  { id: 'app-approved', fullName: 'Ravi Pillai', mobile: '9876543212', email: null, status: ApplicationStatus.APPROVED, createdAt: '2026-08-20T00:00:00.000Z' },
];

const people = [{
  id: 'as-1', assayerCode: 'AS0001', displayName: 'Ravi Pillai', phone: '9876543212',
  lifecycleStatus: AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
  panNumber: 'ABCDE1234F', bankAccountNumber: '1', ifscCode: 'HDFC0000001', latitude: 9.9, longitude: 76.2,
}];

const interviews = [
  { id: 'int-fail', candidateName: 'Anil Das', mobile: '9876543213', email: null, outcome: InterviewOutcome.FAIL, interviewedAt: '2026-09-02T00:00:00.000Z',
    interviewedByName: 'Meera Rao', notes: 'Could not tell 22K from 18K on the touchstone.' },
  { id: 'int-pass', candidateName: 'Ramesh Kumar', mobile: '9876543210', email: null, outcome: InterviewOutcome.PASS, interviewedAt: '2026-09-01T00:00:00.000Z', spawnedApplicationId: 'app-review' },
];

const draw = (entry = '/hr/hiring') => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes><Route path="/hr/hiring" element={<HrHiringPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  jest.clearAllMocks();
  (fetchWholeAssayerRoster as jest.Mock).mockResolvedValue({ people });
  (api.request as jest.Mock).mockImplementation((url: string) => {
    if (url === '/hr/applications') return Promise.resolve(applications);
    if (url === '/assayer-interviews') return Promise.resolve(interviews);
    return Promise.resolve([]);
  });
});

describe('the hiring pipeline, as one list', () => {
  it('shows candidates from all three sources together', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('Ramesh Kumar')).toBeInTheDocument());
    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();  // application, waiting on them
    expect(screen.getByText('Ravi Pillai')).toBeInTheDocument();   // assayer, joining
    expect(screen.getByText('Anil Das')).toBeInTheDocument();      // interview that did not pass
  });

  it('lists somebody once — the approved application and the record it created are one person', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('Ravi Pillai')).toBeInTheDocument());
    expect(screen.getAllByText('Ravi Pillai')).toHaveLength(1);
    // And a passed interview does not double up with the application it opened.
    expect(screen.getAllByText('Ramesh Kumar')).toHaveLength(1);
  });

  it('says what each row needs next, in the words of its own step', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('Ramesh Kumar')).toBeInTheDocument());
    expect(screen.getByText('Check their form and documents, then approve or send it back')).toBeInTheDocument();
    expect(screen.getByText('Record the result of their background check, then send them for approval')).toBeInTheDocument();
  });

  it('filters by stage, and keeps the choice in the URL', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('Ravi Pillai')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /To review/ }));
    await waitFor(() => expect(screen.queryByText('Ravi Pillai')).not.toBeInTheDocument());
    expect(screen.getByText('Ramesh Kumar')).toBeInTheDocument();
  });

  it('opens a stage filter given in the URL', async () => {
    draw('/hr/hiring?stage=closed');
    await waitFor(() => expect(screen.getByText('Anil Das')).toBeInTheDocument());
    expect(screen.queryByText('Ramesh Kumar')).not.toBeInTheDocument();
  });

  it('searches across name, code and number', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('Ramesh Kumar')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/Search by name/i), { target: { value: 'AS0001' } });
    await waitFor(() => expect(screen.queryByText('Ramesh Kumar')).not.toBeInTheDocument());
    expect(screen.getByText('Ravi Pillai')).toBeInTheDocument();
  });
});

describe('opening somebody shows the surface that matches where they are', () => {
  it('an application opens the review drawer', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('Ramesh Kumar')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Ramesh Kumar'));
    await waitFor(() => expect(screen.getByTestId('application-drawer')).toHaveTextContent('app-review'));
  });

  it('somebody already on the books opens the joining workspace', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('Ravi Pillai')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Ravi Pillai'));
    await waitFor(() => expect(screen.getByTestId('joining-drawer')).toHaveTextContent('as-1'));
  });
});

describe('adding a candidate', () => {
  it('offers both routes in, and asks why when there was no interview', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('Ramesh Kumar')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Add candidate/i }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /Record an interview/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: /Add without an interview/i }));
    expect(screen.getByText(/Why is this person being added without an interview/i)).toBeInTheDocument();

    // The shortcut is recorded, not silent — and it will not go without the reason.
    const save = screen.getByRole('button', { name: /Add and send their form/i });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/As printed on their Aadhaar/i), { target: { value: 'Walk In' } });
    fireEvent.change(screen.getByPlaceholderText(/10 digits/i), { target: { value: '9800000000' } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/Walk-in at the Kochi branch/i), { target: { value: 'Walk-in, known to the branch manager' } });
    await waitFor(() => expect(save).toBeEnabled());

    fireEvent.click(save);
    await waitFor(() => expect(api.request).toHaveBeenCalledWith('/hr/applications/invite', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('Walk-in, known to the branch manager'),
    })));
  });
});

/**
 * THE ROW THAT OPENED NOTHING.
 *
 * Failed interviews are listed so that somebody about to talk to the same person again can see it
 * happened. Clicking one set `?id=interview:<id>` and rendered no drawer at all — and what the
 * interviewer wrote, stored every time, appeared on no screen anywhere.
 */
describe('opening an interview that did not pass', () => {
  it('shows who interviewed them and what they wrote', async () => {
    draw();
    fireEvent.click(await screen.findByText('Anil Das'));

    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Did not pass')).toBeInTheDocument();
    expect(within(drawer).getByText(/by Meera Rao/)).toBeInTheDocument();
    expect(within(drawer).getByText('Could not tell 22K from 18K on the touchstone.')).toBeInTheDocument();
  });

  /** `?id=` survives a reload, so a shared link to the row has to open the same drawer. */
  it('opens from a link as well as a click', async () => {
    draw('/hr/hiring?id=interview:int-fail');
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Anil Das')).toBeInTheDocument();
  });
});
