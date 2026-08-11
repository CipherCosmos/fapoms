import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

/**
 * Guards the Prometheus scrape endpoint with a static bearer token.
 *
 * `/metrics` was unauthenticated — route-labelled metrics disclose the API surface and traffic
 * shape. A role/JWT guard is the wrong tool here (a scraper holds no session token), so this
 * checks a dedicated `METRICS_TOKEN` sent as `Authorization: Bearer <token>` — exactly what
 * Prometheus's `bearer_token` config sends.
 *
 * When `METRICS_TOKEN` is unset the guard is a no-op, so local/dev scraping keeps working and
 * operators who instead restrict `/metrics` at the network layer are not forced into a token.
 * Production should set it (see `.env.production.example`).
 */
@Injectable()
export class MetricsAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('METRICS_TOKEN');
    if (!expected) return true; // not configured → rely on network-level restriction

    const req = context.switchToHttp().getRequest();
    const header: string = req?.headers?.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (provided && safeEqual(provided, expected)) return true;
    throw new UnauthorizedException('A valid metrics token is required.');
  }
}

/** Constant-time string comparison that tolerates differing lengths without throwing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
