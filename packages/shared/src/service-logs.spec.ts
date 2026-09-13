import {
  LOG_SERVICES,
  LOG_SERVICE_NAMES,
  isKnownLogService,
  LOG_TAIL_DEFAULT,
  LOG_TAIL_MAX,
  LOG_RESPONSE_MAX_BYTES,
  LOG_STREAM_MAX_SECONDS,
} from './service-logs';

describe('isKnownLogService', () => {
  it('recognises every service actually in the catalogue', () => {
    for (const { service } of LOG_SERVICES) {
      expect(isKnownLogService(service)).toBe(true);
    }
  });

  it('is an ALLOWLIST — refuses a name that is not on it, including a plausible-looking guess', () => {
    // The file's own header says the point of this list is that a caller cannot reach an
    // arbitrary container by inventing a name. Verified against names an attacker might actually
    // try, not just an obviously-wrong string.
    expect(isKnownLogService('admin')).toBe(false);
    expect(isKnownLogService('shell')).toBe(false);
    expect(isKnownLogService('host')).toBe(false);
    expect(isKnownLogService('made-up-service')).toBe(false);
    expect(isKnownLogService('')).toBe(false);
  });

  it('is case-sensitive — the compose service name is the exact key, not a display label', () => {
    expect(isKnownLogService('Backend')).toBe(false);
    expect(isKnownLogService('BACKEND')).toBe(false);
  });
});

describe('LOG_SERVICE_NAMES', () => {
  it('is derived from LOG_SERVICES, not a second hand-typed list that could drift from it', () => {
    expect(LOG_SERVICE_NAMES).toEqual(LOG_SERVICES.map((s) => s.service));
    expect(LOG_SERVICE_NAMES.length).toBe(LOG_SERVICES.length);
  });

  it('has no duplicate service name', () => {
    expect(new Set(LOG_SERVICE_NAMES).size).toBe(LOG_SERVICE_NAMES.length);
  });
});

describe('logging ceilings', () => {
  // Pinned because a silent change to any of these widens what a caller can pull off the host —
  // more lines, further back, or a bigger single response — without anyone deciding it should.
  it('match the values this module documents', () => {
    expect(LOG_TAIL_DEFAULT).toBe(500);
    expect(LOG_TAIL_MAX).toBe(20_000);
    expect(LOG_RESPONSE_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(LOG_STREAM_MAX_SECONDS).toBe(30 * 60);
  });

  it('keeps the default tail within the max — a client asking for the default must never be over the ceiling', () => {
    expect(LOG_TAIL_DEFAULT).toBeLessThanOrEqual(LOG_TAIL_MAX);
  });
});
