import { JwtService } from '@nestjs/jwt';

/**
 * The one code path that checks an access token's signature and expiry, with no account lookup
 * attached. Three call-sites legitimately hold a `JwtService` and call this directly — the login
 * flow's own strategy, the realtime gateway's handshake, and the global rate-limiter's tracker —
 * because each needs to know "is this validly signed" before anything else (a DB read, a
 * decision to fall back to IP-based tracking) can happen. Before this, each re-implemented the
 * same try/verify/catch-returns-null shape independently, which is what let the throttler guard
 * drift onto the sync `.verify()` call while the gateway used `.verifyAsync()` — harmless today,
 * but two copies of "how do we check a token" is exactly the kind of thing that stops being
 * harmless the day one of them needs to change (e.g. to also reject a token whose `alg` doesn't
 * match what was configured).
 *
 * Never throws: a missing/expired/forged token is an ordinary, expected outcome for every caller
 * here (an anonymous socket, an unauthenticated HTTP request), not an exceptional one.
 */
export async function verifyAccessToken<T extends object = Record<string, unknown>>(
  jwt: JwtService,
  token: string,
): Promise<T | null> {
  try {
    return await jwt.verifyAsync<T>(token);
  } catch {
    return null;
  }
}
