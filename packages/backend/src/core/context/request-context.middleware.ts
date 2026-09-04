import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext, type RequestContext } from './request-context';

/**
 * Opens the ambient {@link RequestContext} for every request and keeps it open for the request's
 * whole async lifetime.
 *
 * Runs immediately after `correlationIdMiddleware` (main.ts), so `req.correlationId` is already
 * set. It captures the transport facts known before authentication — client IP (resolved through
 * `trust proxy`), user-agent, method, route, request id — and then calls `next()` INSIDE
 * `runWithRequestContext`, which is what makes the store propagate through every downstream guard,
 * interceptor, controller and service on this request. The authenticated actor is added later, by
 * `RequestContextInterceptor`, once the JWT guard has resolved the principal.
 *
 * Nothing here can throw the request off course: it only reads headers and opens an async scope.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const context: RequestContext = {
    ipAddress: req.ip || req.socket?.remoteAddress || undefined,
    userAgent: (req.headers['user-agent'] as string | undefined) || undefined,
    requestId: (req as any).correlationId as string | undefined,
    method: req.method,
    // `route.path` is only populated after routing; `originalUrl` is always present. The path
    // (no query string) is enough for access-log context and never carries PII in this API.
    route: req.originalUrl?.split('?')[0],
  };
  runWithRequestContext(context, () => next());
}
