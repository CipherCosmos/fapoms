import React from 'react';
import { render, screen, act } from '@testing-library/react';
import type { OutboundMessageReceipt } from '@fapoms/shared';

import { DeliveryNote, DeliveryBatchNote } from './DeliveryNote';
import { DELIVERY_POLL_DELAYS_MS, DELIVERY_POLL_GIVE_UP_MS } from '../hooks/useMessageDelivery';
import { api } from '../services/api';

/**
 * The one line that tells a clerk whether an email went.
 *
 * It replaced per-screen `emailed ? 'sent' : 'did not go'` banners that were only right because the
 * send used to happen inside the request. With the email queued, the response can no longer say
 * whether it went, and the dangerous regression is a note that decides anyway: a green "emailed"
 * for something still in the queue, or a quiet line for one that failed. A clerk who believes the
 * form went does not send the link by hand, and the candidate stalls. These tests pin each status
 * to the words and the colour it earns.
 */

jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

const receipt = (over: Partial<OutboundMessageReceipt> = {}): OutboundMessageReceipt => ({
  id: 'em-1', status: 'QUEUED', to: 'ramesh@example.in', ...over,
});

const note = () => screen.getByTestId('email-delivery');

/**
 * AlertBanner is the success/error banner and always draws its icon; the in-between line draws
 * none. So an icon beside the note is how a test tells "the screen has decided" from "still waiting".
 */
const hasBannerIcon = (container: HTMLElement) => container.querySelector('svg') !== null;

const advance = async (ms: number) => {
  await act(async () => { await jest.advanceTimersByTimeAsync(ms); });
};

