import {
  FindOptionsWhere,
  ObjectLiteral,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { ForbiddenException } from '@nestjs/common';
import { TenantContext } from './tenant-context';

/** An entity that carries an owning organisation. */
export interface TenantOwned extends ObjectLiteral {
  organizationId?: string | null;
}

/**
 * Base class for repositories over organisation-owned data.
 *
 * ## The problem it solves
 *
 * `organizationId` has existed on `assayers`, `branches`, `clients`, `projects` and `users`
 * from the start, is carried in every JWT, and is stamped on create. It has never been used
 * as a read filter — not once, anywhere in the backend. Every staff token therefore reads
 * every organisation's data: their clients, their branches, their workforce, their billing.
 *
 * The obvious fix is to add `where: { organizationId }` at each read site. That was rejected:
 * there are ~50 of them today and an unbounded number tomorrow, forgetting one is silent, and
 * the failure direction is permissive — exactly the shape of mistake that produced the
 * `RolesGuard` incident, where ~50 handlers were open because a decorator was absent rather
 * than wrong.
 *
 * So the filter lives here instead. A repository extending this class has no un-scoped read
 * path to reach for: `scopedQuery` and `scopedWhere` are the only builders it is given, and
 * both apply the predicate before the caller sees them.
 *
 * ## Escape hatch, deliberately loud
 *
 * `SUPER_ADMINISTRATOR` legitimately reads across organisations, and that is honoured via
 * `TenantContext.isCrossTenant`. It is one named role in one place, greppable, rather than a
 * boolean parameter each call site could pass.
 *
 * ## Adoption is gated on a backfill
 *
 * `organization_id` is nullable on every entity that has it, and most rows are null today.
 * Until those are backfilled and the column made NOT NULL, a scoped read returns nothing for
 * legacy rows and `requireOrganizationId()` refuses principals with no organisation. That
 * migration is the precondition for wiring this into a module — it is not a reason to add a
 * "null means everyone" branch, which would reintroduce the hole this class closes.
 *
 * ## Usage
 *
 * ```ts
 * @Injectable()
 * export class ClientRepository extends TenantScopedRepository<ClientEntity> {
 *   protected readonly alias = 'client';
 *   constructor(
 *     @InjectRepository(ClientEntity) repo: Repository<ClientEntity>,
 *     tenant: TenantContext,
 *   ) { super(repo, tenant); }
 *
 *   findActive() {
 *     return this.scopedQuery().andWhere('client.isActive = true').getMany();
 *   }
 * }
 * ```
 *
 * Note that injecting `TenantContext` makes the subclass request-scoped, and that propagates
 * to whatever injects it. See the note on `TenantContext` for why that is the accepted cost.
 */
export abstract class TenantScopedRepository<T extends TenantOwned> {
  /** Query-builder alias for this entity, e.g. `'client'`. */
  protected abstract readonly alias: string;

  /**
   * Entity property holding the owning organisation.
   *
   * The property name, not the column name — TypeORM resolves `alias.property` through the
   * entity metadata, so this keeps working if the column is ever renamed.
   */
  protected readonly tenantProperty: string = 'organizationId';

  protected constructor(
    protected readonly repository: Repository<T>,
    protected readonly tenant: TenantContext,
  ) {}

  /**
   * A query builder already restricted to the caller's organisation.
   *
   * This is the primary tool: start every read here and the predicate cannot be forgotten,
   * because there is no point at which the caller holds an unrestricted builder.
   */
  protected scopedQuery(alias: string = this.alias): SelectQueryBuilder<T> {
    const qb = this.repository.createQueryBuilder(alias);
    if (this.tenant.isCrossTenant) return qb;
    return qb.andWhere(`${alias}.${this.tenantProperty} = :__tenantId`, {
      __tenantId: this.tenant.requireOrganizationId(),
    });
  }

  /**
   * Scope a plain `where` for `find` / `findOne`.
   *
   * An array is OR-ed by TypeORM, so the organisation predicate has to be added to **every**
   * branch — adding it once alongside the array would produce
   * `(a) OR (b) OR (org = :id)`, which matches the whole organisation and quietly widens the
   * query instead of narrowing it. Repositories in this codebase do use array `where`s (see
   * `AuthService.login`), so this is a live hazard rather than a theoretical one.
   */
  protected scopedWhere(
    where?: FindOptionsWhere<T> | FindOptionsWhere<T>[],
  ): FindOptionsWhere<T> | FindOptionsWhere<T>[] {
    if (this.tenant.isCrossTenant) return where ?? {};
    const tenantPredicate = { [this.tenantProperty]: this.tenant.requireOrganizationId() };

    if (Array.isArray(where)) {
      return where.map((clause) => ({ ...clause, ...tenantPredicate })) as FindOptionsWhere<T>[];
    }
    return { ...(where ?? {}), ...tenantPredicate } as FindOptionsWhere<T>;
  }

  /**
   * Refuse an entity that belongs to another organisation.
   *
   * For the update/delete shape that loads a row by id and mutates it: the id alone says
   * nothing about ownership, so a caller holding a valid id from another organisation would
   * otherwise write to it. Call this immediately after loading, before any mutation.
   *
   * A row with no organisation is refused rather than allowed. Legacy null rows exist today,
   * which is why this class is gated on the backfill above — but "unknown owner" resolving to
   * "anyone may write it" is not a defensible default for audit data.
   */
  protected assertOwned(entity: T | null | undefined): T {
    if (!entity) {
      throw new ForbiddenException('Record not found in your organisation.');
    }
    if (this.tenant.isCrossTenant) return entity;

    const owner = (entity as TenantOwned)[this.tenantProperty as 'organizationId'];
    if (!owner || owner !== this.tenant.requireOrganizationId()) {
      // Deliberately the same message and status as "not found in your organisation": telling
      // a caller that a record exists but belongs to someone else is itself a disclosure.
      throw new ForbiddenException('Record not found in your organisation.');
    }
    return entity;
  }

  /**
   * Stamp the owning organisation onto a new entity.
   *
   * Creates currently take `organizationId` as an optional argument threaded down from the
   * controller (`clientService.create(dto, userId, req.user.organizationId)`), so a caller
   * that omits it writes a null-owned row — one that no scoped read will ever return again.
   * Stamping here removes that possibility.
   */
  protected stampTenant<D extends Partial<T>>(data: D): D & { organizationId: string } {
    return {
      ...data,
      [this.tenantProperty]: this.tenant.requireOrganizationId(),
    } as D & { organizationId: string };
  }
}
