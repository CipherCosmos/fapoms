/**
 * FAPOMS — The region ceiling on single-record reads.
 *
 * List endpoints are scoped by narrowing their query. Detail endpoints cannot be: they are
 * `GET /thing/:id`, the id is supplied by the caller, and a query that returns one row either
 * returns it or does not. So the check has to happen after the load — resolve the record's
 * region and refuse if the caller does not hold it.
 *
 * ## Why this matters even though the lists are scoped
 *
 * A scoped list is a discovery control, not an access control. Branch ids are guessable from
 * other payloads (a national project's coverage report, a shared link, an old bookmark), and
 * an operations account is region-*assigned*, not merely region-*filtered* — `users.regions`
 * is an authorisation fact. Leaving the detail route open means the list narrowing is
 * decoration: anyone who learns an id reads the record.
 *
 * ## Deliberately not a blanket guard
 *
 * This is a service the handler calls, not an `APP_GUARD`. A global guard would have to infer
 * which parameter is a branch and how each entity reaches one, and would silently fail open on
 * every route whose shape it did not recognise — the worst property for an authorisation
 * control. An explicit call per detail route is more typing and cannot fail silently.
 */

import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GlobalScope, assignedRegions } from './global-scope';
import { Region } from '@fapoms/shared';
import { AssignmentEntity } from '../../modules/assignment/assignment.entity';
import { ValidationQueryEntity } from '../../modules/validation-query/validation-query.entity';
import { UserEntity } from '../../modules/user/user.entity';
import { FeedbackThreadEntity } from '../../modules/feedback/feedback-thread.entity';
import { FEEDBACK_TEAM_ROLE_NAMES } from '../../modules/feedback/feedback-roles';
import { PlatformSettingsService } from '../settings/platform-settings.service';

