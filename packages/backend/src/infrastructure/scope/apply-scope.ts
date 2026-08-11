/**
 * FAPOMS — Applying the global scope to a query
 *
 * `global-scope.ts` decides *what* the request is allowed to see; this decides *how* that gets
 * onto a TypeORM query. It is a shared helper rather than per-module WHERE clauses because
 * region scoping is only trustworthy if it is applied identically everywhere — a module that
 * hand-rolls it and forgets a dimension is a leak that nothing else will catch.
 *
 * ## Everything is scoped through the branch
 *
 * Region, state and zone live on `branches`. Assignments, schedules, coverage rows and map
 * markers do not carry a region of their own — they reach one by joining to a branch. So each
 * caller passes the alias of the branch already in its query, and this adds the predicates.
 * Callers whose query has no branch join must add one before calling.
 */

import { In, SelectQueryBuilder } from 'typeorm';
import { GlobalScope } from './global-scope';

/**
 * The scope as a TypeORM object-`where` fragment on a `branches` relation, for repositories
 * that use `find`/`findAndCount` rather than a query builder.
 *
 * Returns `undefined` when nothing is scoped, so callers can skip the clause entirely instead
 * of adding an empty object (which TypeORM would turn into a pointless join).
 */
export function branchScopeWhere(
  scope: Partial<GlobalScope> | undefined,
): Record<string, unknown> | undefined {
  if (!scope) return undefined;

  const where: Record<string, unknown> = {};
  if (scope.regions && scope.regions.length > 0) where.region = In(scope.regions);
  if (scope.state) where.state = scope.state;
  if (scope.zoneId) where.zoneId = scope.zoneId;
  if (scope.clientId) where.clientId = scope.clientId;

  return Object.keys(where).length > 0 ? where : undefined;
}

/** Suffix keeps parameter names unique when a query is scoped on more than one alias. */
let counter = 0;

/**
 * True when the scope constrains something that only exists on a branch.
 *
 * Callers use this to decide whether to add a join at all — `projectId` alone is usually
 * available without one, and joining for nothing costs a query plan.
 */
export function needsBranchJoin(scope: Partial<GlobalScope> | undefined): boolean {
  if (!scope) return false;
  return Boolean(
    (scope.regions && scope.regions.length > 0) || scope.state || scope.zoneId || scope.clientId,
  );
}

export interface BranchScopeAliases {
  /** Alias of the `branches` table in the query. */
  branch: string;
  /**
   * Alias holding `client_id`, when the client lives somewhere better than the branch — a
   * project, say. Defaults to the branch alias.
   */
  client?: string;
  /** Alias holding `project_id`, for queries where filtering by project is meaningful. */
  project?: string;
}

/**
 * Add the scope's predicates to `qb`.
 *
 * Only dimensions the caller can actually express are applied: pass `project` only when the
 * query has a project to filter on, otherwise `scope.projectId` is ignored for that query
 * rather than silently matching nothing.
 */
export function applyBranchScope<T extends object>(
  qb: SelectQueryBuilder<T>,
  scope: Partial<GlobalScope> | undefined,
  aliases: BranchScopeAliases,
): SelectQueryBuilder<T> {
  if (!scope) return qb;

  const n = counter++;
  const { branch } = aliases;
  const clientAlias = aliases.client ?? branch;

  if (scope.regions && scope.regions.length > 0) {
    qb.andWhere(`${branch}.region IN (:...scopeRegions${n})`, { [`scopeRegions${n}`]: scope.regions });
  }
  if (scope.state) {
    qb.andWhere(`${branch}.state = :scopeState${n}`, { [`scopeState${n}`]: scope.state });
  }
  if (scope.zoneId) {
    qb.andWhere(`${branch}.zone_id = :scopeZone${n}`, { [`scopeZone${n}`]: scope.zoneId });
  }
  if (scope.clientId) {
    qb.andWhere(`${clientAlias}.client_id = :scopeClient${n}`, { [`scopeClient${n}`]: scope.clientId });
  }
  if (scope.projectId && aliases.project) {
    qb.andWhere(`${aliases.project}.project_id = :scopeProject${n}`, { [`scopeProject${n}`]: scope.projectId });
  }

  return qb;
}

/**
 * Scope a query over `assayers`, which carry their own `region` column.
 *
 * Deliberately narrower than `applyBranchScope`: an assayer has a home region but no state,
 * zone or client of their own, so those dimensions do not apply and are left alone rather
 * than being faked through their assignment history. Filtering the workforce list by "the
 * client I am looking at" would quietly hide anyone who has not happened to work for that
 * client yet, which is not what an operator means by scoping to a client.
 */
export function applyAssayerScope<T extends object>(
  qb: SelectQueryBuilder<T>,
  scope: Partial<GlobalScope> | undefined,
  assayerAlias: string,
): SelectQueryBuilder<T> {
  if (!scope?.regions || scope.regions.length === 0) return qb;

  const n = counter++;
  qb.andWhere(`${assayerAlias}.region IN (:...scopeAssayerRegions${n})`, {
    [`scopeAssayerRegions${n}`]: scope.regions,
  });
  return qb;
}
