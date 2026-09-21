import { renderHook, act } from '@testing-library/react';
import type { OutboundMessageReceipt } from '@fapoms/shared';

import {
  useMessageDelivery,
  useMessageDeliveries,
  DELIVERY_POLL_DELAYS_MS,
  DELIVERY_POLL_GIVE_UP_MS,
} from './useMessageDelivery';
import { api } from '../services/api';

/**
 * Following a queued email until it has an answer.
 *
 * Emails are no longer sent inside the request that asked for them, so the screen is handed a
 * receipt that says QUEUED and has to find out the rest by asking. Two failure modes matter to a
 * clerk and both are silent: a poll that never stops (hammering the server for every note left
 * open on a screen), and a poll that stops or lies too early (an invite shown as "did not go" because
 * one read blipped, or shown as "sending" for ever). These tests hold the hook to asking only while
 * there is something to learn, and to saying honestly when it stopped asking.
 */

jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));
const mockRequest = api.request as jest.Mock;

const queued = (over: Partial<OutboundMessageReceipt> = {}): OutboundMessageReceipt => ({
  id: 'em-1', status: 'QUEUED', to: 'ramesh@example.in', ...over,
});

/** Moves the fake clock and lets every awaited mock resolve before looking. */
const advance = async (ms: number) => {
  await act(async () => { await jest.advanceTimersByTimeAsync(ms); });
};