beforeEach(() => {
  jest.useFakeTimers();
  mockRequest.mockReset();
  mockRequest.mockResolvedValue(receipt());
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('DeliveryNote', () => {
  it('says the email is on its way while it is QUEUED — not a success, not a problem', () => {
    const { container } = render(<DeliveryNote receipt={receipt()} lead="Ramesh passed." what="their form" />);

    expect(note()).toHaveAttribute('data-status', 'QUEUED');
    expect(note()).toHaveTextContent('Ramesh passed. Sending their form to ramesh@example.in…');
    expect(note().closest('[role="status"]')).not.toBeNull();
    expect(hasBannerIcon(container)).toBe(false);
    expect(note()).not.toHaveTextContent(/emailed|did not go/);
  });

  it('treats SENDING the same way as QUEUED', () => {
    const { container } = render(<DeliveryNote receipt={receipt({ status: 'SENDING' })} what="their form" />);
    expect(note()).toHaveTextContent('Sending their form to ramesh@example.in…');
    expect(hasBannerIcon(container)).toBe(false);
  });

  it('says it was emailed, as a success, once SENT', () => {
    const { container } = render(
      <DeliveryNote receipt={receipt({ status: 'SENT' })} lead="Ramesh passed." what="their form" />,
    );
    expect(note()).toHaveAttribute('data-status', 'SENT');
    expect(note()).toHaveTextContent('Ramesh passed. Their form was emailed to ramesh@example.in.');
    expect(hasBannerIcon(container)).toBe(true);
    expect(note().closest('[role="status"]')).toBeNull();
  });

  it('gives the server\'s reason and what to do instead when FAILED', () => {
    const { container } = render(
      <DeliveryNote
        receipt={receipt({ status: 'FAILED', error: 'The mail server refused the address.' })}
        what="their form"
        fallback="Send them the link below."
      />,
    );
    expect(note()).toHaveAttribute('data-status', 'FAILED');
    expect(note()).toHaveTextContent(
      'The email with their form to ramesh@example.in did not go — The mail server refused the address. Send them the link below.',
    );
    expect(note()).not.toHaveTextContent(/was emailed|Sending/);
    expect(hasBannerIcon(container)).toBe(true);
  });

  it('says it did not go when it could not even be queued (NOT_QUEUED), with the default fallback', () => {
    render(
      <DeliveryNote
        receipt={receipt({ id: null, status: 'NOT_QUEUED', error: 'Email is not set up' })}
        lead="Priya has been added."
        what="their form"
      />,
    );
    expect(note()).toHaveAttribute('data-status', 'NOT_QUEUED');
    expect(note()).toHaveTextContent(
      'Priya has been added. The email with their form to ramesh@example.in did not go — Email is not set up. Send them the link below instead.',
    );
  });

  it('still says it did not go when the server gave no reason', () => {
    render(<DeliveryNote receipt={receipt({ status: 'FAILED', error: null })} what="their form" />);
    expect(note()).toHaveTextContent('The email with their form to ramesh@example.in did not go. Send them the link below instead.');
  });

  it('uses the noAddress words when there was nobody to email', () => {
    render(
      <DeliveryNote
        receipt={null}
        lead="Ramesh passed."
        what="their form"
        noAddress="There is no email on file, so send them the link below."
      />,
    );
    expect(note()).toHaveAttribute('data-status', 'NO_ADDRESS');
    expect(note()).toHaveTextContent('Ramesh passed. There is no email on file, so send them the link below.');
  });

  it('falls back to a sentence built from `what` when no noAddress is given', () => {
    render(<DeliveryNote receipt={undefined} what="a link to set their password" />);
    expect(note()).toHaveTextContent(
      'There is no email address to send a link to set their password to. Send them the link below instead.',
    );
  });

  it.each([
    ['QUEUED', receipt()],
    ['SENT', receipt({ status: 'SENT' })],
    ['FAILED', receipt({ status: 'FAILED', error: 'Refused.' })],
    ['no receipt', null],
  ])('renders its children (the link box) when %s', (_label, r) => {
    render(
      <DeliveryNote receipt={r} what="their form">
        <div data-testid="link-box">https://app.example/register/abc</div>
      </DeliveryNote>,
    );
    expect(screen.getByTestId('link-box')).toHaveTextContent('https://app.example/register/abc');
  });

  /** Something that must disappear once the email went — a working password link, for one. */
  it('shows the undelivered-only content for a failure or no address, and hides it while sending or once sent', () => {
    const extra = <span data-testid="only-if-undelivered">link</span>;
    const { rerender } = render(<DeliveryNote receipt={{ id: 'e1', status: 'FAILED', to: 'a@b.c', error: 'x' } as any} what="w" whenUndelivered={extra} />);
    expect(screen.getByTestId('only-if-undelivered')).toBeInTheDocument();
    rerender(<DeliveryNote receipt={null} what="w" whenUndelivered={extra} />);
    expect(screen.getByTestId('only-if-undelivered')).toBeInTheDocument();
    rerender(<DeliveryNote receipt={{ id: 'e2', status: 'SENT', to: 'a@b.c' } as any} what="w" whenUndelivered={extra} />);
    expect(screen.queryByTestId('only-if-undelivered')).not.toBeInTheDocument();
    rerender(<DeliveryNote receipt={{ id: null, status: 'NOT_QUEUED', to: 'a@b.c' } as any} what="w" whenUndelivered={extra} />);
    expect(screen.getByTestId('only-if-undelivered')).toBeInTheDocument();
  });

  it('changes on its own from "Sending…" to "emailed" as the server answers', async () => {
    mockRequest.mockResolvedValue(receipt({ status: 'SENT' }));
    const { container } = render(<DeliveryNote receipt={receipt()} what="their form" />);
    expect(note()).toHaveTextContent('Sending their form');

    await advance(DELIVERY_POLL_DELAYS_MS[0]);
    expect(note()).toHaveAttribute('data-status', 'SENT');
    expect(note()).toHaveTextContent('Their form was emailed to ramesh@example.in.');
    expect(hasBannerIcon(container)).toBe(true);
  });

  it('after giving up, says the mail server has not confirmed it yet — still not a failure', async () => {
    const { container } = render(<DeliveryNote receipt={receipt()} what="their form" />);
    await advance(DELIVERY_POLL_GIVE_UP_MS + 10_000);

    expect(note()).toHaveAttribute('data-status', 'QUEUED');
    expect(note()).toHaveTextContent(
      'The mail server has not confirmed their form to ramesh@example.in yet. It may still arrive — send them the link below instead.',
    );
    expect(hasBannerIcon(container)).toBe(false);
  });
});

describe('DeliveryBatchNote', () => {
  it('renders nothing for a run that queued no emails', () => {
    const { container } = render(<DeliveryBatchNote ids={[]} what="credential emails" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('counts the run as still sending until the server answers, then says how many went and failed', async () => {
    mockRequest.mockResolvedValue([
      { id: 'em-1', status: 'SENT', to: 'a@x.in' },
      { id: 'em-2', status: 'FAILED', to: 'b@x.in', error: 'Refused.' },
      { id: 'em-3', status: 'QUEUED', to: 'c@x.in' },
    ]);
    render(<DeliveryBatchNote ids={['em-1', 'em-2', 'em-3']} what="credential emails" />);
    expect(screen.getByTestId('email-batch')).toHaveTextContent('0 of 3 credential emails emailed · 3 still sending…');

    await advance(DELIVERY_POLL_DELAYS_MS[1]);
    expect(screen.getByTestId('email-batch')).toHaveTextContent(
      '1 of 3 credential emails emailed · 1 did not go · 1 still sending… — check email delivery in Platform Settings',
    );
  });
});

/** A text goes through the same line; only the words change, never the rules. */
describe('DeliveryNote for a text message', () => {
  it('says "texted" and names the SMS gateway, not the mail server', () => {
    const { rerender } = render(<DeliveryNote receipt={{ id: 's1', channel: 'SMS', status: 'SENT', to: '+919822014455' } as any} what="the code" />);
    expect(screen.getByText(/The code was texted to \+919822014455/)).toBeInTheDocument();
    rerender(<DeliveryNote receipt={{ id: 's2', channel: 'SMS', status: 'FAILED', to: '+919822014455', error: 'SMS is not set up' } as any} what="the code" />);
    expect(screen.getByText(/The text with the code to \+919822014455 did not go/)).toBeInTheDocument();
    rerender(<DeliveryNote receipt={null} channel="SMS" what="the code" />);
    expect(screen.getByText(/There is no mobile number to send the code to/)).toBeInTheDocument();
  });
});
