import { isExhausted } from './job-failure.monitor';

describe('isExhausted (dead-letter detection)', () => {
  it('is not exhausted while attempts remain', () => {
    expect(isExhausted(1, 5)).toBe(false);
    expect(isExhausted(4, 5)).toBe(false);
  });

  it('is exhausted on (or past) the final attempt', () => {
    expect(isExhausted(5, 5)).toBe(true);
    expect(isExhausted(6, 5)).toBe(true);
  });

  it('treats a single-attempt job as dead after one failure', () => {
    expect(isExhausted(1, 1)).toBe(true);
    expect(isExhausted(1, undefined)).toBe(true); // default attempts = 1
  });

  it('is not exhausted when no attempt has been made yet', () => {
    expect(isExhausted(undefined, 3)).toBe(false);
    expect(isExhausted(0, 3)).toBe(false);
  });
});