beforeEach(() => {
  jest.useFakeTimers();
  mockRequest.mockReset();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('useMessageDelivery — one queued email', () => {
  it('moves from QUEUED to SENT by asking the server, without the screen doing anything', async () => {
    mockRequest
      .mockResolvedValueOnce(queued({ status: 'SENDING' }))
      .mockResolvedValueOnce(queued({ status: 'SENT', sentAt: '2026-09-17T10:00:00.000Z' }));

    const { result } = renderHook(() => useMessageDelivery(queued()));
    expect(result.current.receipt?.status).toBe('QUEUED');
    expect(mockRequest).not.toHaveBeenCalled();

    await advance(DELIVERY_POLL_DELAYS_MS[0]);
    expect(mockRequest).toHaveBeenCalledWith('/outbound-messages/em-1');
    expect(result.current.receipt?.status).toBe('SENDING');

    await advance(DELIVERY_POLL_DELAYS_MS[1]);
    expect(result.current.receipt?.status).toBe('SENT');
    expect(result.current.stillWaiting).toBe(false);
  });

  it('stops asking once the email has an answer that will not change', async () => {
    mockRequest.mockResolvedValue(queued({ status: 'SENT' }));

    const { result } = renderHook(() => useMessageDelivery(queued()));
    await advance(DELIVERY_POLL_DELAYS_MS[0]);
    expect(result.current.receipt?.status).toBe('SENT');
    expect(mockRequest).toHaveBeenCalledTimes(1);

    await advance(DELIVERY_POLL_GIVE_UP_MS * 2);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('stops asking after a FAILED answer too, and keeps the reason', async () => {
    mockRequest.mockResolvedValue(queued({ status: 'FAILED', error: 'The mail server refused the address.' }));

    const { result } = renderHook(() => useMessageDelivery(queued()));
    await advance(DELIVERY_POLL_DELAYS_MS[0]);
    expect(result.current.receipt).toMatchObject({ status: 'FAILED', error: 'The mail server refused the address.' });

    await advance(60_000);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['SENT', queued({ status: 'SENT' })],
    ['FAILED', queued({ status: 'FAILED', error: 'Email is not set up.' })],
    ['NOT_QUEUED', queued({ id: null, status: 'NOT_QUEUED', error: 'Could not record the email.' })],
  ])('does not ask at all about a receipt that arrived already %s', async (_label, receipt) => {
    const { result } = renderHook(() => useMessageDelivery(receipt));
    await advance(DELIVERY_POLL_GIVE_UP_MS);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(result.current.receipt).toEqual(receipt);
    expect(result.current.stillWaiting).toBe(false);
  });

  it.each([['null', null], ['undefined', undefined]])(
    'does not ask at all when there is no receipt (%s) — nothing was queued',
    async (_label, receipt) => {
      const { result } = renderHook(() => useMessageDelivery(receipt));
      await advance(DELIVERY_POLL_GIVE_UP_MS);
      expect(mockRequest).not.toHaveBeenCalled();
      expect(result.current.receipt).toBeNull();
    },
  );

  it('treats a failed read as a failed read — asks again rather than reporting the email as failed', async () => {
    mockRequest
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce(queued({ status: 'SENT' }));

    const { result } = renderHook(() => useMessageDelivery(queued()));
    await advance(DELIVERY_POLL_DELAYS_MS[0]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(result.current.receipt?.status).toBe('QUEUED');
    expect(result.current.stillWaiting).toBe(false);

    await advance(DELIVERY_POLL_DELAYS_MS[1]);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(result.current.receipt?.status).toBe('SENT');
  });

  it('backs off between asks rather than polling at the first rate for ever', async () => {
    mockRequest.mockResolvedValue(queued());
    renderHook(() => useMessageDelivery(queued()));

    await advance(DELIVERY_POLL_DELAYS_MS[0]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    // The next ask waits the second delay, not the first.
    await advance(DELIVERY_POLL_DELAYS_MS[0]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    await advance(DELIVERY_POLL_DELAYS_MS[1] - DELIVERY_POLL_DELAYS_MS[0]);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('gives up after DELIVERY_POLL_GIVE_UP_MS and says it is still waiting, not that the email failed', async () => {
    mockRequest.mockResolvedValue(queued({ status: 'SENDING' }));

    const { result } = renderHook(() => useMessageDelivery(queued()));
    await advance(DELIVERY_POLL_GIVE_UP_MS - 10_000);
    expect(result.current.stillWaiting).toBe(false);

    await advance(20_000);
    expect(result.current.stillWaiting).toBe(true);
    expect(result.current.receipt?.status).toBe('SENDING');

    const asked = mockRequest.mock.calls.length;
    await advance(DELIVERY_POLL_GIVE_UP_MS);
    expect(mockRequest).toHaveBeenCalledTimes(asked);
  });

  it('asks nothing more once the screen that showed it has gone', async () => {
    mockRequest.mockResolvedValue(queued());
    const { unmount } = renderHook(() => useMessageDelivery(queued()));

    await advance(DELIVERY_POLL_DELAYS_MS[0]);
    expect(mockRequest).toHaveBeenCalledTimes(1);

    unmount();
    expect(jest.getTimerCount()).toBe(0);
    await advance(DELIVERY_POLL_GIVE_UP_MS);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('does not schedule another ask when an answer lands after the screen has gone', async () => {
    let answer!: (r: OutboundMessageReceipt) => void;
    mockRequest.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const { unmount } = renderHook(() => useMessageDelivery(queued()));

    await advance(DELIVERY_POLL_DELAYS_MS[0]); // the read is now in flight
    unmount();
    expect(jest.getTimerCount()).toBe(0);

    // Resolved outside act on purpose: nothing is mounted to update, and act's own bookkeeping
    // would add a timer of its own to the count below.
    answer(queued());
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(jest.getTimerCount()).toBe(0);

    await advance(DELIVERY_POLL_GIVE_UP_MS);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('starts following a new receipt when the screen is handed one', async () => {
    mockRequest.mockImplementation((url: string) => Promise.resolve(
      url.endsWith('em-2') ? queued({ id: 'em-2', status: 'SENT', to: 'priya@example.in' }) : queued(),
    ));
    const { result, rerender } = renderHook(({ r }) => useMessageDelivery(r), {
      initialProps: { r: queued() as OutboundMessageReceipt | null },
    });

    rerender({ r: queued({ id: 'em-2', to: 'priya@example.in' }) });
    expect(result.current.receipt).toMatchObject({ id: 'em-2', status: 'QUEUED' });

    await advance(DELIVERY_POLL_DELAYS_MS[0]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith('/outbound-messages/em-2');
    expect(result.current.receipt).toMatchObject({ id: 'em-2', status: 'SENT' });
  });
});

describe('useMessageDeliveries — a bulk run\'s emails', () => {
  const ids = Array.from({ length: 250 }, (_, i) => `em-${i}`);
  const idsIn = (url: string) => new URL(url, 'http://x').searchParams.get('ids')!.split(',');

  it('tallies sent, failed and still-sending across reads of at most 100 ids, then asks only about the open ones', async () => {
    // First round: em-0..9 failed, em-10..199 sent, em-200..249 still queued. Second: all sent.
    let round = 0;
    const seen: string[][] = [];
    mockRequest.mockImplementation((url: string) => {
      const asked = idsIn(url);
      seen.push(asked);
      return Promise.resolve(asked.map((id) => {
        const n = Number(id.slice(3));
        if (round === 0 && n < 10) return { id, status: 'FAILED', to: `${id}@x.in` };
        if (round === 0 && n >= 200) return { id, status: 'QUEUED', to: `${id}@x.in` };
        return { id, status: 'SENT', to: `${id}@x.in` };
      }));
    });

    const { result } = renderHook(() => useMessageDeliveries(ids));
    expect(result.current).toEqual({ total: 250, sent: 0, failed: 0, pending: 250, stillWaiting: false });

    await advance(DELIVERY_POLL_DELAYS_MS[1]);
    expect(seen.map((s) => s.length)).toEqual([100, 100, 50]);
    expect(new Set(seen.flat()).size).toBe(250);
    expect(result.current).toEqual({ total: 250, sent: 190, failed: 10, pending: 50, stillWaiting: false });

    round = 1;
    seen.length = 0;
    await advance(DELIVERY_POLL_DELAYS_MS[0] * 2);
    expect(seen).toEqual([ids.slice(200)]);
    expect(result.current).toEqual({ total: 250, sent: 240, failed: 10, pending: 0, stillWaiting: false });

    const asked = mockRequest.mock.calls.length;
    await advance(DELIVERY_POLL_GIVE_UP_MS);
    expect(mockRequest).toHaveBeenCalledTimes(asked);
  });

  it('gives up on the stragglers after DELIVERY_POLL_GIVE_UP_MS and says so', async () => {
    mockRequest.mockImplementation((url: string) => Promise.resolve(
      idsIn(url).map((id) => ({ id, status: id === 'em-0' ? 'SENT' : 'QUEUED', to: 'x@x.in' })),
    ));
    const { result } = renderHook(() => useMessageDeliveries(['em-0', 'em-1']));

    await advance(DELIVERY_POLL_GIVE_UP_MS + 30_000);
    expect(result.current).toEqual({ total: 2, sent: 1, failed: 0, pending: 1, stillWaiting: true });

    const asked = mockRequest.mock.calls.length;
    await advance(DELIVERY_POLL_GIVE_UP_MS);
    expect(mockRequest).toHaveBeenCalledTimes(asked);
  });

  it('does not ask about an empty batch', async () => {
    const { result } = renderHook(() => useMessageDeliveries([]));
    await advance(DELIVERY_POLL_GIVE_UP_MS);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(result.current.total).toBe(0);
  });

  it('asks nothing more once unmounted', async () => {
    mockRequest.mockImplementation((url: string) => Promise.resolve(
      idsIn(url).map((id) => ({ id, status: 'QUEUED', to: 'x@x.in' })),
    ));
    const { unmount } = renderHook(() => useMessageDeliveries(['em-0']));
    await advance(DELIVERY_POLL_DELAYS_MS[1]);
    expect(mockRequest).toHaveBeenCalledTimes(1);

    unmount();
    expect(jest.getTimerCount()).toBe(0);
    await advance(DELIVERY_POLL_GIVE_UP_MS);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});
