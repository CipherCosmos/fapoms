/**
 * FAPOMS — Global Operational Scope
 *
 * The header's global filter lets an operator narrow the whole application to one project,
 * client, region, zone or state so they work their own patch without other regions' branches
 * mixed in. This module is the server-side half of that: it parses those filters off the
 * query string and — for region — enforces them against the account's assignment.
 *
 * ## Why region is enforced and the others are not
 *
 * Project, client, zone and state are *conveniences*: the operator narrowing to them is
 * choosing what to look at, and widening back to "all" shows them nothing they were not
 * already entitled to see. Region is different — `users.regions` is an assignment, so a
 * request asking for a region the account does not hold is refused rather than honoured. The
 * enforcement lives here, not in the UI, because a query string is not a trust boundary.
 *
 * ## Why a param decorator rather than a request-scoped provider
 *
 * `TenantContext` documents the cost of `Scope.REQUEST`: it is contagious, and every provider
 * that injects it (and everything injecting *those*, up to the controller) stops being a
 * singleton. Everything this needs is already on the request object the decorator is handed,
 * so none of that cost is worth paying here.
 */

import { createParamDecorator, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Region, SystemRole, isRegion, resolveRegion } from '@fapoms/shared';

/** The principal shape this reads. Populated by `JwtStrategy.validate`. */
export interface ScopedPrincipal {
  id?: string;
  regions?: string[] | null;
  clientId?: string | null;
  /**
   * Role entries as `AuthService.loadPrincipal` returns them: `RoleEntity[]` for a staff/client
   * principal (`{ name: string, ... }`), or a synthetic `[{ name: 'ASSAYER' }]` for a field
   * account. Only read by `resolveClientScope`, to tell an unassigned CLIENT_USER apart from an
   * unassigned staff account — see the comment there.
   */
  roles?: Array<string | { name?: string | null } | null | undefined> | null;
}

/** Role names off a principal, tolerant of both plain strings and `{ name }` entities. */
function principalRoleNames(principal: ScopedPrincipal | null | undefined): string[] {
  const raw = principal?.roles;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => (typeof r === 'string' ? r : r?.name))
    .filter((n): n is string => Boolean(n));
}

export interface GlobalScope {
  projectId?: string;
  clientId?: string;
  zoneId?: string;
  state?: string;
  /**
   * The regions a query may return, or `null` for no region constraint.
   *
   * `null` only ever means "this account holds every region and asked for every region".
   * A restricted account never resolves to `null`, so a consumer that forgets to handle the
   * array case over-filters rather than leaking — the safe direction to fail.
   */
  regions: Region[] | null;
}

/** The regions an account may read, or `null` when it is unrestricted. */
export function assignedRegions(principal: ScopedPrincipal | null | undefined): Region[] | null {
  const raw = principal?.regions;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const valid = raw.filter(isRegion);
  // An assignment that is present but entirely unrecognisable is a data fault, not a licence
  // to read everything. Refuse rather than silently promoting the account to unrestricted.
  if (valid.length === 0) {
    throw new ForbiddenException(
      'Your account has a region assignment that is not recognised. Ask an administrator to correct it.',
    );
  }
  return valid;
}

/**
 * Intersect the requested region with what the account holds.
 *
 * - no request + no assignment  → `null` (everything)
 * - no request + assignment     → the assignment
 * - request + no assignment     → just the requested region
 * - request + assignment        → the requested region, or a refusal if it is not held
 */
export function resolveRegionScope(
  requested: string | null | undefined,
  principal: ScopedPrincipal | null | undefined,
): Region[] | null {
  const allowed = assignedRegions(principal);

  const wanted = requested && requested !== 'ALL' ? resolveRegion(requested) : null;
  if (requested && requested !== 'ALL' && !wanted) {
    throw new ForbiddenException(`'${requested}' is not a recognised region.`);
  }

  if (!wanted) return allowed;
  if (allowed && !allowed.includes(wanted)) {
    throw new ForbiddenException(
      `Your account is not assigned to the ${wanted} region.`,
    );
  }
  return [wanted];
}

