import { scrubPii, sanitizeTelemetryEvent } from './telemetry-scrub';

/**
 * Telemetry's whole safety rests on this: a click log must never carry personal data. The scrubber
 * is the backstop behind a client that already sends descriptors not values, so it is tested
 * aggressively — every PII shape this system holds must be redacted, and the event sanitizer must
 * drop anything off the allowlist and refuse to store nested/large metadata.
 */
describe('telemetry PII scrubbing', () => {
  it('redacts every PII shape the system holds', () => {
    expect(scrubPii('mailed anita@example.com about it')).not.toContain('anita@example.com');
    expect(scrubPii('PAN ABCDE1234F on file')).not.toMatch(/ABCDE1234F/);
    expect(scrubPii('IFSC HDFC0001234 branch')).not.toMatch(/HDFC0001234/);
    expect(scrubPii('phone 9876543210')).not.toMatch(/9876543210/);
    expect(scrubPii('aadhaar 123456789012')).not.toMatch(/123456789012/);
    expect(scrubPii('acct 000123456789 balance')).not.toMatch(/000123456789/);
  });

  it('leaves genuinely non-PII descriptors intact', () => {
    expect(scrubPii('Sign out button')).toBe('Sign out button');
    expect(scrubPii('Filter: status=ACTIVE')).toBe('Filter: status=ACTIVE');
  });

  it('caps very long strings', () => {
    expect(scrubPii('x'.repeat(500)).length).toBeLessThanOrEqual(160);
  });
});

describe('sanitizeTelemetryEvent', () => {
  it('accepts an allowlisted event and scrubs its fields', () => {
    const clean = sanitizeTelemetryEvent({
      eventType: 'ACTION',
      path: '/hr/roster',
      label: 'Opened record for anita@example.com',
      meta: { tab: 'pay', count: 3, ok: true },
    });
    expect(clean).not.toBeNull();
    expect(clean!.label).not.toContain('anita@example.com');
    expect(clean!.metadata).toEqual({ tab: 'pay', count: 3, ok: true });
  });

  it('drops an event whose type is not on the allowlist', () => {
    expect(sanitizeTelemetryEvent({ eventType: 'KEYSTROKE' as any, label: 'x' })).toBeNull();
    expect(sanitizeTelemetryEvent({ eventType: undefined, label: 'x' })).toBeNull();
  });

  it('drops nested or non-primitive metadata so nothing large can smuggle data through', () => {
    const clean = sanitizeTelemetryEvent({
      eventType: 'FILTER',
      meta: { nested: { a: 1 }, arr: [1, 2], big: 'x'.repeat(500), keep: 'status' } as any,
    });
    expect(clean!.metadata).toEqual({ big: 'x'.repeat(160), keep: 'status' }); // strings kept (scrubbed/capped), object/array dropped
    expect((clean!.metadata as any).nested).toBeUndefined();
    expect((clean!.metadata as any).arr).toBeUndefined();
  });
});
