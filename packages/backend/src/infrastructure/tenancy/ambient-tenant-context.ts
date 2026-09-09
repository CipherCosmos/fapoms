import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { FindOptionsWhere, ObjectLiteral } from 'typeorm';
import { SystemRole } from '@fapoms/shared';

import { getRequestContext } from '../../core/context/request-context';

/**
 * The organisation the current request acts within — resolved ambiently, at singleton cost.
 *
 * ## Why this exists alongside `TenantContext`
 *
 * `TenantContext` is the design; this is the same design bound to a different carrier, and the
 * carrier is the whole difference. `TenantContext` is `Scope.REQUEST` and reads `@Inject(REQUEST)`,
 * which its own comment is candid about: request scope is contagious, so every provider injecting
 * it — and everything injecting *those*, up to the controller — stops being a singleton. That was
 * accepted as "the price of correctness", and for a small leaf repository it is.
 *
 * It is not payable here, and not for a reason of taste. `AssayerService` is injected by
 * `AssignmentService`, `PlanningService`, `DayPlannerService`, `RecommendationEngine`,
 * `ReportsService`, `PlanningAclAdapter` and `RosterImportService` — and `RosterImportService` is
 * what `RosterImportWorker`, a Bull `@Processor`, runs. Making `AssayerService` request-scoped
 * therefore makes a Bull processor request-scoped, and a Bull job has no request: `@Inject(REQUEST)`
 * resolves to an empty stub, `organizationId` reads undefined, and the 1,155-row roster import
 * fails on its first lifecycle transition. `TenantContext` says this itself, under "What this does
 * NOT cover": "Bull workers and scheduled jobs have no request, so they cannot resolve a tenant
 * this way."
 *
 * The same comment names the way out: "An `AsyncLocalStorage`-based context would cover both
 * surfaces without the scope bubbling; it is the natural next step if the request-scope cost shows
 * up in profiling or if workers start needing the same scoping." Both conditions are now true, and
 * the `AsyncLocalStorage` in question already exists and has been carrying the actor on every audit
 * row for months — `core/context/request-context.ts`, opened for every request by
 * `requestContextMiddleware` and filled with the authenticated principal by
 * `RequestContextInterceptor` once the JWT guard has run. So this adds a reader, not a mechanism.
 *
 * Everything else is `TenantContext`'s design unchanged: the same two cross-tenant roles, the same
 * refusal rather than a null organisation, the same predicate applied where the query is built
 * rather than at each call site. `TenantScopedRepository` accepts this class wherever it accepts
 * `TenantContext` — the contract is identical — so a future repository can extend that base class
 * and stay a singleton by taking this instead.
 *
 * ## The one place this fails open, stated plainly
 *
 * Outside any request there is no principal to scope by, and {@link tenantScope} reports `system`
 * rather than refusing. That is what keeps the roster-import worker, the SLA scanner and the
 * nightly digests running, and it is a real fail-open: if `requestContextMiddleware` were ever
 * removed from `main.ts`, every HTTP request would look like background work and the predicate
 * would disappear silently across the whole surface. `ambient-tenant-context.spec.ts` asserts that
 * middleware is still wired, so that regression fails CI rather than production.
 */

/**
 * Roles that legitimately read across every organisation.
 *
 * The same list, for the same reasons, as `TenantContext.CROSS_TENANT_ROLES` — the platform
 * operator (ADMIN) and the role that runs the platform's technical estate (DEVELOPER), and
 * nothing else. Notably NOT OPERATIONS, which is the role finding F-03 was reproduced with, and
 * not ADMINISTRATOR, which is an *organisation* administrator: including either would make tenant
 * isolation meaningless for the roles most likely to hold it.
 */
export const CROSS_TENANT_ROLES: readonly string[] = [SystemRole.ADMIN, SystemRole.DEVELOPER];

/** What the caller is allowed to see, and why. */
export type TenantScope =
  /** No request in flight: a Bull job, a cron sweep, a migration, a unit spec. Unscoped. */
  | { kind: 'system' }
  /** ADMIN or DEVELOPER — the platform operator, reading across organisations by design. */
  | { kind: 'platform' }
  /** An ordinary principal, confined to one organisation. */
  | { kind: 'tenant'; organizationId: string };

