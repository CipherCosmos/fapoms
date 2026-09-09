import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * FAPOMS — Which organisation does a notification belong to?
 *
 * ## The hole this closes
 *
 * Fan-out was by ROLE alone. `ASSAYER_ONBOARDED` names `roles: ['OPERATIONS', 'ADMIN']`, that
 * resolved to every active holder of those roles on the whole deployment, and `notifications`
 * had no organisational column at all — 35 columns, not one of them saying whose data this
 * was. Activating an assayer in one organisation therefore put "${assayerName} is now active
 * and available for assignment" — a real person's name, a count of how many were activated,
 * and a working link to the roster record — into the bell of an OPERATIONS user belonging to a
 * different organisation. Reproduced live as finding F-07. The defect is in the shared fan-out,
 * so it was never one type's bug: every catalog entry with a non-empty `roles` list had it.
 *
 * ## Why not `TenantContext`
 *
 * `TenantContext` is the codebase's tenancy primitive and it is the wrong tool here, for the
 * reason its own comment states under "What this does NOT cover": it is `Scope.REQUEST`, so it
 * can only answer inside an HTTP request. A notification dispatch frequently is not in one.
 * `SlaScannerWorker`, `DeskEscalationService`, `ComplianceEscalationService`,
 * `FeedbackEscalationService` and the billing sweeps all emit from Bull jobs and cron scans
 * with no request anywhere in the stack, and `emitSafe` is deliberately fire-and-forget, so
 * even the request-borne calls can complete after the response has gone. Wired to
 * `TenantContext`, those paths would either throw `ForbiddenException` from
 * `requireOrganizationId()` (killing the alert) or read `null` and fan out to everybody again
 * (the bug, unchanged). Request scope is also contagious: injecting it here would make
 * `NotificationDispatchService` request-scoped, and with it the twenty-odd services that
 * inject the dispatcher, up to their controllers.
 *
 * So the organisation is derived from the **emitting entity** instead — the assayer, the
 * assignment, the branch the event is actually about. That is the same decision
 * `RegionGuardService.resolveEventRegion` already took for realtime routing, and for the same
 * reason it gives: "routing cannot depend on publishers remembering to add one — a forgotten
 * field would be a silent leak rather than a visible break". There are ~50 `emitSafe` call
 * sites today and an unbounded number tomorrow; a required `organizationId` argument on
 * `EmitOptions` would be forgotten, and forgetting it fails open.
 *
 * ## The model, stated once
 *
 * 1. Every notification row carries the organisation of the EVENT, not of the recipient. A row
 *    stamped org A is about org A's data no matter whose bell it ended up in — which is what
 *    lets the read side (`NotificationService`) refuse to show org A's row to an org B viewer.
 * 2. The role/permission fan-out is narrowed to users in that organisation. There is no
 *    cross-tenant exemption, not even for ADMIN/DEVELOPER — see `CROSS_TENANT_ROLES` in
 *    `tenant-context.ts` and the note on that decision in `NotificationDispatchService`.
 * 3. A type whose subject is the platform itself rather than any tenant's work declares
 *    `scope: 'PLATFORM'` in the catalog and is exempt. That is an explicit, per-type,
 *    code-reviewed decision; the default for a type that says nothing is TENANT, so a new
 *    catalog entry added without thinking about tenancy is scoped rather than global.
 * 4. When a TENANT-scoped event's organisation cannot be determined, the fan-out is refused
 *    and logged as an error. Nobody hears it, rather than everybody.
 */

/**
 * Whether a notification type is about one tenant's work or about the platform.
 *
 * Deliberately not overridable from the notification-admin screen: `UpdateNotificationSettingDto`
 * carries channels, roles, priority and wording, and tenant scope is none of those. An operator
 * who could re-classify a type as PLATFORM from a settings form could re-open F-07 with a
 * checkbox, which is precisely the class of change that should require a code review.
 */
export type NotificationScope = 'TENANT' | 'PLATFORM';

/** How the organisation on an outgoing notification was arrived at. */
export type TenancySource =
  /** The type is platform-scoped; there is no tenant and none was looked for. */
  | 'PLATFORM'
  /** The emitting call site passed `organizationId` outright. */
  | 'EXPLICIT'
  /** Derived from the entity the event is about. The normal answer. */
  | 'ENTITY'
  /** Nothing resolved, but the deployment has exactly one organisation — see `soleActiveOrganization`. */
  | 'SOLE_TENANT'
  /** Nothing resolved and there is more than one tenant. The fan-out is refused. */
  | 'UNRESOLVED';

