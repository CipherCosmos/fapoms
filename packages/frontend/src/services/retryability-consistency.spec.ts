import { fromResponse, classifyError, translateError } from './errors';

/**
 * Whether a failure is worth retrying must not depend on whether the server sent prose.
 *
 * `fromResponse` seeds `category` from the status (`system-failure` for any 5xx), then only
 * consults `BY_STATUS` — where 429, 502, 503 and 504 are `retryable` — inside `if (!friendly)`.
 * A human-readable server message fills `friendly` first, so that lookup is skipped and the
 * seeded `system-failure` survives.
 *
 * The effect is that the same 503 is retryable or not depending on whether the backend included
 * a sentence, and a screen asking `classifyError(...).isRetryable` offers or withholds a Retry
 * button on that basis.
 */
describe('retryability does not depend on whether the server sent a message', () => {
  const RETRYABLE_STATUSES = [502, 503, 504];

  for (const status of RETRYABLE_STATUSES) {
    it(`treats a ${status} the same way with and without a server message`, () => {
      const bare = fromResponse(status, {});
      const withProse = fromResponse(status, { message: 'The upstream service is restarting, please try shortly.' });

      expect(classifyError(withProse).isRetryable).toBe(classifyError(bare).isRetryable);
    });
  }

  /** The same question asked of the other reader, which screens were moved onto. */
  for (const status of RETRYABLE_STATUSES) {
    it(`translateError agrees with itself for a ${status}`, () => {
      const bare = fromResponse(status, {});
      const withProse = fromResponse(status, { message: 'The upstream service is restarting, please try shortly.' });

      expect(translateError(withProse).retryable).toBe(translateError(bare).retryable);
    });
  }

  /** A 500 is deliberately not retryable — pin that, so a fix here does not quietly widen it. */
  it('still does not offer to retry a 500, with or without a message', () => {
    expect(classifyError(fromResponse(500, {})).isRetryable).toBe(false);
    expect(classifyError(fromResponse(500, { message: 'Internal server error' })).isRetryable).toBe(false);
  });
});
