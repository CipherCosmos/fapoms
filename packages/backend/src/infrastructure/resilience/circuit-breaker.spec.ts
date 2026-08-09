import { CircuitBreaker } from './circuit-breaker';

describe('CircuitBreaker', () => {
  let now = 0;
  const clock = () => now;
  const ok = () => Promise.resolve('primary');
  const boom = () => Promise.reject(new Error('down'));
  const fallback = () => Promise.resolve('fallback');

  beforeEach(() => {
    now = 1_000_000;
  });

  it('passes through to the primary while healthy', async () => {
    const cb = new CircuitBreaker({}, clock);
    await expect(cb.run(ok, fallback)).resolves.toBe('primary');
    expect(cb.getState()).toBe('CLOSED');
  });

  it('falls back on failure but stays closed until the threshold', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 }, clock);
    await expect(cb.run(boom, fallback)).resolves.toBe('fallback');
    await cb.run(boom, fallback);
    expect(cb.getState()).toBe('CLOSED');
    await cb.run(boom, fallback); // 3rd failure
    expect(cb.getState()).toBe('OPEN');
  });

  it('short-circuits straight to the fallback while open (does not call primary)', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 }, clock);
    await cb.run(boom, fallback); // opens
    expect(cb.getState()).toBe('OPEN');
    const primary = jest.fn(ok);
    await expect(cb.run(primary, fallback)).resolves.toBe('fallback');
    expect(primary).not.toHaveBeenCalled();
  });

  it('probes after the cooldown (HALF_OPEN) and closes on success', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 }, clock);
    await cb.run(boom, fallback); // opens at now
    now += 10_000; // cooldown elapsed
    await expect(cb.run(ok, fallback)).resolves.toBe('primary'); // trial succeeds
    expect(cb.getState()).toBe('CLOSED');
  });

  it('re-opens immediately if the half-open trial fails', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 }, clock);
    await cb.run(boom, fallback); // opens
    now += 10_000;
    await cb.run(boom, fallback); // half-open trial fails → re-open
    expect(cb.getState()).toBe('OPEN');
    const primary = jest.fn(ok);
    await cb.run(primary, fallback); // still cooling down again
    expect(primary).not.toHaveBeenCalled();
  });

  it('treats an in-fn fallback return as success (dependency is up, just no data)', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 }, clock);
    // fn resolves (no throw) even though it returns the fallback value → should NOT trip.
    await cb.run(() => Promise.resolve('fallback'), fallback);
    expect(cb.getState()).toBe('CLOSED');
  });
});
