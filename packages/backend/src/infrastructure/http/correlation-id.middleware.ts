import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Assigns every request a correlation id.
 *
 * It is reused from an inbound `x-correlation-id` / `x-request-id` when present — so a trace
 * begun at the edge (load balancer, gateway, or the calling client) carries straight through —
 * and generated otherwise. The id is attached to the request object and echoed in the response
 * header, so the client, the exception filter and the logs can all name the same request.
 *
 * This is the thread that lets one production incident be followed across the API → queue →
 * worker boundary. Propagation into Bull jobs and worker logs builds on this and is a follow-up.
 */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound =
    (req.headers[CORRELATION_ID_HEADER] as string | undefined) ??
    (req.headers['x-request-id'] as string | undefined) ??
    '';
  const correlationId = inbound.trim() || randomUUID();
  (req as any).correlationId = correlationId;
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  next();
}