/**
 * The client an account is confined to, or `null` when nothing is on record.
 *
 * Mirrors `assignedRegions`'s accessor role only — it does not decide what a missing value
 * means, because that depends on the principal's role and `resolveClientScope` is where that
 * decision lives (a bare `null` here is not by itself "unrestricted": see the comment there).
 */
export function assignedClientId(principal: ScopedPrincipal | null | undefined): string | null {
  return principal?.clientId ?? null;
}

/**
 * Intersect the requested client with what the account is assigned to.
 *
 * Same shape as `resolveRegionScope`, but for a single value rather than a set: an assigned
 * client is a ceiling, not a convenience, so a request naming a *different* client is refused
 * rather than silently honoured — the query string is not a trust boundary. An unrestricted
 * account (every staff account today) can still ask for any client via `?clientId=`, exactly
 * as before this column existed.
 *
 * ## The one case that is not "unrestricted"
 *
 * A missing `clientId` is ambiguous on its own: it is the normal, correct state for every staff
 * account (this column does not apply to them), but for a principal holding the CLIENT_USER role
 * it is a provisioning gap, not an entitlement — nothing today requires `clientId` to be set
 * before that role is granted (the admin screen that creates one does not even expose the
 * field). Reading a gap as "unrestricted, like staff" would hand a misconfigured client account
 * every tenant's schedules, customer records and billing figures the moment it reached any
 * CLIENT_USER route — confirmed live: an account seeded with the role and no `clientId` saw
 * another bank's project by name on `GET /system-dashboard/operations`, and could pick any
 * client at will via `?clientId=`, since there was no assignment left to violate. So this is the
 * one principal shape resolved here rather than left to each of the handful of routes that grant
 * CLIENT_USER to notice on their own: refuse before a query ever runs, the same fail-closed
 * direction `assignedRegions` already takes for a region assignment it cannot parse.
 */
export function resolveClientScope(
  requested: string | null | undefined,
  principal: ScopedPrincipal | null | undefined,
): string | undefined {
  const assigned = assignedClientId(principal);
  if (assigned) {
    if (requested && requested !== assigned) {
      throw new ForbiddenException('Your account is not assigned to that client.');
    }
    return assigned;
  }
  if (principalRoleNames(principal).includes(SystemRole.CLIENT_USER)) {
    throw new ForbiddenException(
      'Your account is not yet assigned to a client. Ask an administrator to complete your setup.',
    );
  }
  return requested || undefined;
}

/**
 * Assert that a specific record's client matches the caller's client ceiling.
 *
 * For a detail/by-id route (a project, a version, a run) that isn't a filterable list —
 * `applyBranchScope`'s `WHERE client_id = :scope` has nothing to filter when the id itself
 * came from the URL, not a query. `scope.clientId` at this point is already the enforced
 * ceiling (see `resolveClientScope`), so a mismatch here means the caller named a client
 * other than the one they are assigned to.
 */
export function assertClientAllowed(
  recordClientId: string | null | undefined,
  scope: Pick<GlobalScope, 'clientId'> | null | undefined,
): void {
  if (!scope?.clientId) return;
  if (recordClientId !== scope.clientId) {
    throw new ForbiddenException('That record belongs to a different client.');
  }
}

/** Build the scope from a request's query string and principal. */
export function resolveGlobalScope(
  query: Record<string, unknown>,
  principal: ScopedPrincipal | null | undefined,
): GlobalScope {
  const str = (key: string): string | undefined => {
    const value = query?.[key];
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed && trimmed !== 'ALL' ? trimmed : undefined;
  };

  return {
    projectId: str('projectId'),
    clientId: resolveClientScope(str('clientId'), principal),
    zoneId: str('zoneId'),
    state: str('state'),
    regions: resolveRegionScope(str('region'), principal),
  };
}

/**
 * `@GlobalScopeFilter() scope: GlobalScope` on any handler.
 *
 * Reads `?projectId=&clientId=&region=&zoneId=&state=` and returns the enforced scope.
 */
export const GlobalScopeFilter = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): GlobalScope => {
    const request = ctx.switchToHttp().getRequest();
    return resolveGlobalScope(request?.query ?? {}, request?.user ?? null);
  },
);
