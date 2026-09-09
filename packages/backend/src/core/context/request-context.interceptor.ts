import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { updateRequestContext } from './request-context';

/**
 * Fills the ambient request context with the authenticated actor.
 *
 * The middleware opens the context with transport facts (IP, user-agent, request id) before anyone
 * is known. Guards run next and attach the resolved principal to `req.user`. Interceptors run after
 * guards, so this is the first place the actor is known while the request's async scope is still
 * open — it merges `userId`, `role`, `displayName` and `sessionId` into the same store object, so
 * every audit event recorded downstream names who acted without the call site having to say.
 *
 * Reads defensively: an unauthenticated route (login, health) simply has no `req.user`, and the
 * context keeps its anonymous transport facts.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const req = context.switchToHttp().getRequest();
      const user = req?.user;
      if (user) {
        // Roles arrive either as objects ({ name }) from the resolved principal or as bare strings.
        const roles: unknown[] = Array.isArray(user.roles) ? user.roles : [];
        // Both shapes, because both arrive: `RoleEntity[]` (`{ name }`) from a resolved staff
        // principal, bare strings inside a raw JWT payload, and a synthetic `[{ name: 'ASSAYER' }]`
        // for a field account. Reading only one shape would leave `roleNames` empty for the other,
        // and an empty roles list reads as "not a platform operator" — the safe direction for
        // tenant scoping, but silently wrong for an ADMIN, so both are handled here rather than
        // hoped for.
        const roleNames = roles
          .map((r) => (typeof r === 'string' ? r : (r as { name?: string })?.name))
          .filter((n): n is string => typeof n === 'string' && n.length > 0);
        const primaryRole = roleNames[0];
        updateRequestContext({
          userId: typeof user.id === 'string' ? user.id : undefined,
          role: primaryRole ?? undefined,
          roleNames,
          /**
           * The tenant every organisation-scoped query filters on, taken from the principal the
           * JWT guard resolved and from nowhere else.
           *
           * This runs after guards, so `req.user` is the authenticated principal rather than
           * anything the caller sent. That ordering is the whole security property: an
           * `organizationId` read from a query string, header or body would be a filter the
           * attacker chooses, which is worse than no filter at all because it looks like one.
           */
          organizationId:
            typeof user.organizationId === 'string' && user.organizationId.length > 0
              ? user.organizationId
              : undefined,
          displayName: user.displayName ?? user.display_name ?? user.username ?? undefined,
          // `sid` is the durable session claim added to the access token; absent until the
          // session store lands, at which point every request carries it.
          sessionId: user.sid ?? user.sessionId ?? undefined,
        });
      }
    }
    return next.handle();
  }
}
