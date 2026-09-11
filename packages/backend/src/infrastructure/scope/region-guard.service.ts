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
import { SETTING_BY_KEY } from '../settings/settings.registry';

/** Distinguishes a UUID path param from a human-facing code on routes that accept both. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The staged-rollout switch the six added boundaries share. */
export const REGION_SCOPE_MODE_KEY = 'security.regionScope.mode';

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
    const mode = await this.readMode();
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
    const mode = await this.readMode();
    return mode === 'off' || mode === 'enforce' ? mode : 'log';
  }

  /**
   * The rollout mode, and what happens when it cannot be read.
   *
   * Both call sites used to end `.catch(() => 'log')`, which is a fail-OPEN on an access control:
   * this setting ships as `enforce` (see `settings.registry.ts`, and `security-defaults.spec.ts`,
   * which exists to pin exactly that), so a settings read that threw silently demoted six staged
   * boundaries from "refuse" to "write a warning and let it through" — and did so invisibly, since
   * Log mode's only symptom is a log line nobody is watching for.
   *
   * The failure is unlikely rather than impossible: `PlatformSettingsService.load` already catches
   * its own Redis/Postgres failures and resolves from environment-and-defaults. What reaches here
   * is the residue — an unexpected throw somewhere in that path. The right answer to "I could not
   * find out what the policy is" on a security control is the shipped policy, not the weakest one.
   *
   * `SETTING_BY_KEY` is a compile-time constant in the same process, so this fallback cannot
   * itself fail, and it cannot drift from the registry the way a hardcoded `'enforce'` would.
   */
  private async readMode(): Promise<string> {
    try {
      return await this.settings.get<string>(REGION_SCOPE_MODE_KEY);
    } catch (err: any) {
      const shipped = SETTING_BY_KEY[REGION_SCOPE_MODE_KEY]?.default ?? 'enforce';
      this.logger.error(
        `Could not read "${REGION_SCOPE_MODE_KEY}" (${err?.message ?? err}). ` +
          `Falling back to the shipped default "${shipped}" — a boundary whose policy cannot be ` +
          `read must not quietly stop enforcing.`,
      );
      return String(shipped);
    }
  }

  /** The ceiling, for a branch id. */
  async assertBranchInScope(branchId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!branchId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(`SELECT region FROM branches WHERE id = $1`, [branchId]);
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /**
   * The ceiling on the region a write is ABOUT TO SET, as opposed to the one already stored.
   *
   * `assertBranchInScope` answers "may this caller touch this record", by reading the record's
   * CURRENT region. That is the whole check on an edit that cannot move a record between regions —
   * and it is only half the check on one that can. `PUT /branches/:id` is the case in point:
   * the guard read the branch's current region, and then `BranchService.update` overwrote
   * `branch.region` from the request body without anyone looking. A region-scoped operator could
   * therefore take a branch they legitimately hold, name another region in the body, and push it
   * out of their own ceiling — a 200, a changed row, and a branch they can no longer see, read or
   * correct. Confirmed live before this existed: an EAST-assigned OPERATIONS account moved an EAST
   * branch to WEST and `branches.region` read `WEST` afterwards.
   *
   * So a route that lets the caller name a region must check BOTH ends: the record it is starting
   * from and the region it is landing in. Both are this same predicate; only the message differs,
   * because "you may not read that" and "you may not put it there" are different sentences to show
   * an operator.
   *
   * A `null` target passes, exactly as `assertRegionAllowed` lets a null record region through:
   * an unresolvable region is a data gap, not a boundary, and refusing it here would make a
   * branch in a state the region table does not know about impossible for a scoped operator to
   * enter at all. Such a branch is not in another region — it is in no region, and stays visible
   * to everyone, which is the same answer the read side gives.
   */
  assertRegionSettable(region: string | null | undefined, scope?: Partial<GlobalScope>): void {
    const allowed = scope?.regions;
    if (!allowed || allowed.length === 0) return;
    if (!region) return;
    if (!allowed.includes(region as any)) {
      throw new ForbiddenException(
        `Your account is not assigned to the ${region} region, so it cannot place a record there.`,
      );
    }
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

  /**
   * The ceiling, for a whole project. A project has no region of its own — it is a set of
   * branches that can legitimately span several — so unlike `assertBranchInScope` this cannot
   * compare one region. Instead it refuses the whole request if the project touches ANY branch
   * outside the caller's assigned regions, rather than silently narrowing to the in-scope slice:
   * a project-wide optimise/day-plan/deploy is a single operation over the whole set, and a
   * partial run over an arbitrarily-narrowed subset would be a different, silently-smaller
   * operation than the one the caller asked for and the one its result claims to be.
   */
  async assertProjectInScope(projectId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!projectId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT DISTINCT b.region
         FROM project_branches pb
         JOIN branches b ON b.id = pb.branch_id
        WHERE pb.project_id = $1`,
      [projectId],
    );
    const blocked = rows.some((r: any) => r.region && !(scope.regions as string[]).includes(r.region));
    if (blocked) {
      throw new ForbiddenException(
        'This project includes branches outside the regions your account is assigned to.',
      );
    }
  }

  /** The same ceiling as `assertProjectInScope`, for several projects checked in one call. */
  async assertProjectsInScope(projectIds: string[], scope?: Partial<GlobalScope>): Promise<void> {
    if (projectIds.length === 0 || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT DISTINCT b.region
         FROM project_branches pb
         JOIN branches b ON b.id = pb.branch_id
        WHERE pb.project_id = ANY($1)`,
      [projectIds],
    );
    const blocked = rows.some((r: any) => r.region && !(scope.regions as string[]).includes(r.region));
    if (blocked) {
      throw new ForbiddenException(
        'One or more of these projects include branches outside the regions your account is assigned to.',
      );
    }
  }

  /** The ceiling, for a coverage plan (plan → its project → that project's branches). */
  async assertCoveragePlanInScope(planId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!planId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT DISTINCT b.region
         FROM coverage_plans cp
         JOIN project_branches pb ON pb.project_id = cp.project_id
         JOIN branches b ON b.id = pb.branch_id
        WHERE cp.id = $1`,
      [planId],
    );
    const blocked = rows.some((r: any) => r.region && !(scope.regions as string[]).includes(r.region));
    if (blocked) {
      throw new ForbiddenException(
        'This coverage plan includes branches outside the regions your account is assigned to.',
      );
    }
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
   * Narrows a candidate id list to accounts whose region assignment covers `region` — same
   * predicate as `regionAllowed` below: an unassigned (national) account always passes, and a
   * region-assigned one passes only for its own region(s).
   *
   * `region: null` — the event's own region could not be resolved — passes everyone through
   * unfiltered, same reasoning as `assertRegionAllowed`'s note on a null record region: an
   * unresolvable region is a data gap, not a security boundary, and narrowing on it would make
   * the event permanently invisible to the very people who could notice and fix the gap.
   */
  async filterUsersByRegion(userIds: string[], region: string | null): Promise<string[]> {
    if (!region || userIds.length === 0) return userIds;
    const rows = await this.dataSource.query(
      `SELECT id, regions FROM users WHERE id = ANY($1)`,
      [userIds],
    );
    const regionsById = new Map<string, Region[] | null>(
      rows.map((r: any) => [
        r.id,
        Array.isArray(r.regions) && r.regions.length > 0 ? (r.regions as Region[]) : null,
      ]),
    );
    return userIds.filter((id) => this.regionAllowed(region, regionsById.get(id) ?? null));
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

  // ── Child rows: routes keyed on something that is not the anchor ──────────
  //
  // Every method above takes the id of a row that either IS the region anchor (a branch) or
  // reaches one by a path everybody already knows (assignment → project_branch → branch). The
  // methods below take the id of a CHILD row — a branch contact, a branch document, a payable,
  // a client line, a validation case, an assayer's commercial profile.
  //
  // These are the routes the ceiling kept missing, and the reason is structural rather than
  // careless: there was nothing here to call. An author writing `DELETE /branches/:id/contacts/
  // :contactId` found `assertBranchInScope` and no `assertBranchContactInScope`, and the handler
  // loads by `contactId` alone — the `:id` segment in the URL is decorative — so guarding on the
  // path's branch id would have been a check that proves nothing. Faced with "write the join
  // yourself or write nothing", they wrote nothing, on six routes, independently.
  //
  // Each one is one query, and each returns immediately for an unrestricted caller, so a national
  // account never pays for a resolution it cannot fail.

  /** The ceiling, for a branch contact (contact → branch). */
  async assertBranchContactInScope(contactId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!contactId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT b.region FROM branch_contacts c JOIN branches b ON b.id = c.branch_id WHERE c.id = $1`,
      [contactId],
    );
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /** The ceiling, for a branch document (document → branch). */
  async assertBranchDocumentInScope(documentId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!documentId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT b.region FROM branch_documents d JOIN branches b ON b.id = d.branch_id WHERE d.id = $1`,
      [documentId],
    );
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /** The ceiling, for a payout (assayer_payable → assignment → project_branch → branch). */
  async assertPayableInScope(payableId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!payableId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT b.region
         FROM assayer_payables p
         JOIN assignments a ON a.id = p.assignment_id
         JOIN project_branches pb ON pb.id = a.project_branch_id
         JOIN branches b ON b.id = pb.branch_id
        WHERE p.id = $1`,
      [payableId],
    );
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /**
   * The same ceiling for a whole batch of payouts, refused whole rather than half-applied.
   *
   * `approve`, `pay` and `bank-file` all take `payableIds: string[]`. Refusing per id inside the
   * loop that pays them would approve the in-region ones and then throw, leaving a half-run
   * payment batch; asking one question about the whole list before any of it is touched is the
   * shape `assayer.bulkTransitionLifecycle` and `project.associateBranches` already use.
   */
  async assertPayablesInScope(payableIds: string[], scope?: Partial<GlobalScope>): Promise<void> {
    if (!payableIds?.length || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT DISTINCT b.region
         FROM assayer_payables p
         JOIN assignments a ON a.id = p.assignment_id
         JOIN project_branches pb ON pb.id = a.project_branch_id
         JOIN branches b ON b.id = pb.branch_id
        WHERE p.id = ANY($1)`,
      [payableIds],
    );
    for (const row of rows) this.assertRegionAllowed(row.region, scope);
  }

  /** The ceiling, for a client line (billing_entry → assignment → project_branch → branch). */
  async assertBillingEntryInScope(entryId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!entryId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT b.region
         FROM billing_entries e
         JOIN assignments a ON a.id = e.assignment_id
         JOIN project_branches pb ON pb.id = a.project_branch_id
         JOIN branches b ON b.id = pb.branch_id
        WHERE e.id = $1`,
      [entryId],
    );
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /** The same ceiling for several assignments at once — an invoice names a list of them. */
  async assertAssignmentsInScope(assignmentIds: string[], scope?: Partial<GlobalScope>): Promise<void> {
    if (!assignmentIds?.length || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT DISTINCT b.region
         FROM assignments a
         JOIN project_branches pb ON pb.id = a.project_branch_id
         JOIN branches b ON b.id = pb.branch_id
        WHERE a.id = ANY($1)`,
      [assignmentIds],
    );
    for (const row of rows) this.assertRegionAllowed(row.region, scope);
  }

  /**
   * The ceiling, for an invoice — which can legitimately span regions, so the rule is
   * `assertProjectInScope`'s and not `assertBranchInScope`'s: refuse if ANY line lands outside
   * the caller's assignment, rather than narrowing to the in-scope slice. You do not get a
   * partial view of an invoice, and you do not get to send, cancel, pay or reverse one you can
   * only see part of.
   *
   * `stagedContext` picks which of the two enforcement paths applies, and the split is the whole
   * of the design rather than a convenience:
   *
   *  - OMITTED — enforce, always. The invoice WRITES pass nothing (`send`, `payment`, `cancel`,
   *    and `reverse` via `assertPaymentInScope`). A write has no listing it has to agree with,
   *    and a write boundary that fails open because a setting says so is not a boundary.
   *  - SUPPLIED — go through `assertRegionAllowedStaged`, so `security.regionScope.mode` decides
   *    and Log mode says which rollout the near-refusal belongs to. The invoice READS pass one
   *    (`getInvoice`, `getInvoiceDocument`), because each is the detail twin of a list that is
   *    itself staged: `findInvoicesPage` leaves its rows unfiltered in Off and Log mode, and
   *    `invoiceInRegion` in `billing-region-scope.ts` writes the invariant down outright — an
   *    invoice must not be listed or counted and then 403 when the operator opens it. A read
   *    enforcing unconditionally would break that pairing in exactly the two modes an operator
   *    reaches for when the boundary is misbehaving, which is when it needs to hold.
   *
   * The setting now defaults to `enforce` and the six boundaries it was introduced for have
   * finished their observation phase, so out of the box the two paths do the same thing. The
   * staged path costs nothing until somebody deliberately turns the lever down — the one moment
   * the list and the detail still have to agree with each other.
   */
  async assertInvoiceInScope(
    invoiceId: string | null | undefined,
    scope?: Partial<GlobalScope>,
    stagedContext?: string,
  ): Promise<void> {
    if (!invoiceId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT DISTINCT b.region
         FROM billing_entries e
         JOIN assignments a ON a.id = e.assignment_id
         LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
         LEFT JOIN branches b ON b.id = pb.branch_id
        WHERE e.invoice_id = $1 AND b.region IS NOT NULL`,
      [invoiceId],
    );
    for (const row of rows) {
      if (stagedContext) await this.assertRegionAllowedStaged(row.region, scope, stagedContext);
      else this.assertRegionAllowed(row.region, scope);
    }
  }

  /** The ceiling, for a recorded payment (payment → its payable, or → its invoice). */
  async assertPaymentInScope(paymentId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!paymentId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT payable_id, invoice_id FROM billing_payments WHERE id = $1`, [paymentId]);
    const row = rows?.[0];
    if (!row) return;
    if (row.payable_id) await this.assertPayableInScope(row.payable_id, scope);
    if (row.invoice_id) await this.assertInvoiceInScope(row.invoice_id, scope);
  }

  /** The ceiling, for a staff remark about an assayer (remark → assayer). */
  async assertAssayerRemarkInScope(remarkId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!remarkId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT a.region FROM assayer_remarks r JOIN assayers a ON a.id = r.assayer_id WHERE r.id = $1`,
      [remarkId],
    );
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /** The ceiling, for an assayer invoice — matched on the assayer's own home region. */
  async assertAssayerInvoiceInScope(invoiceId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!invoiceId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT a.region FROM assayer_invoices ai JOIN assayers a ON a.id = ai.assayer_id WHERE ai.id = $1`,
      [invoiceId],
    );
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /** The ceiling, for a validation case (case → project_branch → branch). */
  async assertValidationCaseInScope(caseId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!caseId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT b.region
         FROM validation_cases vc
         JOIN project_branches pb ON pb.id = vc.project_branch_id
         JOIN branches b ON b.id = pb.branch_id
        WHERE vc.id = $1`,
      [caseId],
    );
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /** The same, for the bulk transition — asked once, before any case is moved. */
  async assertValidationCasesInScope(caseIds: string[], scope?: Partial<GlobalScope>): Promise<void> {
    if (!caseIds?.length || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT DISTINCT b.region
         FROM validation_cases vc
         JOIN project_branches pb ON pb.id = vc.project_branch_id
         JOIN branches b ON b.id = pb.branch_id
        WHERE vc.id = ANY($1)`,
      [caseIds],
    );
    for (const row of rows) this.assertRegionAllowed(row.region, scope);
  }

  // The seven below reach an assayer's own region through one of their child rows. The first
  // three were written for `modules/assayer` by the campaign that could not edit it; the four
  // after them were added when that workstream came to call them and found its remaining routes
  // keyed on four more child tables — a workforce attribute, a score override, a reference and
  // an import issue — with the same nothing to call. All seven are one query, and all seven
  // return on their first line for an unrestricted caller.

  /** The ceiling, for an assayer's commercial profile (profile → assayer). */
  async assertCommercialProfileInScope(profileId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!profileId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT a.region FROM assayer_commercial_profiles cp JOIN assayers a ON a.id = cp.assayer_id WHERE cp.id = $1`,
      [profileId],
    );
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /** The ceiling, for an assayer document row (document → assayer). */
  async assertAssayerDocumentInScope(documentId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!documentId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT a.region FROM assayer_documents d JOIN assayers a ON a.id = d.assayer_id WHERE d.id = $1`,
      [documentId],
    );
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /** The ceiling, for an empanelment row (empanelment → assayer). */
  async assertEmpanelmentInScope(empanelmentId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!empanelmentId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT a.region FROM assayer_client_empanelments e JOIN assayers a ON a.id = e.assayer_id WHERE e.id = $1`,
      [empanelmentId],
    );
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /**
   * The ceiling, for a workforce attribute (attribute → assayer).
   *
   * `workforce_attributes`, not `assayer_workforce_attributes` — the one table in this family
   * whose name does not carry the prefix. It still hangs off `assayer_id` like the rest.
   */
  async assertWorkforceAttributeInScope(attributeId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!attributeId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT a.region FROM workforce_attributes w JOIN assayers a ON a.id = w.assayer_id WHERE w.id = $1`,
      [attributeId],
    );
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /** The ceiling, for a qualification-score override (override → assayer). */
  async assertScoreOverrideInScope(overrideId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!overrideId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT a.region FROM assayer_score_overrides o JOIN assayers a ON a.id = o.assayer_id WHERE o.id = $1`,
      [overrideId],
    );
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /** The ceiling, for a background-check reference (reference → assayer). */
  async assertAssayerReferenceInScope(referenceId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!referenceId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT a.region FROM assayer_references r JOIN assayers a ON a.id = r.assayer_id WHERE r.id = $1`,
      [referenceId],
    );
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /**
   * The ceiling, for a roster import issue (issue → assayer), where the issue may have no
   * assayer at all.
   *
   * `assayer_import_issues.assayer_id` is nullable and the commonest unresolved row is exactly
   * the one with nothing in it — a source code the importer could not match to anybody. Those
   * rows belong to no region, and `RosterRecordsService.listIssues` deliberately ORs them into
   * every scope rather than dropping them, on the grounds that a row nobody can see is a row
   * nobody can fix. The write side has to agree: an issue that no scoped desk could resolve
   * would be an entry that sits in the queue forever. A LEFT JOIN gives a null region for those,
   * which `assertRegionAllowed` already lets through under the same rule it applies to a branch
   * whose region is unknown — so this is the existing policy, not a second one.
   */
  async assertImportIssueInScope(issueId: string | null | undefined, scope?: Partial<GlobalScope>): Promise<void> {
    if (!issueId || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT a.region FROM assayer_import_issues i LEFT JOIN assayers a ON a.id = i.assayer_id WHERE i.id = $1`,
      [issueId],
    );
    this.assertRegionAllowed(rows?.[0]?.region, scope);
  }

  /**
   * The same ceiling for a batch of import issues, asked once before any of them is closed.
   *
   * `POST /assayers/roster/import-issues/resolve` takes a list and is explicitly built so that
   * one bad id never abandons the other sixty-seven. That rule is about ids that are unknown or
   * already closed, and it must not be quietly extended to ids the caller may not touch:
   * refusing per row inside the loop would close this region's issues, skip the other region's,
   * and report the skips as ordinary per-row outcomes — a cross-region refusal indistinguishable
   * from "somebody else got there first". Asked once, whole, like `assertPayablesInScope`.
   */
  async assertImportIssuesInScope(issueIds: string[], scope?: Partial<GlobalScope>): Promise<void> {
    if (!issueIds?.length || !scope?.regions?.length) return;
    const rows = await this.dataSource.query(
      `SELECT DISTINCT a.region
         FROM assayer_import_issues i
         LEFT JOIN assayers a ON a.id = i.assayer_id
        WHERE i.id = ANY($1)`,
      [issueIds],
    );
    for (const row of rows) this.assertRegionAllowed(row.region, scope);
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
