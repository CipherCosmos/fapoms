import { ErrorAlerter, alertKey } from './error-alerter';

const alert = (over: Partial<Parameters<ErrorAlerter['report']>[0]> = {}) => ({
  method: 'POST',
  route: '/api/v1/documents/mobile-upload-binary',
  errorName: 'QueryFailedError',
  correlationId: 'abc-123',
  ...over,
});

/** Captures what would go over the wire. */
function harness(opts: { windowMs?: number; maxPerWindow?: number } = {}) {
  const sent: string[] = [];
  const alerter = new ErrorAlerter(
    'https://example.invalid/hook',
    opts.windowMs ?? 60_000,
    opts.maxPerWindow ?? 10,
    async (_url, body) => {
      sent.push(body);
    },
  );
  return { alerter, sent };
}

describe('ErrorAlerter', () => {
  it('does nothing at all when no webhook is configured', () => {
    const sent: string[] = [];
    const alerter = new ErrorAlerter(undefined, 60_000, 10, async (_u, b) => {
      sent.push(b);
    });

    alerter.report(alert());

    expect(alerter.enabled).toBe(false);
    expect(sent).toEqual([]);
  });

  it('sends where it broke and which correlation id to look up', () => {
    const { alerter, sent } = harness();

    alerter.report(alert());

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('POST /api/v1/documents/mobile-upload-binary');
    expect(sent[0]).toContain('QueryFailedError');
    expect(sent[0]).toContain('abc-123');
  });

  describe('what must never leave the host', () => {
    // A webhook is a third party reached over the public internet. Exception messages on this
    // system routinely carry the data that caused them — a failing query includes its values, and
    // those values are bank customer records. The alert names the place, never the payload.
    it('carries no exception message, stack or parameter', () => {
      const { alerter, sent } = harness();

      alerter.report({
        method: 'POST',
        route: '/api/v1/customers',
        // Whatever the caller passes as the *name* is all the reporter is given; the filter is
        // what guarantees a message never reaches here, and its own test covers that.
        errorName: 'QueryFailedError',
        correlationId: 'c-1',
      });

      expect(sent[0]).not.toMatch(/PAN|ABCDE|account|password|SELECT|INSERT/i);
    });
  });

  describe('repeat suppression', () => {
    it('reports a repeating fault once per window, not once per request', () => {
      const { alerter, sent } = harness({ windowMs: 60_000 });

      alerter.report(alert(), 0);
      for (let i = 1; i <= 50; i++) alerter.report(alert(), i * 100);

      expect(sent).toHaveLength(1);
    });

    it('reports again after the window, carrying what was held back', () => {
      const { alerter, sent } = harness({ windowMs: 60_000 });

      alerter.report(alert(), 0);
      alerter.report(alert(), 1_000);
      alerter.report(alert(), 2_000);
      alerter.report(alert(), 61_000);

      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain('+2 more');
    });

    it('treats the same fault on different records as one fault', () => {
      // Otherwise a broken endpoint sends one alert per assignment id and buries everything else.
      const { alerter, sent } = harness();

      alerter.report(alert({ route: '/api/v1/assignments/8f14e45f-ceea-467a-9f4c-1c2d3e4f5a6b' }), 0);
      alerter.report(alert({ route: '/api/v1/assignments/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed' }), 100);
      alerter.report(alert({ route: '/api/v1/assignments/42' }), 200);

      expect(sent).toHaveLength(1);
    });

    it('still distinguishes genuinely different faults', () => {
      const { alerter, sent } = harness();

      alerter.report(alert({ errorName: 'QueryFailedError' }), 0);
      alerter.report(alert({ errorName: 'TimeoutError' }), 100);
      alerter.report(alert({ route: '/api/v1/billing' }), 200);

      expect(sent).toHaveLength(3);
    });
  });

  it('caps total volume so a database outage cannot bury the signal', () => {
    // Postgres falling over produces a distinct failure on every route at once. Reporting each
    // one faithfully is how an operator gets rate-limited out of their own alerts.
    const { alerter, sent } = harness({ maxPerWindow: 3 });

    for (let i = 0; i < 20; i++) {
      alerter.report(alert({ route: `/api/v1/route-${i}` }), i);
    }

    expect(sent).toHaveLength(3);
  });

  it('never lets a broken webhook break the request path', () => {
    // This runs inside the exception filter. An alerter that can throw turns every 500 into a
    // crash, which is strictly worse than having no alerting.
    const alerter = new ErrorAlerter('https://example.invalid/hook', 60_000, 10, async () => {
      throw new Error('connection refused');
    });

    expect(() => alerter.report(alert())).not.toThrow();
  });

  describe('alertKey', () => {
    it('collapses uuids and numeric ids', () => {
      expect(alertKey(alert({ route: '/api/v1/assignments/8f14e45f-ceea-467a-9f4c-1c2d3e4f5a6b/expenses' })))
        .toBe('POST /api/v1/assignments/:id/expenses QueryFailedError');
    });

    it('ignores the query string', () => {
      expect(alertKey(alert({ route: '/api/v1/documents?assessmentId=abc&t=99' })))
        .toBe('POST /api/v1/documents QueryFailedError');
    });
  });
});
