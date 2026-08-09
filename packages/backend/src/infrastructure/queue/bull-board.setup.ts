import { createBullBoard } from '@bull-board/api';
import { BullAdapter } from '@bull-board/api/bullAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';

const logger = new Logger('BullBoard');

/**
 * HTTP Basic Auth middleware for the Bull Board UI.
 *
 * Bull Board is a human-facing dashboard, so Basic Auth (which the browser prompts for) is the
 * natural fit — unlike the token guard on `/metrics`. Comparison is constant-time.
 */
function basicAuth(user: string, pass: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
      if (u !== undefined && p !== undefined && safeEqual(u, user) && safeEqual(p, pass)) {
        next();
        return;
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="Bull Board"').status(401).send('Authentication required.');
  };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Mounts the Bull Board job dashboard at `/bull-board`.
 *
 * The dashboard exposes job payloads — which here carry document ids, assayer ids and
 * notification content — and lets an operator retry/remove jobs. It must never be reachable
 * unauthenticated in production. Behaviour:
 *   - `BULL_BOARD_USER` + `BULL_BOARD_PASSWORD` set → mounted behind Basic Auth (any environment).
 *   - unset in production → NOT mounted (fail-safe; a warning is logged).
 *   - unset in development → mounted without auth, for convenience.
 */
export function setupBullBoard(app: any) {
  const user = process.env.BULL_BOARD_USER;
  const pass = process.env.BULL_BOARD_PASSWORD;
  const isProduction = process.env.NODE_ENV === 'production';

  if ((!user || !pass) && isProduction) {
    logger.warn(
      'Bull Board disabled: set BULL_BOARD_USER and BULL_BOARD_PASSWORD to enable it in production. ' +
        'It exposes job payloads and job controls, so it is never mounted unauthenticated in production.',
    );
    return;
  }

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/bull-board');

  const queues = ['background-jobs', 'ocr', 'sla-scanner']
    .map((name) => {
      try {
        return app.get(`BullQueue_${name}`, { strict: false });
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (queues.length === 0) return;

  createBullBoard({
    queues: queues.map((q: any) => new BullAdapter(q)),
    serverAdapter,
  });

  const router = serverAdapter.getRouter();
  if (user && pass) {
    app.use('/bull-board', basicAuth(user, pass), router);
  } else {
    // Development only (production without credentials returned above).
    app.use('/bull-board', router);
  }
}