/** Distinguishes a UUID path param from a human-facing code on routes that accept both. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  private readonly logger = new Logger(RegionGuardService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: PlatformSettingsService,
  ) {}

  /**
   * Refuse unless `region` is one the caller holds.
   *
   * A `null` region on the record is *allowed* through. Branches whose region could not be
   * resolved are a data gap, not a security boundary — hiding them from every scoped operator
   * would make them permanently unfixable, since only a scoped operator ever looks at them.
   * The migration leaves such rows visible for exactly this reason.
   */
  assertRegionAllowed(region: string | null | undefined, scope?: Partial<GlobalScope>): void {
    const allowed = scope?.regions;
    if (!allowed || allowed.length === 0) return;
    if (!region) return;
    if (!allowed.includes(region as any)) {
      throw new ForbiddenException(
        'That record belongs to a region your account is not assigned to.',
      );
    }
  }

  /**
   * The staged version of `assertRegionAllowed`, for a boundary being ADDED where none existed
   * before — documents, billing, expenses, customer master, validation queries, clients. Every
   * other caller of `assertRegionAllowed` above already enforced correctly and stays exactly as
   * it was; this method exists so six NEW checks can roll out without any of them being able to
   * turn into a surprise 403 the moment they ship.
   *
   * Runs the identical check `assertRegionAllowed` does — log mode and enforce mode can never
   * disagree about what WOULD be refused, only about whether the refusal is real — and reads
   * `security.regionScope.mode` fresh on every call rather than caching it locally: this method
   * is deliberately cheap to call (`PlatformSettingsService.get` is itself cache-backed), and a
   * flip from Log to Enforce in the settings screen should take effect on the very next request,
   * not the next deploy.
   *
   * `context` is a short label (e.g. `'document:download-token'`) so a Log-mode line in the
   * server log says which of the six rollouts it belongs to — six checks sharing one setting but
   * going quiet in the logs under one undifferentiated message would make Log mode useless for
   * deciding "which of these is safe to enforce first".
   */
  async assertRegionAllowedStaged(
    region: string | null | undefined,
    scope: Partial<GlobalScope> | undefined,
    context: string,
  ): Promise<void> {
    const mode = await this.settings
      .get<string>('security.regionScope.mode')
      .catch(() => 'log');
    if (mode === 'off') return;

    try {
      this.assertRegionAllowed(region, scope);
    } catch (err) {
      if (mode === 'enforce') throw err;
      this.logger.warn(
        `[region-scope:${context}] would refuse — record region "${region ?? 'null'}" not in ` +
          `[${(scope?.regions ?? []).join(', ')}]. Currently in Log mode: request allowed through.`,
      );
    }
  }

  /**
   * The current rollout mode for the six staged region boundaries (document, billing, expense,
   * customer-master, validation-query, client), read fresh on every call so a change in the
   * settings screen is live on the next request. Shared here rather than duplicated in each of
   * the six services' own list methods, all of which need this same value once at the top of
   * their query before deciding whether to filter and/or log.
   */
  async stagedMode(): Promise<'off' | 'log' | 'enforce'> {
    const mode = await this.settings
      .get<string>('security.regionScope.mode')
      .catch(() => 'log');
    return mode === 'off' || mode === 'enforce' ? mode : 'log';
  }

  /** The ceiling, for a branch id. */
  async assertBranchInScope(branchId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!branchId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(`SELECT region FROM branches WHERE id = $1`, [branchId]);
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /** The ceiling, for anything that reaches a branch through a project_branch row. */
  async assertProjectBranchInScope(projectBranchId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!projectBranchId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT b.region FROM project_branches pb JOIN branches b ON b.id = pb.branch_id WHERE pb.id = $1`,
      [projectBranchId],
    );
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /** The ceiling, for an assignment id (assignment → project_branch → branch). */
  async assertAssignmentInScope(assignmentId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!assignmentId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT b.region
         FROM assignments a
         JOIN project_branches pb ON pb.id = a.project_branch_id
         JOIN branches b ON b.id = pb.branch_id
        WHERE a.id = $1`,
      [assignmentId],
    );
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /**
   * The ceiling, for an assayer — matched on their own home region.
   *
   * Accepts either a UUID or an `assayer_code`, because `GET /assayers/:assayerId/profile`
   * does. Comparing a code against a `uuid` column raises `invalid input syntax`, so the
   * lookup is chosen by shape rather than assumed.
   */
  async assertAssayerInScope(assayerRef: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!assayerRef || !scope?.regions?.length) return;
    const rows = UUID_RE.test(assayerRef)
      ? await this.dataSource.query(`SELECT region FROM assayers WHERE id = $1`, [assayerRef])
      : await this.dataSource.query(`SELECT region FROM assayers WHERE assayer_code = $1`, [assayerRef]);
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /**
   * The regions an account holds, read straight from the database.
   *
   * Used by the realtime gateway at connection time. It cannot read this off the JWT: tokens
   * issued before region assignment existed carry no `regions` claim, and a socket that
   * silently treated "claim absent" as "unrestricted" would put a region-assigned operator
   * back in the national firehose — the exact leak the rooms exist to close.
   */
  async getUserRegions(userId: string): Promise<string[] | null> {
    const rows = await this.dataSource.query(`SELECT regions FROM users WHERE id = $1`, [userId]);
    const regions = rows?.[0]?.regions;
    return Array.isArray(regions) && regions.length > 0 ? regions : null;
  }

  /**
   * The region an outgoing realtime event belongs to, or `null` when it has none.
   *
   * Broadcast payloads are written by 75 different call sites and most do not carry a region,
   * so routing cannot depend on publishers remembering to add one — a forgotten field would be
   * a silent leak rather than a visible break. Instead the region is derived from whichever
   * identifier the payload does carry.
   *
   * Results are cached briefly: a burst of events about one branch is one lookup, and a
   * branch's region effectively never changes within the window.
   */
  async resolveEventRegion(payload: any): Promise<string | null> {
    if (!payload || typeof payload !== 'object') return null;

    const direct = payload.region ?? payload.metadata?.region;
    if (typeof direct === 'string' && direct) return direct;

    const meta = payload.metadata ?? {};
    const candidates: Array<[string, string | undefined]> = [
      ['branch', payload.branchId ?? meta.branchId],
      ['projectBranch', payload.projectBranchId ?? meta.projectBranchId],
      ['assignment', payload.assignmentId ?? meta.assignmentId],
      ['schedule', payload.scheduleId ?? meta.scheduleId],
      ['assayer', payload.assayerId ?? meta.assayerId],
    ];

    for (const [kind, id] of candidates) {
      if (!id || typeof id !== 'string') continue;
      const cacheKey = `${kind}:${id}`;
      const hit = this.regionCache.get(cacheKey);
      if (hit && hit.expires > Date.now()) {
        if (hit.region) return hit.region;
        continue;
      }
      const region = await this.lookupRegion(kind, id);
      this.cacheRegion(cacheKey, region);
      if (region) return region;
    }
    return null;
  }

  private readonly regionCache = new Map<string, { region: string | null; expires: number }>();
  private static readonly REGION_CACHE_TTL_MS = 60_000;
  /** Bounded so a long-running process cannot grow this map without limit. */
  private static readonly REGION_CACHE_MAX = 5000;

  private cacheRegion(key: string, region: string | null): void {
    if (this.regionCache.size >= RegionGuardService.REGION_CACHE_MAX) this.regionCache.clear();
    this.regionCache.set(key, {
      region,
      expires: Date.now() + RegionGuardService.REGION_CACHE_TTL_MS,
    });
  }

  private async lookupRegion(kind: string, id: string): Promise<string | null> {
    if (!UUID_RE.test(id)) return null;
    const sql: Record<string, string> = {
      branch: `SELECT region FROM branches WHERE id = $1`,
      assayer: `SELECT region FROM assayers WHERE id = $1`,
      projectBranch: `SELECT b.region FROM project_branches pb JOIN branches b ON b.id = pb.branch_id WHERE pb.id = $1`,
      assignment: `SELECT b.region FROM assignments a JOIN project_branches pb ON pb.id = a.project_branch_id JOIN branches b ON b.id = pb.branch_id WHERE a.id = $1`,
      schedule: `SELECT b.region FROM schedules s JOIN assignments a ON a.id = s.assignment_id JOIN project_branches pb ON pb.id = a.project_branch_id JOIN branches b ON b.id = pb.branch_id WHERE s.id = $1`,
    };
    try {
      const rows = await this.dataSource.query(sql[kind], [id]);
      return rows?.[0]?.region ?? null;
    } catch {
      // A lookup failure must not take down a broadcast. Returning null routes the event to
      // the general staff room, which is the pre-existing behaviour — degraded, not broken.
      return null;
    }
  }

  /** The ceiling, for a schedule (schedule → assignment → project_branch → branch). */
  async assertScheduleInScope(scheduleId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!scheduleId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT b.region
         FROM schedules s
         JOIN assignments a ON a.id = s.assignment_id
         JOIN project_branches pb ON pb.id = a.project_branch_id
         JOIN branches b ON b.id = pb.branch_id
        WHERE s.id = $1`,
      [scheduleId],
    );
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  // ── Realtime room entitlement ──────────────────────────────────────────────
  //
  // The HTTP methods above answer "may this request read this record", by throwing. The methods
  // below answer the socket gateway's question — "may this principal WATCH this entity" — and
  // return a verdict instead, because a refused room join is not an error the client asked for.
  //
  // They exist because joining a room used to require nothing beyond being authenticated: any
  // principal, including an external assayer, could subscribe to an arbitrary assignment UUID and
  // receive that assignment's status changes, comments, fee negotiation and communications. This
  // came from a branch that main had not taken; the rest of main's realtime work was newer, so
  // the merge kept both rather than choosing.

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

  /**
   * Can this socket join a feedback thread's room? Mirrors the HTTP rule in FeedbackService.findOne:
   * the reporter (by user id or assayer id) may, and anyone holding a feedback-team role may; nobody
   * else. Without this the room accepted ANY authenticated socket — an assayer who guessed a thread
   * UUID received every message on it, internal team notes included.
   */
  async feedbackVerdict(principal: SocketPrincipal, threadId: string): Promise<RoomVerdict> {
    const row = await this.dataSource
      .getRepository(FeedbackThreadEntity)
      .createQueryBuilder('t')
      .select('t.id', 'id')
      .addSelect('t.reporterUserId', 'reporterUserId')
      .addSelect('t.reporterAssayerId', 'reporterAssayerId')
      .where('t.id = :id', { id: threadId })
      .getRawOne<{ id: string; reporterUserId: string | null; reporterAssayerId: string | null }>();
    if (!row) return REFUSED_UNKNOWN;
    const isReporter =
      (!!row.reporterUserId && row.reporterUserId === principal.id) ||
      (!!row.reporterAssayerId && row.reporterAssayerId === principal.id);
    if (isReporter) return { found: true, allowed: true };
    const names = (principal.roles ?? []).map((r) => (typeof r === 'string' ? r : r?.name)).filter(Boolean) as string[];
    const isTeam = names.some((r) => FEEDBACK_TEAM_ROLE_NAMES.includes(r));
    return { found: true, allowed: isTeam };
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
