import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { EventCategory } from '@fapoms/shared';
import { AuditService } from './audit.service';
import { NOT_A_RECORD_ENTITY_ID, type AuditOutcome } from './audit-event';
import { AUDIT_READ_KEY, type AuditReadOptions } from './audit-read.decorator';

/**
 * Writes one access-log entry for every successful read of data marked with `@AuditRead`.
 *
 * This closes the largest compliance gap in the trail: today only the sensitive-field *unmask* is
 * logged, so "who viewed appraiser X's profile / this customer record" is unanswerable, which makes
 * a breach impossible to scope. The interceptor records the ACCESS — actor, role, session, IP and
 * request id all come from the ambient request context; the record identity comes from the route
 * param the decorator names — and never the VALUE that was read, so the access log cannot become a
 * second store of the very data it guards.
 *
 * Runs globally but does nothing unless the handler carries the decorator, so it is free on the
 * vast majority of requests. A read that throws is logged too, with outcome FAILURE — or DENIED for
 * a 403 raised inside the handler/service — so refused access attempts are visible, not only
 * successful ones. (A 403 from a guard short-circuits before any interceptor runs; guard-level
 * denials are logged separately.)
 */
@Injectable()
export class AuditReadInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const options = this.reflector.getAllAndOverride<AuditReadOptions | undefined>(AUDIT_READ_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return next.handle();

    const req = context.switchToHttp().getRequest();
    const entityId =
      (options.idParam && req?.params?.[options.idParam]) || NOT_A_RECORD_ENTITY_ID;
    const eventType = options.eventType ?? `${options.resource}_VIEWED`;

    const write = (outcome: AuditOutcome) => {
      // recordEventSafe: an access-log write must never fail the read it is logging, but a gap in
      // the access log for an audit business is exactly the failure that must not be silent.
      void this.audit.recordEventSafe({
        category: EventCategory.DATA_ACCESS,
        eventType,
        entityType: options.resource,
        entityId,
        outcome,
        // Actor / IP / role / session / requestId are filled from the ambient context by
        // AuditService. Only non-sensitive read context is added here — never the returned data.
        metadata: this.readContext(req),
      });
    };

    return next.handle().pipe(
      tap({
        next: () => write('SUCCESS'),
        error: (err) => write(err instanceof HttpException && err.getStatus() === 403 ? 'DENIED' : 'FAILURE'),
      }),
    );
  }

  /**
   * The non-sensitive shape of the read, for the access log: which route, and the query keys that
   * scoped a list/search (keys only — a value could be a name or an id being searched for). Never
   * the response body.
   */
  private readContext(req: any): Record<string, unknown> {
    const queryKeys = req?.query && typeof req.query === 'object' ? Object.keys(req.query) : [];
    return {
      access: 'READ',
      ...(req?.route?.path ? { route: req.route.path } : {}),
      ...(queryKeys.length ? { queryKeys } : {}),
    };
  }
}