/**
 * The current caller's tenant scope.
 *
 * Reads the ambient request context and nothing else. In particular it never reads a query
 * string, a header, a route parameter or a request body: F-03 was not a missing check on a
 * caller-supplied organisation, it was the absence of any organisation anywhere, and "let the
 * caller name their tenant" would replace one hole with a more convincing one.
 */
export function tenantScope(): TenantScope {
  const ctx = getRequestContext();
  if (!ctx) return { kind: 'system' };

  const roles = ctx.roleNames ?? (ctx.role ? [ctx.role] : []);
  if (roles.some((r) => CROSS_TENANT_ROLES.includes(r))) return { kind: 'platform' };

  if (!ctx.organizationId) {
    /**
     * Refused, not waved through. A principal with no organisation used to be every principal —
     * `organization_id` was null on 1,155 of 1,172 assayers before migration
     * `1796500000000-BackfillTenantOwnership`, which is exactly why `TenantScopedRepository` sat
     * unadopted. Post-backfill this is a provisioning fault on one account, and the honest
     * outcome for a provisioning fault is a message telling somebody to fix it — not a query
     * that quietly drops its WHERE clause and returns every tenant's roster.
     */
    throw new ForbiddenException(
      'Your account is not linked to an organisation, so organisation-scoped data cannot be read. '
      + 'Ask an administrator to assign your account to an organisation.',
    );
  }
  return { kind: 'tenant', organizationId: ctx.organizationId };
}

/**
 * The organisation to filter on, or `null` when this caller is not confined to one.
 *
 * `null` means "apply no predicate" and is returned for exactly two callers: the platform operator
 * and background work. Every other caller gets a string, and a caller with no organisation gets an
 * exception rather than `null` — the distinction that matters, because a `null` that meant "no
 * organisation on file" would read at every call site as "no filter needed".
 */
export function tenantFilterId(): string | null {
  const scope = tenantScope();
  return scope.kind === 'tenant' ? scope.organizationId : null;
}

/**
 * The organisation to STAMP on a new row, or a refusal.
 *
 * Distinct from {@link tenantFilterId} because the two answers differ for the platform operator:
 * ADMIN reads across organisations but still has one of their own, and a row created by ADMIN with
 * a null organisation is a row no scoped read will ever return again — invisible the moment it is
 * written, which is the failure mode that hurts most because nothing errors.
 */
export function tenantStampId(): string | null {
  const ctx = getRequestContext();
  return ctx?.organizationId ?? null;
}

/**
 * True when this caller sees every organisation — the platform operator, or background work.
 *
 * Provided so a call site can say what it means (`if (!isUnscopedCaller()) …`) rather than
 * comparing `tenantFilterId()` against null and leaving the next reader to work out which of the
 * two very different reasons produced it.
 */
export function isUnscopedCaller(): boolean {
  return tenantFilterId() === null;
}

/**
 * Add the organisation predicate to a TypeORM `where`, for `find` / `findOne` / `findAndCount`.
 *
 * Lifted from `TenantScopedRepository.scopedWhere`, including the part that is easy to get wrong:
 * TypeORM OR-s an array, so the predicate has to go into **every** branch. Adding it once
 * alongside the array yields `(a) OR (b) OR (org = :id)`, which matches the entire organisation
 * and widens the query instead of narrowing it. `AssayerService.getProfile` builds exactly such an
 * array — `[{ assayerCode }, { employeeId }]` — so this is the live case, not the textbook one.
 */
export function tenantWhere<T extends ObjectLiteral>(
  where: FindOptionsWhere<T> | FindOptionsWhere<T>[],
): FindOptionsWhere<T> | FindOptionsWhere<T>[] {
  const organizationId = tenantFilterId();
  if (!organizationId) return where;
  if (Array.isArray(where)) {
    return where.map((clause) => ({ ...clause, organizationId })) as FindOptionsWhere<T>[];
  }
  return { ...where, organizationId } as FindOptionsWhere<T>;
}

/**
 * The organisation predicate as a raw-SQL fragment, with its bind value pushed onto `params`.
 *
 * For the query surfaces a repository cannot reach: `HrWorkforceService` is 29 hand-written
 * statements over `assayers`, and `AssayerService.getPayables` reads a table that has no entity at
 * all. Both bind positionally.
 *
 * APPENDED, never inserted — `params.push` then `$${params.length}` — so the fragment can be added
 * to a statement that already binds `$1…$n` without renumbering any of them. This is deliberately
 * the same shape as `HrWorkforceService.scopeSql`, which exists for the same reason and has a
 * fitness test guarding it; a second convention would have been a second thing to get wrong.
 *
 * Returns `''` for an unscoped caller, so the SQL a platform operator or a background job runs is
 * byte-for-byte what it was before tenancy existed.
 */
