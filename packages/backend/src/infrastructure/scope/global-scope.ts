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
import { Region, isRegion, resolveRegion } from '@fapoms/shared';

/** The principal shape this reads. Populated by `JwtStrategy.validate`. */
export interface ScopedPrincipal {
  id?: string;
  regions?: string[] | null;
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
    clientId: str('clientId'),
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
