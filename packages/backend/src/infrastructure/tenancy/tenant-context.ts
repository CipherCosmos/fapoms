import { ForbiddenException, Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { SystemRole } from '@fapoms/shared';

/**
 * The shape this needs from `req.user`, which `JwtStrategy.validate` populates.
 *
 * `roles` arrives in two forms depending on the path: `RoleEntity[]` from
 * `AuthService.validateJwtPayload`, and `string[]` inside the raw JWT payload. Both are
 * accepted rather than one being normalised somewhere else, because getting this wrong
 * fails open — an unrecognised role shape would read as "no roles", and a principal with
 * no roles is not cross-tenant, so the failure direction is at least safe.
 */
export interface TenantPrincipal {
  id?: string;
  organizationId?: string | null;
  roles?: Array<{ name?: string } | string> | null;
}

interface RequestWithPrincipal {
  user?: TenantPrincipal | null;
}

/**
 * Roles that legitimately read across every organisation.
 *
 * Deliberately just the platform operator. ADMINISTRATOR is an *organisation* administrator,
 * not a platform one — including it would make tenant isolation meaningless for the role most
 * likely to hold it.
 */
const CROSS_TENANT_ROLES: string[] = [SystemRole.ADMIN];

/**
 * The organisation the current request belongs to.
 *
 * ## Why this replaces `TenantContextResolver`
 *
 * The class this supersedes was a plain `@Injectable()` — which in Nest means a **singleton**,
 * one instance for the whole process — holding per-request state in a mutable field:
 *
 * ```ts
 * @Injectable()
 * export class TenantContextResolver {
 *   private currentContext: TenantContext | null = null;   // process-wide
 *   setContext(c) { this.currentContext = c; }
 * }
 * ```
 *
 * Under Node's concurrency model request A's `setContext` is visible to request B at every
 * `await` boundary in between. Wired into a query filter it would have served one
 * organisation's data to another organisation's user, intermittently and unreproducibly —
 * the worst possible failure for the worst possible thing to get wrong. It was never
 * consumed, and that is the only reason it never leaked.
 *
 * `Scope.REQUEST` makes the leak structurally impossible: Nest constructs one instance per
 * request, bound to that request's own `user`. There is no setter, because there is nothing
 * to set — the principal is read from the request the container handed us.
 *
 * ## The cost, stated plainly
 *
 * Request scope is contagious. Any provider that injects this becomes request-scoped, and so
 * does anything injecting *that*, up to the controller — a fresh instantiation chain per
 * request instead of a singleton. That is the price of correctness here and it is worth
 * paying, but it is a reason to inject this narrowly (repositories and the services that own
 * tenant-owned data), not everywhere.
 *
 * ## What this does NOT cover
 *
 * Bull workers and scheduled jobs have no request, so they cannot resolve a tenant this way.
 * Background work that touches tenant-owned data must carry the organisation id explicitly in
 * its job payload and pass it down. An `AsyncLocalStorage`-based context would cover both
 * surfaces without the scope bubbling; it is the natural next step if the request-scope cost
 * shows up in profiling or if workers start needing the same scoping.
 */
@Injectable({ scope: Scope.REQUEST })
export class TenantContext {
  constructor(@Inject(REQUEST) private readonly request: RequestWithPrincipal) {}

  /** The authenticated principal, or null on an unauthenticated route. */
  get principal(): TenantPrincipal | null {
    return this.request?.user ?? null;
  }

  /** The organisation this request acts within, or null if the principal carries none. */
  get organizationId(): string | null {
    return this.principal?.organizationId ?? null;
  }

  /** Role names, normalised across the two shapes `req.user.roles` arrives in. */
  get roleNames(): string[] {
    const roles = this.principal?.roles;
    if (!Array.isArray(roles)) return [];
    return roles
      .map((r) => (typeof r === 'string' ? r : r?.name))
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
  }

  /** True when this principal may read across organisations. */
  get isCrossTenant(): boolean {
    return this.roleNames.some((r) => CROSS_TENANT_ROLES.includes(r));
  }

  /**
   * The organisation id, or a refusal.
   *
   * Callers that scope data must not be able to proceed without an answer. Returning null
   * here would let a caller quietly skip its `WHERE` clause, which is precisely the bug this
   * class exists to prevent — so an un-scoped principal is refused instead.
   *
   * Note for adoption: `organization_id` is nullable on every entity that has it and most
   * existing rows are null, so this will refuse real users until those rows are backfilled
   * and the column made non-null. That migration gates adoption of `TenantScopedRepository`;
   * it is not something to work around by softening this method.
   */
  requireOrganizationId(): string {
    const organizationId = this.organizationId;
    if (!organizationId) {
      throw new ForbiddenException(
        'Your account is not linked to an organisation, so organisation-scoped data cannot be read. Ask an administrator to assign your account to an organisation.',
      );
    }
    return organizationId;
  }
}