export interface NotificationTenancy {
  scope: NotificationScope;
  organizationId: string | null;
  source: TenancySource;
  /** The identifiers that were tried, named for the error log when none of them resolved. */
  attempted: string[];
}

/** Distinguishes a real uuid from the placeholder ids some call sites pass (`entityId: 'backlog'`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How each `EmitOptions.entityType` reaches an owning organisation.
 *
 * Only six tables carry `organization_id` — `assayers`, `branches`, `clients`, `projects`,
 * `users` and `assayer_idempotency_records` — so everything else gets there by join, and the
 * joins are written here rather than discovered per call site. `COALESCE` orders the sources by
 * authority: the work's own project first (a project belongs to exactly one organisation by
 * definition), the person second (an assayer's organisation is equally definite but a record
 * can outlive an assayer reassignment).
 *
 * Every statement in this map is executed against the live schema by
 * `notification-tenant-isolation.db.spec.ts`. That test exists because a typo here does not
 * throw at compile time and does not throw at runtime either — `lookup` catches, returns null,
 * and the type quietly stops being delivered to anyone. A silent stop is the one failure mode
 * this whole mechanism must not have.
 */
const ENTITY_ORGANIZATION_SQL: Record<string, string> = {
  ASSAYER: `SELECT organization_id AS org FROM assayers WHERE id = $1`,
  BRANCH: `SELECT organization_id AS org FROM branches WHERE id = $1`,
  CLIENT: `SELECT organization_id AS org FROM clients WHERE id = $1`,
  PROJECT: `SELECT organization_id AS org FROM projects WHERE id = $1`,
  USER: `SELECT organization_id AS org FROM users WHERE id = $1`,

  ASSIGNMENT: `
    SELECT COALESCE(p.organization_id, asy.organization_id) AS org
      FROM assignments a
      LEFT JOIN projects p ON p.id = a.project_id
      LEFT JOIN assayers asy ON asy.id = a.assayer_id
     WHERE a.id = $1`,

  SCHEDULE: `
    SELECT COALESCE(p.organization_id, p2.organization_id, asy.organization_id) AS org
      FROM schedules s
      LEFT JOIN projects p ON p.id = s.project_id
      LEFT JOIN assignments a ON a.id = s.assignment_id
      LEFT JOIN projects p2 ON p2.id = a.project_id
      LEFT JOIN assayers asy ON asy.id = s.assayer_id
     WHERE s.id = $1`,

  PROJECT_BRANCH: `
    SELECT COALESCE(p.organization_id, b.organization_id) AS org
      FROM project_branches pb
      LEFT JOIN projects p ON p.id = pb.project_id
      LEFT JOIN branches b ON b.id = pb.branch_id
     WHERE pb.id = $1`,

  // `documents` reaches a project two ways and real rows use both, so neither can be dropped.
  DOCUMENT: `
    SELECT COALESCE(p1.organization_id, p2.organization_id) AS org
      FROM documents d
      LEFT JOIN project_branches pb ON pb.id = d.project_branch_id
      LEFT JOIN projects p1 ON p1.id = pb.project_id
      LEFT JOIN assessments ass ON ass.id = d.assessment_id
      LEFT JOIN projects p2 ON p2.id = ass.project_id
     WHERE d.id = $1`,

  VALIDATION: `
    SELECT COALESCE(p.organization_id, p2.organization_id) AS org
      FROM validation_cases vc
      LEFT JOIN project_branches pb ON pb.id = vc.project_branch_id
      LEFT JOIN projects p ON p.id = pb.project_id
      LEFT JOIN assessments ass ON ass.id = vc.assessment_id
      LEFT JOIN projects p2 ON p2.id = ass.project_id
     WHERE vc.id = $1`,

  VALIDATION_QUERY: `
    SELECT COALESCE(p.organization_id, asy.organization_id) AS org
      FROM validation_queries q
      LEFT JOIN validation_cases vc ON vc.id = q.validation_case_id
      LEFT JOIN project_branches pb ON pb.id = vc.project_branch_id
      LEFT JOIN projects p ON p.id = pb.project_id
      LEFT JOIN assayers asy ON asy.id = q.assayer_id
     WHERE q.id = $1`,

  EXPENSE: `
    SELECT COALESCE(p.organization_id, asy.organization_id) AS org
      FROM assignment_expenses e
      LEFT JOIN assignments a ON a.id = e.assignment_id
      LEFT JOIN projects p ON p.id = a.project_id
      LEFT JOIN assayers asy ON asy.id = e.assayer_id
     WHERE e.id = $1`,

  PAYABLE: `
    SELECT COALESCE(p.organization_id, asy.organization_id) AS org
      FROM assayer_payables pay
      LEFT JOIN projects p ON p.id = pay.project_id
      LEFT JOIN assayers asy ON asy.id = pay.assayer_id
     WHERE pay.id = $1`,

  ASSAYER_INVOICE: `
    SELECT asy.organization_id AS org
      FROM assayer_invoices i
      LEFT JOIN assayers asy ON asy.id = i.assayer_id
     WHERE i.id = $1`,

  /**
   * `ACCOUNT_LOCKED` passes the locked account's id, and that id is a `users` row for staff and
   * an `assayers` row for the field — two identity spaces, one column. Both are tried because
   * the emitter genuinely does not distinguish them (`notifyAccountLocked` is called from the
   * staff branch and the assayer branch of `login` alike). This is the account the event is
   * ABOUT, not the account being notified — deriving an event's tenant from its recipient is
   * exactly the mistake that would bless a leak (see the migration's note on the same point).
   */
  ACCOUNT: `
    SELECT COALESCE(u.organization_id, asy.organization_id) AS org
      FROM (SELECT $1::uuid AS id) x
      LEFT JOIN users u ON u.id = x.id
      LEFT JOIN assayers asy ON asy.id = x.id`,

  /**
   * Present even though every FEEDBACK type is platform-scoped: the scope decides who is fanned
   * out to, and this decides what the row is stamped with. Should feedback ever become a
   * per-tenant desk, flipping the catalog entries to TENANT is then the only change needed.
   */
  FEEDBACK: `
    SELECT COALESCE(u.organization_id, asy.organization_id) AS org
      FROM feedback_threads t
      LEFT JOIN users u ON u.id = t.reporter_user_id
      LEFT JOIN assayers asy ON asy.id = t.reporter_assayer_id
     WHERE t.id = $1`,
};