export function tenantSql(alias: string, params: unknown[]): string {
  const organizationId = tenantFilterId();
  if (!organizationId) return '';
  params.push(organizationId);
  // `alias` is the range variable carrying `organization_id` in THIS statement — the bare table
  // name where there is no `AS` (Postgres exposes an unaliased table under its own name), the join
  // alias otherwise.
  return ` AND ${alias}.organization_id = $${params.length}`;
}

/**
 * Refuse a row this caller does not own — as a 404, identically to a row that does not exist.
 *
 * ## Why 404 and not 403
 *
 * The certification reproduced F-03 by noting that a nonexistent UUID returned 404 while another
 * tenant's real UUID returned 200: the status code itself was the oracle that proved the reads
 * were genuine. Answering 403 for the foreign row keeps that oracle and merely renames it — the
 * caller still learns, for any id they care to try, whether it names a real assayer somewhere on
 * the platform. Assayer ids are UUIDs so they are not guessable in bulk, but they leak: they
 * appear in assignment payloads, in exported spreadsheets, in support tickets and in URLs pasted
 * between organisations. "This id exists but is not yours" is a fact worth nothing to a legitimate
 * caller and worth something to an attacker, so it is not disclosed.
 *
 * 404 also happens to be free almost everywhere in this module, because the scoping is a WHERE
 * predicate rather than a post-load check: `findOne` simply returns null and the `NotFoundException`
 * the method already threw fires unchanged. This function is for the residue — routes keyed by a
 * CHILD row's id (a document, a reference, an empanelment, a commercial profile, a workforce
 * attribute), where the owning assayer has to be resolved before ownership can be judged.
 *
 * Note this diverges from `TenantScopedRepository.assertOwned`, which throws `ForbiddenException`.
 * That class has no adopters yet and its own spec only requires that a foreign row and a missing
 * row be reported *identically to each other*; here they also have to be reported identically to
 * what the un-scoped route already returned for a missing row, which is a 404.
 */
export function assertTenantOwns(
  ownerOrganizationId: string | null | undefined,
  notFoundMessage: string,
): void {
  const organizationId = tenantFilterId();
  if (!organizationId) return;
  if (ownerOrganizationId !== organizationId) {
    throw new NotFoundException(notFoundMessage);
  }
}

/**
 * `AmbientTenantContext` — the injectable face of the functions above.
 *
 * A plain `@Injectable()`, so it is a **singleton** and injecting it costs a consumer nothing; it
 * holds no state, because the state is the ambient store. It satisfies the same contract
 * `TenantScopedRepository` reads off `TenantContext` (`organizationId`, `isCrossTenant`,
 * `requireOrganizationId`), so a future repository can extend that base class, pass this instead,
 * and get the class's structural guarantee without turning its whole injection chain
 * request-scoped.
 */
@Injectable()
export class AmbientTenantContext {
  /** The organisation this request acts within, or null outside a request. */
  get organizationId(): string | null {
    return getRequestContext()?.organizationId ?? null;
  }

  /** Role names as the interceptor recorded them, falling back to the single primary role. */
  get roleNames(): string[] {
    const ctx = getRequestContext();
    return ctx?.roleNames ?? (ctx?.role ? [ctx.role] : []);
  }

  /**
   * True when no predicate should be applied.
   *
   * Named for the base class's contract, but it answers for background work too — see the
   * fail-open note in this file's header. `TenantScopedRepository` treats it as "skip the
   * predicate", which is the correct behaviour for both cases it covers here.
   */
  get isCrossTenant(): boolean {
    const scope = tenantScope();
    return scope.kind !== 'tenant';
  }

  /** The organisation id, or a refusal — never null, so a caller cannot skip its WHERE clause. */
  requireOrganizationId(): string {
    const scope = tenantScope();
    if (scope.kind === 'tenant') return scope.organizationId;
    // `isCrossTenant` is checked first by every caller in the base class, so reaching here means
    // a caller asked for an id it had already been told it does not need.
    throw new ForbiddenException('This caller is not confined to a single organisation.');
  }
}
