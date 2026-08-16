import { ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerLimitDetail,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { MetricsService } from '../../observability/metrics.service';

/**
 * Rate limiting keyed by WHO is calling, not by which proxy forwarded the call.
 *
 * ## The bug this replaces
 *
 * The stock guard keys every counter on `req.ip`. Express does not trust proxy headers unless
 * told to, so behind Caddy `req.ip` is Caddy's own address for every request — the whole
 * organisation was one caller. The global 300 requests/minute became an organisation-wide
 * ceiling (an Assignments page fires ~15 requests on mount; a handful of active operators trip
 * it), and `POST /auth/login` at 20/minute meant twenty logins per minute for everyone combined.
 * Verified 2026-08-16: 429s from one address past 300/min, and no `trust proxy` anywhere.
 * `main.ts` now sets `trust proxy`, which fixes `req.ip`; this guard fixes what the counter is
 * keyed on.
 *
 * ## The key
 *
 * - A request carrying a VALID access token is tracked as `user:<sub>` — one budget per person,
 *   however many share an office NAT or a Tailscale exit.
 * - Anything else (no token, expired, forged) is tracked as `ip:<req.ip>` — the client's real
 *   address now that the proxy is trusted. This is what protects `/auth/login`.
 *
 * The token is verified, not merely decoded: an unverified `sub` would let anyone mint an
 * unlimited number of "users" and bypass the limit entirely. HS256 verification is a hash — far
 * cheaper than the Redis round trip that follows it. Verification here does not authenticate the
 * request; `JwtAuthGuard` still does that later, with the same secret.
 *
 * ## Visibility
 *
 * Guards run before the metrics interceptor, so a 429 was invisible on `/metrics` — the
 * organisation-wide ceiling could not have been seen even by someone looking. Every throttled
 * request now increments `http_throttled_total{route,tracker}`.
 */
@Injectable()
export class UserAwareThrottlerGuard extends ThrottlerGuard {
  private readonly jwt: JwtService;

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    config: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    super(options, storage, reflector);
    // Same secret as AuthModule's JwtModule; constructed locally so a global guard does not
    // have to import the auth module graph.
    this.jwt = new JwtService({ secret: config.get<string>('JWT_SECRET', 'dev-secret') });
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const auth = req?.headers?.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      try {
        const payload = this.jwt.verify<{ sub?: string; id?: string }>(auth.slice(7));
        const sub = payload?.sub ?? payload?.id;
        if (sub) return `user:${sub}`;
      } catch {
        // Not a valid token → fall through to the address. An expired token on a refresh call is
        // the common case here, and refresh is deliberately IP-limited.
      }
    }
    return `ip:${req?.ip ?? 'unknown'}`;
  }

  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const req = context.switchToHttp().getRequest();
    const route = req?.route?.path ?? req?.originalUrl?.split('?')[0] ?? 'unknown';
    this.metrics.httpThrottled.inc({ route, tracker: detail.tracker.startsWith('user:') ? 'user' : 'ip' });
    return super.throwThrottlingException(context, detail);
  }
}
