/**
 * FAPOMS — Room-level entitlement for the realtime gateway
 *
 * `EventsGateway` lets a connected socket join per-entity rooms (`assignment:<id>`,
 * `query:<id>`) and then relays every status, schedule, comment and fee event for that
 * entity into the room. Joining used to require nothing beyond being authenticated, so any
 * principal — including an external assayer — could subscribe to an arbitrary UUID and
 * receive another assayer's negotiation and fee traffic.
 *
 * This service answers the one question the gateway must ask before a join: *may this
 * principal watch this entity?* The rules mirror what the HTTP layer already enforces:
 *
 * - The assignment's own assayer (or the query's assayer / raiser) may watch it.
 * - Internal staff may watch it when their `users.regions` assignment covers the branch
 *   region the entity reaches through `project_branches` → `branches` — the same
 *   `branch.region IN (:regions)` predicate `apply-scope.ts` puts on every scoped query.
 *   An unrestricted account (no region assignment) may watch anything.
 * - Everyone else — external principals, client users, tokens with no roles — is refused.
 *
 * A restricted staff account is refused when the entity resolves to no branch region at
 * all: the HTTP list queries would filter that row out too, and over-filtering is the safe
 * direction to fail.
 */

import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Region } from '@fapoms/shared';
import { AssignmentEntity } from '../../modules/assignment/assignment.entity';
import { ValidationQueryEntity } from '../../modules/validation-query/validation-query.entity';
import { UserEntity } from '../../modules/user/user.entity';
import { assignedRegions } from './global-scope';

/** The socket principal shape `EventsGateway` builds from a verified JWT. */
export interface SocketPrincipal {
  id: string;
  roles?: Array<string | { name?: string }>;
}

export interface RoomVerdict {
  /**
   * Whether the entity row exists. A verdict for an unknown id is refused but must not be
   * cached: the id may be created moments later (a client subscribing off a `created`
   * event), and a per-socket cache would pin the refusal for the connection's lifetime.
   */
  found: boolean;
  allowed: boolean;
}

const REFUSED_UNKNOWN: RoomVerdict = { found: false, allowed: false };

/** Role entries arrive from JWTs both as strings and as `{ name }` objects. */
export function roleNames(roles: unknown): string[] {
  if (!Array.isArray(roles)) return [];
  return roles
    .map((r: any) => (typeof r === 'string' ? r : r?.name))
    .filter(Boolean);
}

/**
 * ASSAYER and CLIENT_USER are external principals; a token carrying no roles at all is
 * treated as external too — staff-grade access is opt-in, never a default. This is the
 * same rule `handleConnection` applies when deciding who joins the `staff` room.
 */
const EXTERNAL_ROLES = ['ASSAYER', 'CLIENT_USER'];

export function isInternalStaff(roles: unknown): boolean {
  const names = roleNames(roles);
  return names.length > 0 && names.some((r) => !EXTERNAL_ROLES.includes(r));
}

@Injectable()
export class RegionGuardService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * The account's enforced region assignment, or `null` for unrestricted.
   *
   * Read from `users.regions` at check time rather than the JWT because the token does not
   * carry regions — and must not, or a region reassignment would not bite until expiry.
   */
  async userRegions(userId: string): Promise<Region[] | null> {
    const user = await this.dataSource.getRepository(UserEntity).findOne({
      where: { id: userId },
      select: ['id', 'regions'],
    });
    if (!user) {
      // A verified token for an account that no longer exists gets nothing, not everything.
      throw new ForbiddenException('Account not found');
    }
    return assignedRegions(user);
  }

  /** May `principal` watch live events for this assignment? */
  async assignmentVerdict(principal: SocketPrincipal, assignmentId: string): Promise<RoomVerdict> {
    const row = await this.dataSource
      .getRepository(AssignmentEntity)
      .createQueryBuilder('a')
      .leftJoin('a.projectBranch', 'pb')
      .leftJoin('pb.branch', 'b')
      .select('a.id', 'id')
      .addSelect('a.assayerId', 'assayerId')
      .addSelect('b.region', 'region')
      .where('a.id = :id', { id: assignmentId })
      .getRawOne<{ id: string; assayerId: string | null; region: string | null }>();

    if (!row) return REFUSED_UNKNOWN;
    if (row.assayerId && row.assayerId === principal.id) return { found: true, allowed: true };
    return this.staffVerdict(principal, row.region);
  }

  /** May `principal` watch live events for this clarification thread? */
  async queryVerdict(principal: SocketPrincipal, queryId: string): Promise<RoomVerdict> {
    const row = await this.dataSource
      .getRepository(ValidationQueryEntity)
      .createQueryBuilder('q')
      .leftJoin('q.validationCase', 'vc')
      .leftJoin('vc.projectBranch', 'pb')
      .leftJoin('pb.branch', 'b')
      .select('q.id', 'id')
      .addSelect('q.assayerId', 'assayerId')
      .addSelect('q.raisedByUserId', 'raisedByUserId')
      .addSelect('b.region', 'region')
      .where('q.id = :id', { id: queryId })
      .getRawOne<{
        id: string;
        assayerId: string | null;
        raisedByUserId: string | null;
        region: string | null;
      }>();

    if (!row) return REFUSED_UNKNOWN;
    const isOwner =
      (row.assayerId && row.assayerId === principal.id) ||
      (row.raisedByUserId && row.raisedByUserId === principal.id);
    if (isOwner) return { found: true, allowed: true };
    return this.staffVerdict(principal, row.region);
  }

  private async staffVerdict(
    principal: SocketPrincipal,
    region: string | null,
  ): Promise<RoomVerdict> {
    if (!isInternalStaff(principal.roles)) return { found: true, allowed: false };
    const regions = await this.userRegions(principal.id);
    return { found: true, allowed: this.regionAllowed(region, regions) };
  }

  /**
   * The same predicate the HTTP layer applies (`branch.region IN (:regions)`): exact
   * membership, no legacy-alias resolution, and a row with no resolvable region is visible
   * only to unrestricted accounts.
   */
  private regionAllowed(region: string | null, regions: Region[] | null): boolean {
    if (regions === null) return true;
    return !!region && (regions as string[]).includes(region);
  }
}