/** The `EmitOptions` fields this needs, without importing the dispatcher (which imports this). */
export interface TenancyLookupInput {
  type: string;
  entityType?: string | null;
  entityId?: string | null;
  assayerId?: string | null;
  organizationId?: string | null;
  payload?: Record<string, any> | null;
}

@Injectable()
export class NotificationTenancyService {
  private readonly logger = new Logger(NotificationTenancyService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * The organisation an outgoing notification belongs to.
   *
   * Ordered by how much the answer can be trusted: an explicit id from a caller that already
   * knows (the shape `TenantContext`'s own comment prescribes for background work — "carry the
   * organisation id explicitly in its job payload and pass it down"), then the entity the event
   * is about, then the single-tenant shortcut, then refusal.
   */
  async resolve(input: TenancyLookupInput, scope: NotificationScope): Promise<NotificationTenancy> {
    if (scope === 'PLATFORM') {
      return { scope, organizationId: null, source: 'PLATFORM', attempted: [] };
    }

    if (input.organizationId && UUID_RE.test(input.organizationId)) {
      return { scope, organizationId: input.organizationId, source: 'EXPLICIT', attempted: [] };
    }

    const payload = input.payload ?? {};
    /**
     * Every identifier this event carries that could name an owning organisation, in order.
     *
     * The entity the call site declared comes first because it is the event's actual subject.
     * The payload ids that follow are the redundancy that makes this work without touching 50
     * call sites: a desk-escalation event declares `entityType: 'DOCUMENT'` but also carries
     * `payload.projectBranchId`, an assignment event carries `payload.assignmentId`, and every
     * workforce event carries `assayerId` at the top level rather than in the payload (the same
     * asymmetry `resolveEventRegion` had to absorb).
     */
    const candidates: Array<[string, unknown]> = [
      [String(input.entityType ?? '').toUpperCase(), input.entityId],
      ['ASSAYER', input.assayerId],
      ['ASSAYER', payload.assayerId],
      ['ASSIGNMENT', payload.assignmentId],
      ['SCHEDULE', payload.scheduleId],
      ['PROJECT_BRANCH', payload.projectBranchId],
      ['BRANCH', payload.branchId],
      ['PROJECT', payload.projectId],
      ['CLIENT', payload.clientId],
    ];

    const attempted: string[] = [];
    for (const [kind, id] of candidates) {
      if (!kind || typeof id !== 'string' || !UUID_RE.test(id)) continue;
      if (!ENTITY_ORGANIZATION_SQL[kind]) continue;
      attempted.push(`${kind}:${id}`);
      const org = await this.lookup(kind, id);
      if (org) return { scope, organizationId: org, source: 'ENTITY', attempted };
    }

    const sole = await this.soleActiveOrganization();
    if (sole) return { scope, organizationId: sole, source: 'SOLE_TENANT', attempted };

    return { scope, organizationId: null, source: 'UNRESOLVED', attempted };
  }

  /**
   * The organisation of a deployment that has exactly one, or null.
   *
   * This is not a "null means everyone" branch — the thing `TenantScopedRepository`'s comment
   * forbids and this whole change exists to remove. It is the same reasoning the tenant-ownership
   * backfill used one migration earlier, in as many words: "There is exactly one real
   * organisation on this deployment… So 'which tenant does this row belong to?' has one
   * defensible answer and no ambiguity to resolve", and it refuses to guess in any other
   * situation. With one organisation there is no second tenant to leak to, so this cannot
   * disclose anything; with two it returns null and the strict path takes over on the very next
   * event, without a deploy.
   *
   * It earns its place on the aggregate sweeps. `PAYABLE_AWAITING_APPROVAL` and
   * `ASSIGNMENT_ATTENDED_NOT_CLOSED` are emitted by `SlaScannerWorker` with `entityId: 'backlog'`
   * — they are counts across every matching record, so there is no single entity to derive an
   * organisation from and nothing to look up. Without this they would resolve to UNRESOLVED and
   * stop being delivered the day this shipped, taking two money alerts with them. What they
   * genuinely need on a multi-tenant deployment is to be assembled per tenant at source; until
   * that is done they fail closed rather than leaking, which is the correct direction and is
   * logged as an error naming the type.
   */
  private async soleActiveOrganization(): Promise<string | null> {
    const cached = this.soleTenantCache;
    if (cached && cached.expires > Date.now()) return cached.organizationId;
    try {
      const rows = await this.dataSource.query(
        `SELECT id FROM organizations WHERE is_active = true LIMIT 2`,
      );
      const organizationId = rows?.length === 1 ? (rows[0].id as string) : null;
      this.soleTenantCache = { organizationId, expires: Date.now() + NotificationTenancyService.CACHE_TTL_MS };
      return organizationId;
    } catch (err: any) {
      // Never cached on failure, and never treated as "one tenant": an unreadable organisations
      // table must not become a licence to fan out.
      this.logger.warn(`Could not count organisations: ${err?.message}`);
      return null;
    }
  }

  private soleTenantCache: { organizationId: string | null; expires: number } | null = null;

  private readonly organizationCache = new Map<string, { organizationId: string | null; expires: number }>();
  /** A burst about one assayer (bulk activation is exactly this) is one lookup, not twenty-five. */
  private static readonly CACHE_TTL_MS = 60_000;
  /** Bounded, so a process that runs for weeks cannot grow this map without limit. */
  private static readonly CACHE_MAX = 5000;

  private async lookup(kind: string, id: string): Promise<string | null> {
    const key = `${kind}:${id}`;
    const hit = this.organizationCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.organizationId;

    let organizationId: string | null = null;
    try {
      const rows = await this.dataSource.query(ENTITY_ORGANIZATION_SQL[kind], [id]);
      organizationId = rows?.[0]?.org ?? null;
    } catch (err: any) {
      /**
       * Logged at warn and answered as "unknown". A failed lookup must not throw into
       * `emit`, which runs inside business transactions — but unlike `resolveEventRegion`,
       * which degrades to a wider broadcast, "unknown" here degrades to a NARROWER one: the
       * caller refuses the fan-out. That is why this is a warn and not a debug; a repeated
       * line here is the visible symptom of a type that has quietly stopped being delivered.
       */
      this.logger.warn(`Could not resolve the organisation for ${kind} ${id}: ${err?.message}`);
      return null;
    }

    if (this.organizationCache.size >= NotificationTenancyService.CACHE_MAX) this.organizationCache.clear();
    this.organizationCache.set(key, {
      organizationId,
      expires: Date.now() + NotificationTenancyService.CACHE_TTL_MS,
    });
    return organizationId;
  }

  /** Exposed for the schema test that executes every statement in the map. */
  static entityLookupKinds(): string[] {
    return Object.keys(ENTITY_ORGANIZATION_SQL);
  }

  /** Exposed for the same test — the statement itself, so it can be run against the real schema. */
  static entityLookupSql(kind: string): string {
    return ENTITY_ORGANIZATION_SQL[kind];
  }
}
