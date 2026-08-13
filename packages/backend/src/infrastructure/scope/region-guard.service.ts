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

import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GlobalScope } from './global-scope';

/** Distinguishes a UUID path param from a human-facing code on routes that accept both. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RegionGuardService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

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
}
