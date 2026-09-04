import { createManualReconnect } from './manualReconnect';

/**
 * See `manualReconnect.ts` for the full story. In short: socket.io-client never retries a
 * disconnect whose reason is `"io server disconnect"` — the server-initiated close the gateway
 * produces whenever a (re)connect's JWT has expired. Reproduced live before this existed: an idle
 * dashboard tab's live badge went red on exactly this reason and stayed red permanently, with no
 * further `[Socket] Connected` in the console ever again, even once the token had silently
 * refreshed in the background. These specs pin the retry that fixes it, independent of
 * socket.io-client and of `socket.ts` (which cannot be unit-tested in this package's Jest setup —
 * see that file's own note on `import.meta.env`).
 */
describe('createManualReconnect', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does nothing for a disconnect reason the built-in mechanism already retries', () => {
    const reconnect = jest.fn();
    const mr = createManualReconnect(() => true, reconnect);

    mr.handleDisconnect('transport close');
    jest.advanceTimersByTime(60_000);

    expect(reconnect).not.toHaveBeenCalled();
  });

  it('retries after "io server disconnect", once the initial delay elapses', () => {
    const reconnect = jest.fn();
    const mr = createManualReconnect(() => true, reconnect, 1000, 30000);

    mr.handleDisconnect('io server disconnect');
    expect(reconnect).not.toHaveBeenCalled(); // not synchronous — see the file's own note why

    jest.advanceTimersByTime(999);
    expect(reconnect).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('does not retry once there is nothing to retry with (logged out in the interim)', () => {
    const reconnect = jest.fn();
    let hasToken = true;
    const mr = createManualReconnect(() => hasToken, reconnect, 1000);

    mr.handleDisconnect('io server disconnect');
    hasToken = false;
    jest.advanceTimersByTime(1000);

    expect(reconnect).not.toHaveBeenCalled();
  });

  it('coalesces repeated disconnect reports into a single pending retry', () => {
    const reconnect = jest.fn();
    const mr = createManualReconnect(() => true, reconnect, 1000);

    mr.handleDisconnect('io server disconnect');
    mr.handleDisconnect('io server disconnect');
    mr.handleDisconnect('io server disconnect');
    jest.advanceTimersByTime(1000);

    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially across consecutive rejections, capped at maxDelayMs', () => {
    const reconnect = jest.fn();
    const mr = createManualReconnect(() => true, reconnect, 1000, 4000);

    mr.handleDisconnect('io server disconnect');
    jest.advanceTimersByTime(1000);
    expect(reconnect).toHaveBeenCalledTimes(1); // 1s

    mr.handleDisconnect('io server disconnect'); // retry itself failed again
    jest.advanceTimersByTime(1999);
    expect(reconnect).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(reconnect).toHaveBeenCalledTimes(2); // 2s

    mr.handleDisconnect('io server disconnect');
    jest.advanceTimersByTime(3999);
    expect(reconnect).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    expect(reconnect).toHaveBeenCalledTimes(3); // 4s (would be 4s uncapped too)

    // One more: without the cap this would ask for 8s. It must stay at the ceiling instead of
    // a persistently bad token slowly backing off into an effectively-dead connection.
    mr.handleDisconnect('io server disconnect');
    jest.advanceTimersByTime(4000);
    expect(reconnect).toHaveBeenCalledTimes(4); // capped at 4s, not 8s
  });

  it('resets backoff to the initial delay once a real connection succeeds', () => {
    const reconnect = jest.fn();
    const mr = createManualReconnect(() => true, reconnect, 1000, 30000);

    mr.handleDisconnect('io server disconnect');
    jest.advanceTimersByTime(1000);
    mr.handleDisconnect('io server disconnect'); // escalate to 2s
    jest.advanceTimersByTime(2000);
    expect(reconnect).toHaveBeenCalledTimes(2);

    mr.handleConnect(); // a later, unrelated outage must not inherit this backoff

    mr.handleDisconnect('io server disconnect');
    jest.advanceTimersByTime(999);
    expect(reconnect).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    expect(reconnect).toHaveBeenCalledTimes(3); // back to 1s, not 4s
  });

  it('handleConnect cancels a retry that was already pending', () => {
    const reconnect = jest.fn();
    const mr = createManualReconnect(() => true, reconnect, 1000);

    mr.handleDisconnect('io server disconnect');
    mr.handleConnect(); // e.g. the built-in mechanism itself won the race and reconnected first
    jest.advanceTimersByTime(60_000);

    expect(reconnect).not.toHaveBeenCalled();
  });

  it('cancel() drops a pending retry without calling reconnect', () => {
    const reconnect = jest.fn();
    const mr = createManualReconnect(() => true, reconnect, 1000);

    mr.handleDisconnect('io server disconnect');
    mr.cancel();
    jest.advanceTimersByTime(60_000);

    expect(reconnect).not.toHaveBeenCalled();
  });

  it('a fresh disconnect after cancel() schedules at the initial delay again', () => {
    const reconnect = jest.fn();
    const mr = createManualReconnect(() => true, reconnect, 1000, 30000);

    mr.handleDisconnect('io server disconnect');
    jest.advanceTimersByTime(1000);
    mr.handleDisconnect('io server disconnect'); // escalate to 2s pending
    mr.cancel();

    mr.handleDisconnect('io server disconnect');
    jest.advanceTimersByTime(999);
    expect(reconnect).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(reconnect).toHaveBeenCalledTimes(2); // 1s, not the 2s it would have escalated to
  });
});
