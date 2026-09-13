import { Logger } from '@nestjs/common';
import { handleUnhandledRejection } from './main';

/**
 * Covers the fire-and-forget-task-failed path directly, rather than through `process.on(...)` —
 * attaching a real listener to the shared `unhandledRejection` emitter in a test would leak across
 * every other spec file sharing this Jest worker. `installProcessGuards` itself is a two-line
 * wrapper around this function and isn't separately tested.
 */
describe('handleUnhandledRejection', () => {
  function mockLogger(): Logger {
    return { error: jest.fn() } as unknown as Logger;
  }

  it('logs the rejection with its message and stack', () => {
    const logger = mockLogger();
    const alerter = { report: jest.fn() };
    const err = new Error('background task blew up');

    handleUnhandledRejection(err, logger, alerter);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('background task blew up'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(err.stack!.split('\n')[0]));
  });

  it('logs a non-Error rejection by its string form', () => {
    const logger = mockLogger();
    const alerter = { report: jest.fn() };

    handleUnhandledRejection('a plain rejected string', logger, alerter);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('a plain rejected string'));
  });

  it('reports the fault to the alerter so it does not sit unread in the log — Error case', () => {
    const logger = mockLogger();
    const alerter = { report: jest.fn() };

    handleUnhandledRejection(new TypeError('boom'), logger, alerter);

    expect(alerter.report).toHaveBeenCalledWith({
      method: 'PROCESS',
      route: '/unhandled-rejection',
      errorName: 'TypeError',
    });
  });

  it('reports a non-Error rejection with a generic name rather than skipping the alert', () => {
    const logger = mockLogger();
    const alerter = { report: jest.fn() };

    handleUnhandledRejection({ not: 'an error' }, logger, alerter);

    expect(alerter.report).toHaveBeenCalledWith({
      method: 'PROCESS',
      route: '/unhandled-rejection',
      errorName: 'UnhandledRejection',
    });
  });

  it('defaults to the real errorAlerter singleton when none is passed', () => {
    // Only checks the default parameter resolves to something callable — does not exercise the
    // real singleton's network path (ALERT_WEBHOOK_URL is unset in the test environment, so
    // `report()` returns immediately; see error-alerter.ts).
    const logger = mockLogger();
    expect(() => handleUnhandledRejection(new Error('x'), logger)).not.toThrow();
  });
});
