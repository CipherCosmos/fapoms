import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { ResilientThrottlerStorage } from './resilient-throttler-storage';
import { UserAwareThrottlerGuard } from './user-aware-throttler.guard';

/**
 * The two properties that make the limiter safe to run globally:
 *  - it never takes the API down when its storage does;
 *  - it keys on a VERIFIED identity, so a forged token cannot mint itself an unlimited budget,
 *    and falls back to the (proxy-resolved) client address otherwise.
 */
describe('ResilientThrottlerStorage', () => {
  it('returns "not blocked" and counts a fail-open when the inner storage throws', async () => {
    const inner = { increment: jest.fn().mockRejectedValue(new Error('Command timed out')) };
    const failOpen = jest.fn();
    const storage = new ResilientThrottlerStorage(inner, failOpen);

    const record = await storage.increment('k', 60_000, 300, 0, 'default');

    expect(record).toEqual({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 });
    expect(failOpen).toHaveBeenCalledTimes(1);
  });

  it('passes a healthy storage straight through', async () => {
    const healthy = { totalHits: 3, timeToExpire: 42, isBlocked: false, timeToBlockExpire: 0 };
    const inner = { increment: jest.fn().mockResolvedValue(healthy) };
    const storage = new ResilientThrottlerStorage(inner);

    await expect(storage.increment('k', 60_000, 300, 0, 'default')).resolves.toBe(healthy);
  });
});

describe('UserAwareThrottlerGuard tracker', () => {
  const secret = 'test-secret-that-is-long-enough-for-hs256';
  const config = { get: (_k: string, d?: string) => secret ?? d } as any;
  const metrics = { httpThrottled: { inc: jest.fn() } } as any;
  const options = { throttlers: [{ ttl: 60_000, limit: 300 }] } as any;
  const storage = { increment: jest.fn() } as any;

  const guard = new UserAwareThrottlerGuard(options, storage, new Reflector(), config, metrics);
  const tracker = (req: any) => (guard as any).getTracker(req) as Promise<string>;

  it('keys an authenticated request by the token subject', async () => {
    const token = new JwtService({ secret }).sign({ sub: 'user-123' });
    await expect(tracker({ ip: '203.0.113.9', headers: { authorization: `Bearer ${token}` } })).resolves.toBe(
      'user:user-123',
    );
  });

  it('does NOT trust a token signed with another secret — falls back to the address', async () => {
    const forged = new JwtService({ secret: 'someone-elses-secret-someone-elses-secret' }).sign({ sub: 'attacker' });
    await expect(tracker({ ip: '203.0.113.9', headers: { authorization: `Bearer ${forged}` } })).resolves.toBe(
      'ip:203.0.113.9',
    );
  });

  it('keys an unauthenticated request by the address', async () => {
    await expect(tracker({ ip: '198.51.100.7', headers: {} })).resolves.toBe('ip:198.51.100.7');
  });
});
