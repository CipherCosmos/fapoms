import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InterviewOutcome } from '@fapoms/shared';

import { AddCandidateDialog } from './AddCandidateDialog';
import { api } from '../../../services/api';

/**
 * Adding a candidate, now that their form is emailed in the background.
 *
 * Recording a passed interview used to wait on Gmail inside the request (4.95 s measured) and answer
 * `emailed: true|false`. The server now queues the email and answers at once with an
 * `emailDelivery` receipt, and the dialog has to follow that receipt rather than assume. The
 * regressions that matter here are quiet ones: reading the old boolean (gone, so every invite would
 * read as "no email on file"), showing "emailed" for something still queued, or hiding the invite
 * link — the clerk's only fallback when the email does not arrive.
 */

jest.mock('../../../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

const LINK = 'https://fapoms.example/register/tok-abc';

const draw = () => {
  const onAdded = jest.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AddCandidateDialog open onClose={jest.fn()} onAdded={onAdded} />
    </QueryClientProvider>,
  );
  return { onAdded };
};

const type = (placeholder: string | RegExp, value: string) =>
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });

const recordInterview = (outcome: 'Passed' | 'Did not pass') => {
  type('As printed on their Aadhaar or PAN', 'Ramesh Kumar');
  type('10 digits', '9876543210');
  type('Where their form is sent', 'ramesh@example.in');
  fireEvent.click(screen.getByRole('button', { name: outcome }));
  fireEvent.click(screen.getByRole('button', { name: 'Record interview' }));
};

const addDirectly = () => {
  fireEvent.click(screen.getByRole('tab', { name: 'Add without an interview' }));
  type('As printed on their Aadhaar or PAN', 'Priya Sharma');
  type('10 digits', '9876543211');
  type('Where their form is sent', 'priya@example.in');
  type(/Walk-in at the Kochi branch/, 'Referred by the Kochi branch manager, interview booked Friday');
  fireEvent.click(screen.getByRole('button', { name: 'Add and send their form' }));
};

beforeEach(() => {
  mockRequest.mockReset();
});

describe('AddCandidateDialog — recording an interview', () => {
  it('on a pass, follows the queued email ("Sending…") and shows the invite link at once', async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url === '/assayer-interviews') {
        return Promise.resolve({
          candidateName: 'Ramesh Kumar', outcome: InterviewOutcome.PASS, email: 'ramesh@example.in',
          emailDelivery: { id: 'em-1', status: 'QUEUED', to: 'ramesh@example.in' },
          inviteLink: LINK,
        });
      }
      return new Promise(() => undefined); // the receipt poll: no answer yet
    });
    const { onAdded } = draw();
    recordInterview('Passed');

    const note = await screen.findByTestId('email-delivery');
    expect(note).toHaveAttribute('data-status', 'QUEUED');
    expect(note).toHaveTextContent('Ramesh Kumar passed. Sending their form to ramesh@example.in…');
    expect(note).not.toHaveTextContent(/was emailed|did not go|no email on file/i);

    expect(screen.getByText(LINK)).toBeInTheDocument();
    expect(screen.getByText('Send this to them if the email did not arrive.')).toBeInTheDocument();
    expect(onAdded).toHaveBeenCalled();

    const [, init] = mockRequest.mock.calls.find(([url]) => url === '/assayer-interviews')!;
    expect(JSON.parse(init.body)).toMatchObject({
      candidateName: 'Ramesh Kumar', mobile: '9876543210', email: 'ramesh@example.in', outcome: 'PASS',
    });
  });

  it('then says it was emailed once the receipt comes back SENT', async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url === '/assayer-interviews') {
        return Promise.resolve({
          candidateName: 'Ramesh Kumar', outcome: InterviewOutcome.PASS, email: 'ramesh@example.in',
          emailDelivery: { id: 'em-1', status: 'QUEUED', to: 'ramesh@example.in' },
          inviteLink: LINK,
        });
      }
      if (url === '/outbound-messages/em-1') {
        return Promise.resolve({ id: 'em-1', status: 'SENT', to: 'ramesh@example.in' });
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    draw();
    recordInterview('Passed');

    await waitFor(() => expect(screen.getByTestId('email-delivery')).toHaveAttribute('data-status', 'SENT'));
    expect(screen.getByTestId('email-delivery')).toHaveTextContent('Ramesh Kumar passed. Their form was emailed to ramesh@example.in.');
    expect(screen.getByText(LINK)).toBeInTheDocument();
  });

  it('does not take the retired `emailed` flag\'s word for it — no receipt means nothing was queued', async () => {
    mockRequest.mockResolvedValue({
      candidateName: 'Ramesh Kumar', outcome: InterviewOutcome.PASS, email: null,
      emailed: true, inviteLink: LINK,
    });
    draw();
    recordInterview('Passed');

    const note = await screen.findByTestId('email-delivery');
    expect(note).toHaveAttribute('data-status', 'NO_ADDRESS');
    expect(note).toHaveTextContent('Ramesh Kumar passed. There is no email on file, so send them the link below.');
    expect(screen.getByText(LINK)).toBeInTheDocument();
  });

  it('on a fail, says nothing was sent and shows no email line at all', async () => {
    mockRequest.mockResolvedValue({ candidateName: 'Ramesh Kumar', outcome: InterviewOutcome.FAIL, email: 'ramesh@example.in' });
    draw();
    recordInterview('Did not pass');

    expect(await screen.findByText("Ramesh Kumar's interview is recorded as not passed. Nothing was sent to them.")).toBeInTheDocument();
    expect(screen.queryByTestId('email-delivery')).not.toBeInTheDocument();
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});

describe('AddCandidateDialog — adding without an interview', () => {
  it('shows why the email did not go, and the link to send by hand, from the receipt', async () => {
    mockRequest.mockResolvedValue({
      applicationId: 'app-1',
      emailDelivery: { id: 'em-2', status: 'FAILED', to: 'priya@example.in', error: 'Email is not set up yet.' },
      inviteLink: LINK,
    });
    draw();
    addDirectly();

    const note = await screen.findByTestId('email-delivery');
    expect(note).toHaveAttribute('data-status', 'FAILED');
    expect(note).toHaveTextContent(
      'Priya Sharma has been added. The email with their form to priya@example.in did not go — Email is not set up yet.',
    );
    expect(screen.getByText(LINK)).toBeInTheDocument();

    const [url, init] = mockRequest.mock.calls[0];
    expect(url).toBe('/hr/applications/invite');
    expect(JSON.parse(init.body)).toMatchObject({ fullName: 'Priya Sharma', reason: expect.stringMatching(/Kochi/) });
    // A settled receipt is not polled.
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('follows a queued email the same way as the interview route', async () => {
    mockRequest.mockImplementation((url: string) => (url === '/hr/applications/invite'
      ? Promise.resolve({
        applicationId: 'app-1',
        emailDelivery: { id: 'em-3', status: 'QUEUED', to: 'priya@example.in' },
        inviteLink: LINK,
      })
      : new Promise(() => undefined)));
    draw();
    addDirectly();

    const note = await screen.findByTestId('email-delivery');
    expect(note).toHaveTextContent('Priya Sharma has been added. Sending their form to priya@example.in…');
    expect(screen.getByText(LINK)).toBeInTheDocument();
  });
});
