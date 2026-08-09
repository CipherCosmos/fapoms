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
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

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
      }
      res.status(status).json(payload);
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

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      correlationId,
    });
  }
}
