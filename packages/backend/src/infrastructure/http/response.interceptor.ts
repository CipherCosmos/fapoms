import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
  StreamableFile,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { Response } from 'express';
import type { ApiResponse } from '@fapoms/shared';

export const NO_ENVELOPE_KEY = 'noEnvelope';

/**
 * Marks a route whose body is an infrastructure contract rather than an API response.
 *
 * The envelope exists for API clients. A liveness probe is not an API client: `/health` and
 * `/health/ready` are read by load balancers, container healthchecks and orchestrators, which
 * are configured out-of-band and cannot be redeployed in lockstep with the application. Their
 * body shape is part of the deployment contract, so it stays exactly as it is.
 *
 * Explicit and greppable, in the same spirit as `@Public()` and `@AnyAuthenticated()` — a
 * route that opts out should have to say so.
 */
export const NoEnvelope = () => SetMetadata(NO_ENVELOPE_KEY, true);

/**
 * True when a handler already returned the standard envelope itself.
 *
 * The test is the presence of a boolean `success`, not a deep shape match, because the
 * existing hand-written envelopes are not uniform: most are `{ success, data }`, some carry
 * `meta` or `pagination` alongside, and at least one (`POST /documents`) adds a sibling
 * `documentUrl`. All of those are already-enveloped and must pass through untouched — with
 * their extra keys intact, since the clients read them.
 */
function isAlreadyEnveloped(body: unknown): body is ApiResponse<unknown> {
  return (
    typeof body === 'object' &&
    body !== null &&
    'success' in body &&
    typeof (body as { success: unknown }).success === 'boolean'
  );
}

/**
 * Wraps handler return values in the shared `ApiResponse<T>` envelope.
 *
 * ## Why it is idempotent rather than a rewrite
 *
 * `shared/api-contracts.ts` has defined `ApiResponse<T>` since the beginning and **nothing
 * imports it**. Instead all 31 controllers hand-build `{ success: true, data }` at 285
 * separate `return` statements, which is why two incompatible pagination shapes
 * (`{ pagination: … }` and `{ meta: … }`) already coexist.
 *
 * A naive interceptor would wrap those a second time and ship `{success, data:{success, data}}`
 * to a frontend whose `ApiClient.request()` ends in `return res.data` — every screen in the
 * web app and every call in the field app would break at once, and the only way to avoid it
 * would be to de-envelope 285 call sites in the same change.
 *
 * So this passes an existing envelope straight through and wraps only what is not enveloped.
 * That makes it deployable on its own today, and lets controllers be de-enveloped
 * incrementally afterwards — each one becoming correct the moment it stops hand-rolling the
 * wrapper, with no coordinated release and no window where the two are inconsistent.
 *
 * ## What it deliberately does not touch
 *
 * - **Handlers using `@Res()`** — document downloads, the metrics scrape, attachment streams.
 *   They write to the response themselves, so by the time this runs the bytes are already on
 *   the wire; re-serialising would throw `ERR_HTTP_HEADERS_SENT`. Detected via `headersSent`.
 * - **`StreamableFile`** — Nest pipes these itself; an envelope would destroy the stream.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T> | T> {
  constructor(private readonly reflector?: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T> | T> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const optedOut = this.reflector?.getAllAndOverride<boolean>(NO_ENVELOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (optedOut) return next.handle();

    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((body) => {
        // The handler took over the response object (@Res, res.send, res.pipe).
        if (response.headersSent) return body;

        if (body instanceof StreamableFile) return body;

        if (isAlreadyEnveloped(body)) return body as unknown as ApiResponse<T>;

        // `undefined` from a void handler becomes an explicit null rather than an empty
        // body, so a client never has to distinguish "no content" from "malformed response".
        return { success: true, data: (body ?? null) as T };
      }),
    );
  }
}
