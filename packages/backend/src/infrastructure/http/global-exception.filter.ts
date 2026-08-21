import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { CORRELATION_ID_HEADER } from './correlation-id.middleware';
import { errorAlerter, ErrorAlerter } from '../observability/error-alerter';

/**
 * The single HTTP error boundary for the API. There was none — Nest's default handler let
 * whatever reached the boundary serialise itself, so a TypeORM `QueryFailedError` surfaced to
 * the client as a 500 carrying the failing SQL and the constraint name, and ioredis/S3 errors
 * leaked their internals the same way.
 *
 * Two responsibilities:
 *  1. **Preserve the contract for deliberate HttpExceptions.** Same status, and the same body
 *     Nest already sends (the `class-validator` message array included), plus a `correlationId`.
 *     Nothing the frontend already parses changes shape.
 *  2. **Redact everything else.** A non-HttpException is unexpected/infrastructure. The full
 *     detail is logged server-side against the request's correlation id; the client gets a
 *     generic 500 that reveals nothing about the database, cache or storage internals.
 */
/**
 * Whether this failure is the client going away rather than the server going wrong.
 *
 * Express and multer both surface an aborted upload as a plain `Error` whose message is
 * `Request aborted`; a socket that dies mid-response arrives as one of the ECONN* codes. The
 * response object having no writable socket left is the corroborating signal, so a genuine
 * server error that merely happens to mention "aborted" is not swallowed.
 */
function isClientDisconnect(exception: unknown, res: Response): boolean {
  if (!(exception instanceof Error)) return false;
  const code = (exception as NodeJS.ErrnoException).code;
  if (code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'EPIPE') return true;
  return exception.message === 'Request aborted' && (res.destroyed || !res.writable);
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  /** Injectable for tests; the default is the process-wide instance. */
  constructor(private readonly alerter: ErrorAlerter = errorAlerter) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    // Only HTTP is handled here; let non-HTTP contexts (e.g. websockets) fall through.
    if (host.getType() !== 'http') {
      throw exception;
    }

    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const correlationId =
      (req as any)?.correlationId ?? res.getHeader(CORRELATION_ID_HEADER) ?? undefined;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const payload =
        typeof body === 'object' && body !== null
          ? { ...(body as Record<string, unknown>), correlationId }
          : { statusCode: status, message: body, correlationId };

      // 4xx are ordinary client errors and would only be noise; 5xx HttpExceptions are worth a line.
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
        this.logger.error(
          `[${correlationId}] ${req.method} ${req.originalUrl} -> ${status}: ${JSON.stringify(body)}`,
        );
        this.alerter.report({
          method: req.method,
          route: req.originalUrl,
          errorName: exception.constructor?.name ?? 'HttpException',
          correlationId: correlationId as string | undefined,
        });
      }
      res.status(status).json(payload);
      return;
    }

    /**
     * The reader hung up. Not an error on this side, and nothing left to reply to.
     *
     * A browser that navigates away, a phone that loses signal mid-upload, a user who gives up
     * on a slow attachment — each aborts the request, and Express surfaces that as a thrown
     * `Request aborted`. Treating it as a 500 logged a server fault for something the server
     * did nothing wrong in, alarmed whoever read the log, and paged the alerter. It also tried
     * to write a response body onto a socket that is already gone.
     *
     * The connection is closed, so this only stops the noise; there is no client left to tell.
     */
    if (isClientDisconnect(exception, res)) {
      this.logger.warn(
        `[${correlationId}] ${req.method} ${req.originalUrl} — client disconnected before the request completed`,
      );
      return;
    }

    // Not an HttpException — unexpected. Log the real error, return nothing revealing.
    const detail =
      exception instanceof QueryFailedError
        ? `QueryFailedError: ${exception.message}`
        : exception instanceof Error
          ? `${exception.name}: ${exception.message}`
          : String(exception);
    this.logger.error(
      `[${correlationId}] ${req.method} ${req.originalUrl} -> 500: ${detail}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    // The class name only. `detail` above carries the exception's message, and on this system a
    // message routinely contains the data that caused it — a failed query includes its values,
    // and those values are customer records. That stays in the log on the host.
    this.alerter.report({
      method: req.method,
      route: req.originalUrl,
      errorName: exception instanceof Error ? exception.name : 'UnknownError',
      correlationId: correlationId as string | undefined,
    });

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      correlationId,
    });
  }
}
