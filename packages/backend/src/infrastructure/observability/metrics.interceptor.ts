import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

/**
 * Records request rate, error rate and latency for every HTTP request.
 *
 * Labels use the matched route *pattern* (e.g. `/assignments/:id`), never the raw
 * URL, so per-id paths do not explode the metric cardinality — the classic way a
 * naive HTTP metric takes down the metrics backend it was meant to protect.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest();
    const start = process.hrtime.bigint();

    const record = (status: number) => {
      const route =
        req.route?.path ?? req.routeOptions?.url ?? req.baseUrl ?? 'unmatched';
      const labels = {
        method: req.method ?? 'UNKNOWN',
        route: String(route),
        status: String(status),
      };
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.metrics.httpDuration.observe(labels, seconds);
      this.metrics.httpTotal.inc(labels);
    };

    return next.handle().pipe(
      tap(() => record(http.getResponse()?.statusCode ?? 200)),
      catchError((err) => {
        record(Number(err?.status) || 500);
        return throwError(() => err);
      }),
    );
  }
}
