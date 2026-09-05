import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';

import { canonicalState } from '../planning/command-center.service';
import { IN_FLIGHT_ASSIGNMENT_STATUSES, sqlStatusList } from '../assignment/assignment-workload';
import {
  BUSINESS_TODAY_SQL, ASSAYER_RECORD_FIELDS, IDENTITY_DOCUMENTS, PLACEHOLDER_PIN_METRES,
  PAYOUT_BLOCKING_COLUMNS,
} from '@fapoms/shared';
import { GlobalScope } from '../../infrastructure/scope/global-scope';

/**
 * FAPOMS — HR workforce analytics.
 *
 * HR own the people, not the audit book, so this deliberately answers different
 * questions from the operations dashboard. Operations ask "can we cover tomorrow";
 * HR ask "is this workforce complete, compliant, staffed in the right places, and
 * is anyone falling through a gap".
 *
 * Everything here is derived from rows that already exist. Where the data is
 * missing — and on this deployment most of the HR record *is* missing — that
 * absence is reported as the finding rather than hidden behind a zero.
 */

/** Lifecycle order for onboarding. A candidate walks these in sequence. */
/**
 * Who counts as being on the workforce, for every panel on this console.
 *
 * Deletion here is soft — `remove()` sets `is_active = false` and cascades to the person's
 * documents, commercial profiles and assignments. Seventeen raw queries in this file select
 * `FROM assayers`, and the guard had been written into some of them and not others: the
 * headcount tiles filtered on `is_active`, while the onboarding pipeline, the records-
 * completeness worklist and two coverage denominators filtered only on exit/termination dates.
 *
 * The result was not subtle. With every assayer in this database soft-deleted, the headcount
 * read 0 while the onboarding pipeline listed all 8 of them as people waiting to be processed —
 * two panels on one screen disagreeing about whether the workforce exists.
 *
 * Stated once, and asserted by hr-workforce-soft-delete.spec.ts, because a rule that has to be
 * remembered seventeen times is a rule that will drift again.
 *
 * Note this is narrower than "not deleted": someone who has resigned or been terminated is also
 * off the roster, but their record is still live and still readable from their profile.
 */
/**
 * Has this person left, according to their status rather than their dates?
 *
 * `ON_ROSTER` below asks the same question of the DATES, and its comment has always said that
 * somebody who resigned or was terminated is off the roster. On this data those two disagree for
 * 25 people: they carry a departed lifecycle and no leaving date of any kind, because the roster
 * import never had one and the corrupt-date repair blanked the rest. Reading only the dates, all
 * 25 counted as current staff — in the headcount tile, in every coverage denominator, and in the
 * records-completeness worklist that asks a clerk to go and finish their details.
 *
 * So the status is asked too. The date test stays: it is the one that catches a departure entered
 * without the lifecycle being moved, and the two together are what "has gone" actually means.
 * A death is filed as INACTIVE with a reason rather than as a lifecycle value, which is why that
 * one case is spelled out — the same shape `DataIntegrityService.hasLeft` uses, deliberately.
 */
const HAS_LEFT = (p: string) =>
  `(${p}lifecycle_status IN ('RESIGNED', 'TERMINATED', 'ARCHIVED')`
  + ` OR (${p}lifecycle_status = 'INACTIVE' AND upper(coalesce(${p}unavailable_reason, '')) = 'DECEASED'))`;

const ON_ROSTER = `is_active = true AND exit_date IS NULL AND termination_date IS NULL AND NOT ${HAS_LEFT('')}`;

/** The same predicate for a query that aliases the table (`FROM assayers a`). */
const ON_ROSTER_A = `a.is_active = true AND a.exit_date IS NULL AND a.termination_date IS NULL AND NOT ${HAS_LEFT('a.')}`;

/**
 * The stages a candidate passes through, and the one they arrive at.
 *
 * ACTIVE is on the end because the funnel chart draws it as the destination — but it is not a
 * stage anyone is *waiting* in, and treating it as one is what made a healthy roster look
 * alarming: "stalled" and "average wait" were computed for it too, so eight people who had
 * been working happily for two months read as eight people stuck. `PRE_ACTIVE_STAGES` is what
 * those two questions are asked about.
 */
const ONBOARDING_STAGES = [
  { key: 'INVITED', label: 'Invited' },
  { key: 'DOCUMENT_VERIFICATION', label: 'Document check' },
  { key: 'BACKGROUND_VERIFICATION', label: 'Background check' },
  { key: 'TRAINING', label: 'Training' },
  { key: 'ACTIVE', label: 'Active' },
];

/** Everything before the destination — the stages "stalled" and "in onboarding" mean. */
const PRE_ACTIVE_STAGES: string[] = ONBOARDING_STAGES
  .filter((s) => s.key !== 'ACTIVE')
  .map((s) => s.key);

/** Past this many days in one onboarding stage, a candidate is stalled. */
const STALLED_AFTER_DAYS = 7;

/** An active assayer with no work for this long is a retention risk. */
const IDLE_AFTER_DAYS = 30;

/**
 * Fields that make up a complete workforce record, and why each one matters.
 * `critical` fields block something concrete — payroll, statutory filing, or
 * emergency response — so they are reported separately from merely-thin data.
 */
/**
 * The record's fields, and what a blank one blocks.
 *
 * This list used to live here and again in the web app, and the two disagreed: the roster
 * counted a missing phone as an incomplete record and this side did not, so the two screens
 * reported different people. It is one list now, in `@fapoms/shared`, read from both.
 */
const RECORD_FIELDS = ASSAYER_RECORD_FIELDS;

/**
 * The one key the whole overview is cached under. Named once so the write path below and the
 * read path in `overview()` cannot drift — a stale key here is invisible: the cache simply never
 * clears and the figures sit still for the full TTL.
 */
const OVERVIEW_CACHE_KEY = 'hr:workforce:overview';

@Injectable()
export class HrWorkforceService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cache: CacheService,
    private readonly events: DomainEventPublisher,
  ) {}

  /**
   * Drop the cached overview the moment an assayer record changes.
   *
   * Nothing invalidated this key. It was written with a 30 s TTL and left to expire, so an edit
   * made on the phone took up to `HR_OVERVIEW_CACHE_TTL_S` to show on the web — and that variable
   * is settable per deployment, so "up to 30 seconds" was only true where nobody had raised it.
   * Stacked on the web's own 60 s `staleTime`, an assayer could fix their details, watch the
   * phone say so, and still be told the record was incomplete a minute and a half later.
   *
   * The cache lives in shared Redis, so deleting the key on whichever node handled the write
   * clears it for every replica at once.
   *
   * One overview payload became several the moment the endpoint learned to answer by region: a
   * write anywhere could be inside a Kerala-scoped caller's cached page, a national caller's, both,
   * or neither. A single `del(OVERVIEW_CACHE_KEY)` only ever cleared the unscoped variant, so a
   * region-scoped desk kept reading a stale overview for the rest of the TTL after every edit.
   * `delByPattern` sweeps every cached variant — `hr:workforce:overview:all`,
   * `hr:workforce:overview:r:NORTH`, `hr:workforce:overview:r:EAST,WEST`, and so on — because an
   * edit to one assayer can change a figure any of them show.
   */
  onModuleInit(): void {
    const invalidate = () => { void this.cache.delByPattern(`${OVERVIEW_CACHE_KEY}:*`); };
    this.events.subscribe('assayer:updated', invalidate);
    this.events.subscribe('assayer:created', invalidate);
    this.events.subscribe('assayer:deleted', invalidate);
  }

  /**
   * The cache key for one scope. Named once so the write path above and the read path below
   * cannot drift the way `overview()` and this key already had — `overview()` cached itself under
   * the literal `'hr:workforce:overview'` instead of `OVERVIEW_CACHE_KEY`, which happened to be the
   * same string today but left nothing to stop the two texts drifting apart on the next edit.
   *
   * Sorted before joining so a caller assigned `[EAST, NORTH]` and one assigned `[NORTH, EAST]`
   * share a cache entry instead of silently doubling the cluster's HR overview traffic.
   */
  private static overviewCacheKey(scope?: GlobalScope): string {
    const suffix = scope?.regions?.length ? `r:${[...scope.regions].sort().join(',')}` : 'all';
    return `${OVERVIEW_CACHE_KEY}:${suffix}`;
  }

  private static num(v: any): number {
    return Number(v ?? 0);
  }

  /**
   * The region half of the caller's scope, as a WHERE fragment plus its bind parameter.
   *
   * Appended, never inserted: this pushes the regions array onto the END of the caller's OWN
   * params array, so it never renumbers a `$1…$n` the query already uses — the caller builds its
   * other bind values first, and the placeholder this returns is always `$` + that array's new
   * length. One implementation, so a query scoped by hand cannot say something subtly different
   * from a query scoped by calling this — see `hr-workforce-region-scope.spec.ts`, which fails on
   * a raw query that does neither this nor carries a reviewed exemption.
   *
   * Returns `''` when the scope carries no region constraint, so an unscoped caller's SQL is
   * byte-for-byte what it was before region scoping existed. `alias` is the range variable that
   * carries `region` in THIS query — `assayers` itself when the table has no `AS`, the join alias
   * otherwise (Postgres exposes an unaliased table under its own name, so `assayers.region` is
   * always valid there).
   */
  private static scopeSql(alias: string, params: unknown[], scope?: GlobalScope): string {
    if (!scope?.regions?.length) return '';
    params.push(scope.regions);
    return ` AND ${alias}.region = ANY($${params.length})`;
  }

  async overview(scope?: GlobalScope): Promise<any> {
    // ~22 queries across nine org-wide panels. HR data (headcount, compliance, expiries) changes
    // slowly, so cache the whole payload cluster-wide for a short TTL instead of re-running all of it
    // on every /hr overview load. Fault-tolerant: a Redis miss just runs the queries.
    const TTL = Number(process.env.HR_OVERVIEW_CACHE_TTL_S) || 30;
    return this.cache.wrap(HrWorkforceService.overviewCacheKey(scope), TTL, async () => {
      const [
        headcount,
        pipeline,
        compliance,
        expiries,
        capability,
        deployment,
        utilisation,
        attrition,
        activity,
        segments,
      ] = await Promise.all([
        this.headcount(scope),
        this.onboardingPipeline(scope),
        this.recordCompliance(scope),
        this.expiries(scope),
        this.capability(scope),
        this.deployment(scope),
        this.utilisation(scope),
        this.attrition(scope),
        this.recentActivity(scope),
        this.segments(scope),
      ]);

      return {
        generatedAt: new Date().toISOString(),
        // `null` means unscoped — every region, because the caller holds every region. A
        // restricted caller never resolves to `null` (see `GlobalScope.regions`), so the UI can
        // paint a scope chip whenever this is non-null without a second "am I actually narrowed"
        // check of its own.
        scope: scope?.regions?.length ? { regions: [...scope.regions] } : null,
        headcount,
        pipeline,
        compliance,
        expiries,
        capability,
        deployment,
        utilisation,
        attrition,
        activity,
        // The one server-side source for every count the roster's segment chips show — see
        // `segments()`.
        segments,
        // Surfaced first in the UI: the handful of things HR should act on today,
        // ranked, rather than left for someone to infer from nine panels.
        actions: this.deriveActions({ pipeline, compliance, expiries, deployment, utilisation }),
      };
    });
  }

  // ── Headcount ────────────────────────────────────────────────────────────

  private async headcount(scope?: GlobalScope) {
    const byLifecycleParams: unknown[] = [];
    const byLifecycleScope = HrWorkforceService.scopeSql('assayers', byLifecycleParams, scope);
    const byLifecycle = await this.dataSource.query(`
      SELECT COALESCE(lifecycle_status::text, 'UNKNOWN') AS stage, COUNT(*)::int AS count
      FROM assayers WHERE is_active = true${byLifecycleScope} GROUP BY 1 ORDER BY 2 DESC
    `, byLifecycleParams);
    const byEmploymentParams: unknown[] = [];
    const byEmploymentScope = HrWorkforceService.scopeSql('assayers', byEmploymentParams, scope);
    const byEmployment = await this.dataSource.query(`
      SELECT COALESCE(employment_type, 'UNSPECIFIED') AS type, COUNT(*)::int AS count
      FROM assayers WHERE ${ON_ROSTER}${byEmploymentScope}
      GROUP BY 1 ORDER BY 2 DESC
    `, byEmploymentParams);
    const tenureParams: unknown[] = [];
    const tenureScope = HrWorkforceService.scopeSql('assayers', tenureParams, scope);
    const tenure = await this.dataSource.query(`
      SELECT
        COUNT(*) FILTER (WHERE joining_date IS NULL)::int                                          AS unknown,
        COUNT(*) FILTER (WHERE joining_date > NOW() - INTERVAL '3 months')::int                    AS under_3m,
        COUNT(*) FILTER (WHERE joining_date <= NOW() - INTERVAL '3 months'
                           AND joining_date > NOW() - INTERVAL '1 year')::int                      AS m3_to_1y,
        COUNT(*) FILTER (WHERE joining_date <= NOW() - INTERVAL '1 year')::int                     AS over_1y
      FROM assayers WHERE ${ON_ROSTER}${tenureScope}
    `, tenureParams);
    const totalsParams: unknown[] = [];
    const totalsScope = HrWorkforceService.scopeSql('assayers', totalsParams, scope);
    const totals = await this.dataSource.query(`
      SELECT
        COUNT(*)::int                                                              AS total,
        COUNT(*) FILTER (WHERE lifecycle_status = 'ACTIVE')::int                   AS active,
        COUNT(*) FILTER (WHERE lifecycle_status IN ('INVITED','DOCUMENT_VERIFICATION','BACKGROUND_VERIFICATION','TRAINING')
                           AND ${ON_ROSTER})::int AS onboarding,
        -- Lifecycle status first, dates second. Active and onboarding are both counted from
        -- lifecycle_status; counting departures from the dates alone meant a resigned assayer
        -- appeared in none of the three until someone happened to fill a date field in by hand.
        --
        -- Through HAS_LEFT rather than its own status list, because that same fall-through came
        -- back for the one departure the list did not name: a death is filed as INACTIVE with a
        -- reason, so the person was neither active, nor onboarding, nor exited — present in the
        -- total and in none of the parts.
        COUNT(*) FILTER (WHERE ${HAS_LEFT('')}
                            OR exit_date IS NOT NULL OR termination_date IS NOT NULL)::int AS exited
      FROM assayers WHERE is_active = true${totalsScope}
    `, totalsParams);

    return {
      ...totals[0],
      byLifecycle,
      byEmployment,
      tenure: tenure[0],
    };
  }

  // ── Onboarding pipeline ──────────────────────────────────────────────────

  /**
   * Counts per stage, plus how long each candidate has sat there. Time-in-stage
   * comes from the last LIFECYCLE_TRANSITION into the current stage; a candidate
   * with no transition row falls back to when the record was created.
   */
  private async onboardingPipeline(scope?: GlobalScope) {
    const params: unknown[] = [];
    const scopeClause = HrWorkforceService.scopeSql('a', params, scope);
    const rows = await this.dataSource.query(
      `
      WITH last_move AS (
        SELECT DISTINCT ON (act.assayer_id) act.assayer_id, act.occurred_at,
               COALESCE(
                 act.performed_by_name,
                 NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
                 u.username
               ) AS performed_by_name
        FROM assayer_activities act
        LEFT JOIN users u ON act.performed_by::text ~ '^[0-9a-fA-F-]{36}$' AND u.id = act.performed_by::uuid
        -- Both spellings: the activity trail wrote the unprefixed name until the two trails
        -- were aligned on ASSAYER_LIFECYCLE_TRANSITION, and the 204 rows already recorded under
        -- the old name are still part of the history this query reports.
        WHERE act.event_type IN ('LIFECYCLE_TRANSITION', 'ASSAYER_LIFECYCLE_TRANSITION')
        ORDER BY act.assayer_id, act.occurred_at DESC
      )
      SELECT a.id, a.assayer_code AS "assayerCode", a.display_name AS "displayName",
             a.lifecycle_status AS stage, a.state, a.district,
             COALESCE(lm.occurred_at, a.created_at) AS "since",
             lm.performed_by_name AS "movedBy",
             EXTRACT(DAY FROM NOW() - COALESCE(lm.occurred_at, a.created_at))::int AS "daysInStage"
      FROM assayers a
      LEFT JOIN last_move lm ON lm.assayer_id = a.id
      WHERE ${ON_ROSTER_A}${scopeClause}
      ORDER BY "daysInStage" DESC
    `,
      params,
    );

    const stages = ONBOARDING_STAGES.map((s) => {
      const inStage = rows.filter((r: any) => r.stage === s.key);
      // Only pre-ACTIVE stages have a meaningful "stalled" or "average wait" — see
      // PRE_ACTIVE_STAGES. The comment used to say so while the code counted ACTIVE anyway,
      // which put an amber "waiting too long" beside a roster that was simply working.
      const isWaiting = PRE_ACTIVE_STAGES.includes(s.key);
      return {
        ...s,
        count: inStage.length,
        stalled: isWaiting
          ? inStage.filter((r: any) => r.daysInStage >= STALLED_AFTER_DAYS).length
          : 0,
        avgDaysInStage: isWaiting && inStage.length
          ? Math.round(inStage.reduce((t: number, r: any) => t + r.daysInStage, 0) / inStage.length)
          : 0,
      };
    });

    const stalled = rows
      .filter((r: any) => PRE_ACTIVE_STAGES.includes(r.stage) && r.daysInStage >= STALLED_AFTER_DAYS)
      .slice(0, 25);

    return {
      stalledAfterDays: STALLED_AFTER_DAYS,
      stages,
      stalled,
      /**
       * People actually part-way through onboarding.
       *
       * This counted everything that was not ACTIVE, which sweeps in RESIGNED, TERMINATED and
       * ARCHIVED records whose exit date was never filled in — and that is the common case, not
       * a rare one, which is why the headcount above is written to key off the status rather
       * than the date. The same person then appeared as "1 exited" in the header and "1 in
       * onboarding" in the tile beside it.
       */
      inProgress: rows.filter((r: any) => PRE_ACTIVE_STAGES.includes(r.stage)).length,
    };
  }

  // ── Record completeness ──────────────────────────────────────────────────

  /**
   * The single most useful HR view on this deployment: which parts of the
   * workforce record are actually filled in. A payout cannot be made without a
   * bank account, and TDS cannot be deducted without a PAN — so an empty column
   * here is an operational blocker, not a cosmetic gap.
   */
  /**
   * "This column is not usable", in SQL, saying exactly what `missingAssayerRecordFields` says.
   *
   * Blank is the general test — null, absent, or whitespace — and for ten of the eleven critical
   * columns it is the whole of it. `latitude` carries one more clause, because for that field
   * present and usable came apart: creating a record geocodes the address, so a person entered
   * with nothing but a state comes back holding that state's centroid. Not blank, therefore
   * complete, while the data-integrity scan raised the same record as a placeholder pin.
   *
   * Written once and read by all four call sites below. This list was consolidated into
   * `@fapoms/shared` precisely because a hand-copied version here had drifted from the screens'
   * version, and a rule that lives in only one of the two languages drifts the same way.
   */
  private static missingSql(column: string): string {
    const blank = `${column} IS NULL OR ${column}::text = ''`;
    return column === 'latitude'
      ? `(${blank} OR geo_accuracy_meters >= ${PLACEHOLDER_PIN_METRES})`
      : `(${blank})`;
  }

  /**
   * "Something on the critical list is blank" — the roster's "Incomplete record" rule, as one
   * WHERE fragment. Built from `missingSql` over exactly the columns `missingAssayerRecordFields`
   * in `@fapoms/shared` treats as critical, so this and the roster's client-side check start from
   * the same list. Shared between `recordCompliance()` (which also needs the per-column list for
   * `missingExpr` below, so cannot use this alone) and `segments()`'s `incomplete`/`ready` counts —
   * two panels asking "is this record incomplete" used to each spell that out by hand.
   */
  private static anyCriticalMissingSql(): string {
    return RECORD_FIELDS.filter((f) => f.critical).map((f) => HrWorkforceService.missingSql(f.column)).join(' OR ');
  }

  /** The narrower "cannot be paid" rule — only the three columns a payout actually needs. */
  private static anyPayoutBlockingMissingSql(): string {
    return PAYOUT_BLOCKING_COLUMNS.map((c) => HrWorkforceService.missingSql(c)).join(' OR ');
  }

  private async recordCompliance(scope?: GlobalScope) {
    const selects = RECORD_FIELDS.map(
      (f) => `COUNT(*) FILTER (WHERE NOT ${HrWorkforceService.missingSql(f.column)})::int AS "${f.column}"`,
    ).join(',\n        ');

    const filledParams: unknown[] = [];
    const filledScope = HrWorkforceService.scopeSql('assayers', filledParams, scope);
    const [filled] = await this.dataSource.query(`
      SELECT COUNT(*)::int AS total,
        ${selects}
      FROM assayers
      WHERE ${ON_ROSTER}${filledScope}
    `, filledParams);

    const total = HrWorkforceService.num(filled.total);
    const fields = RECORD_FIELDS.map((f) => {
      const have = HrWorkforceService.num(filled[f.column]);
      return {
        label: f.label,
        column: f.column,
        critical: f.critical,
        blocks: f.blocks,
        have,
        missing: total - have,
        pct: total ? Math.round((have / total) * 100) : 0,
      };
    }).sort((a, b) => Number(b.critical) - Number(a.critical) || a.pct - b.pct);

    // Who specifically is missing something critical — HR need names, not a bar.
    const criticalCols = RECORD_FIELDS.filter((f) => f.critical).map((f) => f.column);
    const missingExpr = criticalCols
      .map((c) => `CASE WHEN ${HrWorkforceService.missingSql(c)} THEN '${c}' END`)
      .join(', ');
    // Same fragment `segments()` uses for its `incomplete`/`ready` counts — one WHERE clause for
    // "something on the critical list is blank", not a second hand-copy of it here.
    const anyMissing = HrWorkforceService.anyCriticalMissingSql();

    const incompleteParams: unknown[] = [];
    const incompleteScope = HrWorkforceService.scopeSql('assayers', incompleteParams, scope);
    const incomplete = await this.dataSource.query(`
      SELECT id, assayer_code AS "assayerCode", display_name AS "displayName",
             state, district, lifecycle_status AS "lifecycleStatus",
             ARRAY_REMOVE(ARRAY[${missingExpr}], NULL) AS "missing"
      FROM assayers
      WHERE ${ON_ROSTER}
        AND (${anyMissing})${incompleteScope}
      ORDER BY ARRAY_LENGTH(ARRAY_REMOVE(ARRAY[${missingExpr}], NULL), 1) DESC NULLS LAST,
               assayer_code
      LIMIT 100
    `, incompleteParams);

    /**
     * How many records are incomplete, as opposed to how many fit on the page.
     *
     * `incompleteCount` was `incomplete.length`, and that query is capped at a hundred. So the
     * Overview's "records complete" figure and the Paperwork badge stopped moving past a
     * hundred while the per-field bars beside them — real aggregates — went on counting
     * thousands. Two numbers describing the same roster, side by side, on the same screen.
     */
    const incompleteTotalsParams: unknown[] = [];
    const incompleteTotalsScope = HrWorkforceService.scopeSql('assayers', incompleteTotalsParams, scope);
    const [incompleteTotals] = await this.dataSource.query(`
      SELECT COUNT(*)::int AS count
      FROM assayers
      WHERE ${ON_ROSTER}
        AND (${anyMissing})${incompleteTotalsScope}
    `, incompleteTotalsParams);

    // Only identity documents are verified, so only they are counted here. The register this
    // replaced defaulted every row to PENDING, which meant a joining form counted as an
    // unverified document for ever.
    //
    // Joined to `assayers` for two reasons at once: this is a "documents" query, which can only
    // reach a region through the assayer who owns it, and — the same bug `docCoverage` below was
    // already fixed for — the count used to have no join to `assayers` at all, so a document
    // belonging to someone who has since left stayed in this breakdown while `docCoverage`'s
    // `roster` denominator (which DOES filter to `ON_ROSTER`) had already dropped them. Adding the
    // join needed to reach `region` closed the same "two halves, two populations" gap here too.
    const govDocsParams: unknown[] = [];
    const govDocsScope = HrWorkforceService.scopeSql('a', govDocsParams, scope);
    const govDocs = await this.dataSource.query(`
      SELECT g.verification_status AS status, COUNT(*)::int AS count
      FROM assayer_documents g
      JOIN assayers a ON a.id = g.assayer_id
      WHERE g.is_active = true AND g.verification_status IS NOT NULL
        AND ${ON_ROSTER_A}${govDocsScope}
      GROUP BY 1
    `, govDocsParams);

    /**
     * Both halves of every ratio count the same people.
     *
     * The numerators used to have no join to `assayers` at all — `is_active` in them was the
     * DOCUMENT's flag, not the person's — while the denominator was the roster. So anyone who
     * had left (exit date set, documents untouched) stayed in the numerator and dropped out of
     * the denominator, and the tile could read "9/8" in green while roster members genuinely had
     * no ID on file. A coverage figure whose two halves describe different populations is not a
     * coverage figure.
     *
     * The two `COUNT(DISTINCT)`s here were flagged by the Phase 4 audit and left alone on the
     * measurements. On a copy of the 200k fixture with the document tables filled to match its
     * 5,038-assayer roster (15,081 government documents, 20,108 files) this whole statement is
     * 13.1 ms warm, and the distinct counts are not the expensive part of it — both document
     * tables are already indexed on `assayer_id`, and the cost is dominated by the roster count
     * beside them, which has to visit all 5,026 rows however it is written. On the fixture as
     * shipped it is 1.0 ms. It runs behind `overview()`'s 30 s cluster-wide cache, under a
     * 60 s react-query staleTime, on a page only HR and admins can open, with no polling and no
     * socket invalidation — so this is at most a couple of executions a minute, and an index
     * that could only shave part of 13 ms does not pay for itself.
     *
     * These figures also cannot be approximated away: `HrCompliancePage` renders them verbatim as
     * "N/total" and derives an exact badge count from `roster - withGovDoc`, and it has a
     * `withGovDoc === 0` branch that prints "No identity document has been recorded for anyone
     * on the roster." An estimate that lands on zero would publish that as a finding.
     */
    // The identity half of the list, passed in rather than inlined so the one definition in
    // @fapoms/shared stays the only one.
    //
    // Three subqueries, three range variables carrying `region` (`assayers` unaliased, then two
    // `a`s) — each gets its own call to `scopeSql`, appended after `$1` so the identity-documents
    // list keeps its place. Recomputing the same regions array three times over one round trip
    // costs nothing worth avoiding; keeping `roster` and its two numerators scoped identically is
    // the whole point of the comment above this query.
    const docCoverageParams: unknown[] = [IDENTITY_DOCUMENTS as unknown as string[]];
    const docCoverageRosterScope = HrWorkforceService.scopeSql('assayers', docCoverageParams, scope);
    const docCoverageGovScope = HrWorkforceService.scopeSql('a', docCoverageParams, scope);
    const docCoverageFileScope = HrWorkforceService.scopeSql('a', docCoverageParams, scope);
    const [docCoverage] = await this.dataSource.query(`
      SELECT
        (SELECT COUNT(*)::int FROM assayers WHERE ${ON_ROSTER}${docCoverageRosterScope}) AS roster,
        (SELECT COUNT(DISTINCT g.assayer_id)::int
           FROM assayer_documents g
           JOIN assayers a ON a.id = g.assayer_id
          WHERE g.is_active = true AND ${ON_ROSTER_A}
            AND g.requirement = ANY($1)
            -- On file means a copy arrived or a number was taken. A row that exists only to say
            -- "not received" is the absence this figure is measuring, not the presence of it.
            AND (g.soft_copy_received IS TRUE OR g.hard_copy_received IS TRUE
                 OR NULLIF(g.document_number, '') IS NOT NULL)${docCoverageGovScope}) AS "withGovDoc",
        (SELECT COUNT(DISTINCT d.assayer_id)::int
           FROM assayer_documents d
           JOIN assayers a ON a.id = d.assayer_id
          WHERE d.is_active = true AND ${ON_ROSTER_A}
            AND jsonb_array_length(d.file_paths) > 0${docCoverageFileScope}) AS "withFile"
    `, docCoverageParams);

    /**
     * People whose audits are attended by somebody other than the person empanelled.
     *
     * The roster records it in words — "Staff doing audit", "Husband doing audit" — and every
     * audit those rows cover was signed off by somebody no client empanelled and nobody vetted.
     * It is the most serious thing the import surfaces, so it gets a count of its own rather
     * than living inside a per-record completeness percentage.
     *
     * Counted separately from the list, for the reason spelled out above `incompleteTotals`:
     * a capped list's length is not a total, and a compliance figure that quietly stops at the
     * cap reads as "that is all of them".
     */
    const workByOthersTotalParams: unknown[] = [];
    const workByOthersTotalScope = HrWorkforceService.scopeSql('assayers', workByOthersTotalParams, scope);
    const [workByOthersTotal] = await this.dataSource.query(`
      SELECT COUNT(*)::int AS count FROM assayers
      WHERE ${ON_ROSTER} AND work_done_by_someone_else = true${workByOthersTotalScope}
    `, workByOthersTotalParams);
    const workByOthersParams: unknown[] = [];
    const workByOthersScope = HrWorkforceService.scopeSql('assayers', workByOthersParams, scope);
    const workByOthers = await this.dataSource.query(`
      SELECT id, assayer_code AS "assayerCode", display_name AS "displayName",
             state, lifecycle_status AS "lifecycleStatus"
      FROM assayers
      WHERE ${ON_ROSTER} AND work_done_by_someone_else = true${workByOthersScope}
      ORDER BY assayer_code
      LIMIT 100
    `, workByOthersParams);

    return {
      roster: total,
      fields,
      incomplete,
      incompleteCount: HrWorkforceService.num(incompleteTotals?.count),
      governmentDocuments: { byStatus: govDocs, ...docCoverage },
      workByOthers,
      workByOthersCount: HrWorkforceService.num(workByOthersTotal?.count),
    };
  }

  // ── Expiring credentials ─────────────────────────────────────────────────

  /**
   * The same credentials the dashboard paints, but as a list something can act on.
   * Painting a panel only helps whoever opens it; renewals were being missed because
   * nothing ever pushed this at HR. Already-expired rows are included — those are the
   * ones that most need chasing.
   *
   * ## Why certifications are in here now
   *
   * This used to read the identity register alone, and certifications live in
   * `workforce_attributes` with `type = 'CERTIFICATION'`. That produced the worst possible
   * split: `assayer.service.ts` REFUSES to assign an assayer whose certification has expired,
   * `HrCompliancePage` paints a panel titled "Certifications falling due", and the only thing
   * that actually pushes a warning at anybody — this method, via the SLA scanner and the
   * morning digest — could not see certifications at all. A certification therefore lapsed in
   * complete silence until the day an assignment was refused, at which point the renewal that
   * needed a month's notice had not been started. The dashboard's own `expiries()` below has
   * always read both tables; only the actionable list was missing half its subject.
   *
   * `credentialKind` is what lets a caller warn in the right words — an identity document and
   * a professional certification are renewed by different people through different processes,
   * so they are two notification types, not one. It is an added field, never a removed one:
   * existing callers that read `documentName`/`expiryDate`/`assayerName` (the email digest)
   * keep working unchanged, and `documentName` carries the certification's `name` so those
   * callers render something meaningful for the new rows without knowing they exist.
   *
   * One `LIMIT 200` over the union rather than 200 each: the cap exists to bound a single
   * scanner tick, and the soonest-expiring rows are the ones worth spending it on regardless
   * of which table they came from.
   *
   * region-scope-reviewed: deliberately NOT scoped. Both callers are cron-triggered background
   * sweeps (`SlaScannerWorker`, `EmailDigestService`) with no HTTP request and no principal behind
   * them, so there is no caller region to thread through — a renewal that is about to lapse needs
   * chasing regardless of which desk happens to have the HR overview open at the time. See
   * `hr-workforce-region-scope.spec.ts`'s allowlist for the same note in the fitness test itself.
   */
  async credentialsExpiringWithin(days: number): Promise<
    {
      id: string;
      documentName: string;
      expiryDate: string;
      assayerId: string;
      assayerName: string;
      credentialKind: 'DOCUMENT' | 'CERTIFICATION';
    }[]
  > {
    return this.dataSource.query(
      `
      SELECT * FROM (
        SELECT g.id, g.requirement AS "documentName", g.expiry_date::date::text AS "expiryDate",
               a.id AS "assayerId", a.display_name AS "assayerName",
               'DOCUMENT' AS "credentialKind"
        FROM assayer_documents g
        JOIN assayers a ON a.id = g.assayer_id
        WHERE g.is_active = true AND g.expiry_date IS NOT NULL
          AND ${ON_ROSTER_A}
          AND g.expiry_date::date <= ${BUSINESS_TODAY_SQL} + ($1 || ' days')::interval

        UNION ALL

        -- Certifications are workforce attributes, not documents; the type column is the plain
        -- varchar discriminator (SKILL | CERTIFICATION | LANGUAGE) that assayer.service.ts
        -- writes on import and reads back when it enforces expiry. Skills and languages have no
        -- expiry to chase, so only CERTIFICATION rows belong in a renewal queue.
        SELECT w.id, w.name AS "documentName", w.expiry_date::date::text AS "expiryDate",
               a.id AS "assayerId", a.display_name AS "assayerName",
               'CERTIFICATION' AS "credentialKind"
        FROM workforce_attributes w
        JOIN assayers a ON a.id = w.assayer_id
        WHERE w.is_active = true AND w.type = 'CERTIFICATION' AND w.expiry_date IS NOT NULL
          AND ${ON_ROSTER_A}
          AND w.expiry_date::date <= ${BUSINESS_TODAY_SQL} + ($1 || ' days')::interval
      ) credentials
      ORDER BY "expiryDate" ASC
      LIMIT 200
    `,
      [days],
    );
  }

  /** Certifications and identity documents falling due, so renewals start early. */
  private async expiries(scope?: GlobalScope) {
    const certificationsParams: unknown[] = [];
    const certificationsScope = HrWorkforceService.scopeSql('a', certificationsParams, scope);
    const certifications = await this.dataSource.query(`
      SELECT w.id, w.name, w.type, w.level, w.expiry_date AS "expiryDate",
             a.id AS "assayerId", a.assayer_code AS "assayerCode", a.display_name AS "displayName",
             a.state,
             (w.expiry_date::date - ${BUSINESS_TODAY_SQL})::int AS "daysToExpiry"
      FROM workforce_attributes w
      JOIN assayers a ON a.id = w.assayer_id
      WHERE w.is_active = true AND w.expiry_date IS NOT NULL
        AND ${ON_ROSTER_A}${certificationsScope}
        AND w.expiry_date::date <= ${BUSINESS_TODAY_SQL} + INTERVAL '180 days'
      ORDER BY w.expiry_date ASC
      LIMIT 100
    `, certificationsParams);

    const documentsParams: unknown[] = [];
    const documentsScope = HrWorkforceService.scopeSql('a', documentsParams, scope);
    const documents = await this.dataSource.query(`
      SELECT g.id, g.requirement AS "documentType", g.expiry_date AS "expiryDate",
             g.verification_status AS "verificationStatus",
             a.id AS "assayerId", a.assayer_code AS "assayerCode", a.display_name AS "displayName",
             (g.expiry_date::date - ${BUSINESS_TODAY_SQL})::int AS "daysToExpiry"
      FROM assayer_documents g
      JOIN assayers a ON a.id = g.assayer_id
      WHERE g.is_active = true AND g.expiry_date IS NOT NULL
        AND ${ON_ROSTER_A}${documentsScope}
        AND g.expiry_date::date <= ${BUSINESS_TODAY_SQL} + INTERVAL '180 days'
      ORDER BY g.expiry_date ASC
      LIMIT 100
    `, documentsParams);

    /**
     * The buckets count the whole set; the rows above are the hundred soonest.
     *
     * These four figures used to be counted in JS over those hundred rows, so on any roster
     * with more than a hundred credentials lapsing inside six months they described the page
     * rather than the workforce. With a backlog of expired ones the hundred soonest are all
     * expired, which reported "0 expiring within 30 days" and silently dropped the renewal
     * action derived from it — the counts said the quietest possible thing exactly when there
     * was most to do.
     *
     * Two more fixes riding along with the region-scoping pass, both specific to the certification
     * side (`workforce_attributes` carries SKILL and LANGUAGE rows too, and none of them have an
     * `expiry_date`, so in practice this was harmless — but "in practice" is not the same claim as
     * "correct", and `certificate-lapsed-parity.spec.ts` pins the `lapsed` segment count to a rule
     * that names the type explicitly):
     *   - `typeFilter` restricts the certification call to `type = 'CERTIFICATION'`, matching the
     *     `lapsed` segment's own EXISTS clause below instead of trusting every expiring row in the
     *     table to happen to be one.
     *   - `COUNT(DISTINCT … assayer_id)` replaces `COUNT(*)`, so somebody holding two certificates
     *     that both lapse this month is one person in "within30", not two — the same "count people,
     *     not rows" correction `docCoverage` and `capability()`'s coverage figures already apply.
     */
    const bucketsFor = async (table: string, alias: string, dateColumn: string, typeFilter = '') => {
      const params: unknown[] = [];
      const scopeClause = HrWorkforceService.scopeSql('a', params, scope);
      const [counts] = await this.dataSource.query(`
        SELECT COUNT(DISTINCT assayer_id) FILTER (WHERE days < 0)::int                 AS expired,
               COUNT(DISTINCT assayer_id) FILTER (WHERE days BETWEEN 0 AND 30)::int    AS within30,
               COUNT(DISTINCT assayer_id) FILTER (WHERE days > 30 AND days <= 90)::int AS within90,
               COUNT(DISTINCT assayer_id) FILTER (WHERE days > 90)::int                AS within180
          FROM (
            SELECT ${alias}.assayer_id AS assayer_id,
                   (${alias}.${dateColumn}::date - ${BUSINESS_TODAY_SQL})::int AS days
              FROM ${table} ${alias}
              JOIN assayers a ON a.id = ${alias}.assayer_id
             WHERE ${alias}.is_active = true AND ${alias}.${dateColumn} IS NOT NULL
               AND ${ON_ROSTER_A}${typeFilter}${scopeClause}
               AND ${alias}.${dateColumn}::date <= ${BUSINESS_TODAY_SQL} + INTERVAL '180 days'
          ) lapsing
      `, params);
      return {
        expired: HrWorkforceService.num(counts?.expired),
        within30: HrWorkforceService.num(counts?.within30),
        within90: HrWorkforceService.num(counts?.within90),
        within180: HrWorkforceService.num(counts?.within180),
      };
    };

    const [certificationCounts, documentCounts] = await Promise.all([
      bucketsFor('workforce_attributes', 'w', 'expiry_date', " AND w.type = 'CERTIFICATION'"),
      bucketsFor('assayer_documents', 'g', 'expiry_date'),
    ]);

    return {
      certifications: { rows: certifications, ...certificationCounts },
      documents: { rows: documents, ...documentCounts },
    };
  }

  // ── Capability inventory ─────────────────────────────────────────────────

  /**
   * What the workforce can actually do. Language matters operationally here: an
   * audit in Tamil Nadu goes better with a Tamil speaker, so language coverage is
   * reported against where the branches are, not just as a total.
   */
  private async capability(scope?: GlobalScope) {
    /**
     * `COUNT(DISTINCT w.assayer_id)` per `(type, name)` — a skill's headline number is how many
     * PEOPLE hold it, so a person who recorded the same skill twice must count once.
     *
     * Flagged by the Phase 4 audit; kept, and made cheap with an index instead of a rewrite. At
     * the fixture's roster fully profiled (40,405 attribute rows) this was 80.1 ms warm, almost
     * all of it a sort of every row by `(type, name, assayer_id)` that the `DISTINCT` aggregate
     * forces — Postgres cannot hash-aggregate a DISTINCT aggregate.
     * `1791000000000-WorkforceVocabularyIndex` provides that order, taking the same SQL to
     * 19.2 ms; the migration carries the full numbers and the rejected pre-aggregation rewrite.
     *
     * Unlike the vocabulary endpoint that shares this shape, this one was never urgent on its
     * own — it is inside `overview()`, behind a 30 s cache, and 0.3 ms on today's data. It gets
     * the improvement as a free rider on an index bought for the uncached picker.
     */
    const byTypeParams: unknown[] = [];
    const byTypeScope = HrWorkforceService.scopeSql('a', byTypeParams, scope);
    const byType = await this.dataSource.query(`
      SELECT w.type, w.name, COUNT(DISTINCT w.assayer_id)::int AS "assayerCount"
      FROM workforce_attributes w
      JOIN assayers a ON a.id = w.assayer_id
      WHERE w.is_active = true AND ${ON_ROSTER_A}${byTypeScope}
      GROUP BY 1, 2
      ORDER BY 1, 3 DESC
    `, byTypeParams);

    // Same rule as the document coverage above: numerator and denominator must count the same
    // people, or `unprofiled` goes negative and the "N assayers have no recorded skill" warning
    // disappears exactly when the data is worst.
    //
    // Three more flagged `COUNT(DISTINCT)`s, also left as they are: 18.6 ms at the fully-profiled
    // roster (1.2 ms today), 14.3 ms once the vocabulary index above is in place, behind the same
    // 30 s cache. Rewriting the three subqueries as one pass with `FILTER` was measured and is
    // slightly WORSE (18.3 ms) — each subquery already prunes to its own type, whereas the single
    // pass sorts every attribute row three times over.
    //
    // Note `withSkill` is load-bearing even though the frontend renders none of this object: it
    // is the input to `unprofiled` below, which IS displayed. `withLanguage` and
    // `withCertification` are genuinely unread by any consumer — dead payload on every response,
    // worth removing, but that is an API-shape change and not part of a query-cost pass.
    const coverageParams: unknown[] = [];
    const skillScope = HrWorkforceService.scopeSql('a', coverageParams, scope);
    const languageScope = HrWorkforceService.scopeSql('a', coverageParams, scope);
    const certificationScope = HrWorkforceService.scopeSql('a', coverageParams, scope);
    const coverageRosterScope = HrWorkforceService.scopeSql('assayers', coverageParams, scope);
    const [coverage] = await this.dataSource.query(`
      SELECT
        (SELECT COUNT(DISTINCT w.assayer_id)::int FROM workforce_attributes w
           JOIN assayers a ON a.id = w.assayer_id
          WHERE w.type='SKILL' AND w.is_active=true AND ${ON_ROSTER_A}${skillScope})         AS "withSkill",
        (SELECT COUNT(DISTINCT w.assayer_id)::int FROM workforce_attributes w
           JOIN assayers a ON a.id = w.assayer_id
          WHERE w.type='LANGUAGE' AND w.is_active=true AND ${ON_ROSTER_A}${languageScope})      AS "withLanguage",
        (SELECT COUNT(DISTINCT w.assayer_id)::int FROM workforce_attributes w
           JOIN assayers a ON a.id = w.assayer_id
          WHERE w.type='CERTIFICATION' AND w.is_active=true AND ${ON_ROSTER_A}${certificationScope}) AS "withCertification",
        (SELECT COUNT(*)::int FROM assayers WHERE ${ON_ROSTER}${coverageRosterScope})                 AS roster
    `, coverageParams);

    const group = (t: string) => byType.filter((r: any) => r.type === t).slice(0, 20);

    return {
      coverage,
      skills: group('SKILL'),
      languages: group('LANGUAGE'),
      certifications: group('CERTIFICATION'),
      // An assayer with no recorded capability cannot be matched on competency.
      // Clamped at zero. It is a count of people, and a negative one is not a smaller problem
      // than zero — it is a broken figure that also silences the warning gated on `> 0`.
      unprofiled: Math.max(0, HrWorkforceService.num(coverage.roster) - HrWorkforceService.num(coverage.withSkill)),
    };
  }

  // ── Where the people are vs where the work is ────────────────────────────

  /**
   * Supply and demand per state. This is HR's hiring brief: branches carry the
   * work, assayers carry the capacity, and the gap between them says where to
   * recruit. State spellings differ between the branch and assayer imports, so
   * both sides are canonicalised before being compared.
   */
  private async deployment(scope?: GlobalScope) {
    const supplyParams: unknown[] = [];
    const supplyScope = HrWorkforceService.scopeSql('assayers', supplyParams, scope);
    const supplyRaw = await this.dataSource.query(`
      SELECT state, COUNT(*)::int AS assayers,
             COUNT(*) FILTER (WHERE lifecycle_status = 'ACTIVE')::int AS active
      FROM assayers
      WHERE ${ON_ROSTER}${supplyScope}
      GROUP BY 1
    `, supplyParams);
    // `branches` carries its own `region` column (the materialised copy `resolveRegion(state)`
    // keeps in step — see regions.ts), so this reaches the scope directly rather than through a
    // join to assayers: the demand side of "supply vs demand" has no assayer to join through.
    const demandParams: unknown[] = [];
    const demandScope = HrWorkforceService.scopeSql('branches', demandParams, scope);
    const demandRaw = await this.dataSource.query(`
      SELECT state, COUNT(*)::int AS branches
      FROM branches WHERE is_active = true${demandScope} GROUP BY 1
    `, demandParams);

    const map = new Map<string, { state: string; assayers: number; active: number; branches: number }>();
    const touch = (raw: string | null) => {
      const key = canonicalState(raw);
      if (!map.has(key)) map.set(key, { state: key, assayers: 0, active: 0, branches: 0 });
      return map.get(key)!;
    };
    for (const r of supplyRaw) {
      const e = touch(r.state);
      e.assayers += HrWorkforceService.num(r.assayers);
      e.active += HrWorkforceService.num(r.active);
    }
    for (const r of demandRaw) touch(r.state).branches += HrWorkforceService.num(r.branches);

    const territories = [...map.values()]
      .map((t) => {
        const ratio = t.active ? t.branches / t.active : t.branches ? Infinity : 0;
        let posture: 'NO_COVERAGE' | 'STRETCHED' | 'BALANCED' | 'SURPLUS' | 'NO_WORK';
        if (t.branches === 0) posture = t.active ? 'NO_WORK' : 'BALANCED';
        else if (t.active === 0) posture = 'NO_COVERAGE';
        else if (ratio > 12) posture = 'STRETCHED';
        else if (ratio < 3) posture = 'SURPLUS';
        else posture = 'BALANCED';
        return {
          ...t,
          branchesPerAssayer: Number.isFinite(ratio) ? Math.round(ratio * 10) / 10 : null,
          posture,
        };
      })
      .sort((a, b) => b.branches - a.branches || b.assayers - a.assayers);

    return {
      territories,
      hiringNeeded: territories.filter((t) => t.posture === 'NO_COVERAGE' || t.posture === 'STRETCHED'),
      idleTerritories: territories.filter((t) => t.posture === 'NO_WORK'),
    };
  }

  // ── Utilisation and wellbeing ────────────────────────────────────────────

  private async utilisation(scope?: GlobalScope) {
    // Deliberately NOT factored into a shared predicate string: `hr-workforce-soft-delete.spec.ts`
    // statically scans each query's OWN text for its guard (`is_active` / `ON_ROSTER`) — a query
    // that instead references a constant defined elsewhere is, in that test's own words, "reading
    // its neighbour's text", which is invisible to a scanner built to catch exactly this kind of
    // drift. The two queries below must still agree with each other, so they are kept textually
    // identical on this line by eye rather than by the compiler — the same trade this file makes
    // everywhere else (`ON_ROSTER_A` is itself a shared constant, but every query still writes
    // `${ON_ROSTER_A}` inline rather than composing a bigger shared clause on top of it).
    const idleParams: unknown[] = [IDLE_AFTER_DAYS];
    const idleScope = HrWorkforceService.scopeSql('a', idleParams, scope);
    const idle = await this.dataSource.query(
      `
      SELECT a.id, a.assayer_code AS "assayerCode", a.display_name AS "displayName",
             a.state, a.district, a.last_assignment_date AS "lastAssignmentDate",
             a.total_assignments AS "totalAssignments",
             CASE WHEN a.last_assignment_date IS NULL THEN NULL
                  ELSE EXTRACT(DAY FROM NOW() - a.last_assignment_date)::int END AS "daysIdle"
      FROM assayers a
      WHERE a.lifecycle_status = 'ACTIVE'
        AND ${ON_ROSTER_A}
        AND a.is_active = true
        AND (a.last_assignment_date IS NULL OR a.last_assignment_date < NOW() - ($1 || ' days')::interval)${idleScope}
      ORDER BY a.last_assignment_date ASC NULLS FIRST
      LIMIT 50
    `,
      idleParams,
    );

    /**
     * The true population, not the preview.
     *
     * `idle` above is capped at 50 rows on purpose — it backs a detail table, and shipping 542
     * rows into a dashboard payload to answer "how many" is not what that table is for. The bug
     * was reading the tile's own headline number off that same capped array: `idleCount:
     * idle.length` could never read above 50 no matter how large the real population was. Live on
     * this deployment it read 50 while the true count was 542 — HR's "no work in 30 days" tile
     * understating a real retention signal by more than 10x, silently, because nothing about a
     * value pinned at exactly 50 looks wrong on a dashboard. Counted here with the identical
     * predicate and no LIMIT, so the tile and the table can disagree on WHICH 50 people are shown
     * but never on how many there are in total.
     */
    const idleCountsParams: unknown[] = [IDLE_AFTER_DAYS];
    const idleCountsScope = HrWorkforceService.scopeSql('a', idleCountsParams, scope);
    const [idleCounts] = await this.dataSource.query(
      `
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE a.last_assignment_date IS NULL)::int AS "neverAssigned"
      FROM assayers a
      WHERE a.lifecycle_status = 'ACTIVE'
        AND ${ON_ROSTER_A}
        AND a.is_active = true
        AND (a.last_assignment_date IS NULL OR a.last_assignment_date < NOW() - ($1 || ' days')::interval)${idleCountsScope}
    `,
      idleCountsParams,
    );

    const performanceParams: unknown[] = [];
    const performanceScope = HrWorkforceService.scopeSql('assayers', performanceParams, scope);
    const [performance] = await this.dataSource.query(`
      SELECT
        ROUND(AVG(NULLIF(average_rating, 0))::numeric, 2)                       AS "avgRating",
        COUNT(*) FILTER (WHERE average_rating > 0)::int                         AS rated,
        COUNT(*) FILTER (WHERE average_rating > 0 AND average_rating < 3)::int   AS "belowPar",
        SUM(total_assignments)::int                                             AS "totalAssignments",
        SUM(completed_assignments)::int                                         AS "completedAssignments",
        SUM(cancelled_assignments)::int                                         AS "cancelledAssignments",
        SUM(on_time_completions)::int                                           AS "onTimeCompletions"
      FROM assayers
      WHERE ${ON_ROSTER}${performanceScope}
    `, performanceParams);

    const completed = HrWorkforceService.num(performance.completedAssignments);

    // Live per-assayer utilisation: work in flight vs weekly capacity. This is the "who is
    // over-worked / who is idle" read, distinct from the "how old is the last job" idle query
    // above — one is capacity pressure, the other is engagement.
    //
    // This deliberately includes PENDING offers, because a manager looking at someone's plate
    // needs to see work that has been offered but not yet answered. Planning's capacity gate
    // counts only COMMITTED_ASSIGNMENT_STATUSES, so this figure can legitimately read higher
    // than the number planning enforces — the two answer different questions. See
    // modules/assignment/assignment-workload.ts. (This comment previously claimed the numbers
    // agreed with planning; they never did.)
    const utilizationRowsParams: unknown[] = [];
    const utilizationRowsScope = HrWorkforceService.scopeSql('a', utilizationRowsParams, scope);
    const utilizationRows = await this.dataSource.query(`
      SELECT a.id, a.assayer_code AS "assayerCode", a.display_name AS "displayName",
             a.state, a.district, a.max_weekly_workload AS "maxWeeklyWorkload",
             a.last_assignment_date AS "lastAssignmentDate",
             (SELECT COUNT(*) FROM assignments asg
               WHERE asg.assayer_id = a.id AND asg.is_active = true
                 AND asg.status IN (${sqlStatusList(IN_FLIGHT_ASSIGNMENT_STATUSES)})
             ) AS "currentAllocation"
      FROM assayers a
      WHERE a.lifecycle_status = 'ACTIVE' AND ${ON_ROSTER_A}
        AND a.is_active = true${utilizationRowsScope}
      ORDER BY a.display_name ASC
    `, utilizationRowsParams);
    const DEFAULT_WEEKLY = 15;
    const utilization = (utilizationRows ?? []).map((r: any) => {
      const weeklyCapacity = r.maxWeeklyWorkload || DEFAULT_WEEKLY;
      const allocation = HrWorkforceService.num(r.currentAllocation);
      const pct = weeklyCapacity > 0 ? Math.round((allocation / weeklyCapacity) * 100) : 0;
      let posture: 'IDLE' | 'UNDER_UTILIZED' | 'BALANCED' | 'OVER_UTILIZED';
      if (allocation === 0) posture = 'IDLE';
      else if (allocation >= weeklyCapacity) posture = 'OVER_UTILIZED';
      else if (pct >= 60) posture = 'BALANCED';
      else posture = 'UNDER_UTILIZED';
      return {
        id: r.id,
        assayerCode: r.assayerCode,
        displayName: r.displayName,
        state: r.state,
        district: r.district,
        weeklyCapacity,
        currentAllocation: allocation,
        remainingCapacity: Math.max(0, weeklyCapacity - allocation),
        utilizationPercentage: pct,
        posture,
      };
    });
    const count = (p: string) => utilization.filter((u: any) => u.posture === p).length;
    const utilizationCounts = {
      idle: count('IDLE'),
      underUtilized: count('UNDER_UTILIZED'),
      balanced: count('BALANCED'),
      overUtilized: count('OVER_UTILIZED'),
      total: utilization.length,
    };

    return {
      idleAfterDays: IDLE_AFTER_DAYS,
      // Up to 50 of them, for the detail table — see `idleCount` for how many there really are.
      idle,
      idleCount: HrWorkforceService.num(idleCounts?.total),
      // "Never assigned" is a different problem from "went quiet": one is an
      // onboarding failure, the other is a deployment or retention issue.
      neverAssigned: HrWorkforceService.num(idleCounts?.neverAssigned),
      utilization,
      utilizationCounts,
      performance: {
        ...performance,
        onTimeRate: completed
          ? Math.round((HrWorkforceService.num(performance.onTimeCompletions) / completed) * 100)
          : null,
      },
    };
  }

  // ── Attrition ────────────────────────────────────────────────────────────

  private async attrition(scope?: GlobalScope) {
    const totalsParams: unknown[] = [];
    const totalsScope = HrWorkforceService.scopeSql('assayers', totalsParams, scope);
    const [totals] = await this.dataSource.query(`
      SELECT
        -- Everyone who has gone, by status OR by date — the same rule the headcount tile uses.
        -- This counted dates alone, so it read 421 where the "Exited" tile beside it read 446: the
        -- 25 people carrying a departed lifecycle and no leaving date were missing from one number
        -- and present in the other, on the same screen. Whichever a reader trusted, the other was
        -- there to contradict it.
        COUNT(*) FILTER (WHERE ${HAS_LEFT('')} OR exit_date IS NOT NULL OR termination_date IS NOT NULL)::int AS "totalExits",
        -- The windowed counts stay date-only of necessity: a departure with no date cannot be
        -- placed in a 90-day or 12-month window at all. undatedExits is published alongside so the
        -- gap is visible rather than silently absorbed — see averageHeadcount12m below.
        COUNT(*) FILTER (WHERE COALESCE(exit_date, termination_date) > ${BUSINESS_TODAY_SQL} - INTERVAL '90 days')::int  AS "exits90d",
        COUNT(*) FILTER (WHERE COALESCE(exit_date, termination_date) > ${BUSINESS_TODAY_SQL} - INTERVAL '365 days')::int AS "exits12m",
        COUNT(*) FILTER (WHERE ${HAS_LEFT('')} AND exit_date IS NULL AND termination_date IS NULL)::int AS "undatedExits",
        -- Terminations by lifecycle, not by termination_date — that column is NULL on every row
        -- in this table, so this counter read 0 against the 211 people whose lifecycle says
        -- TERMINATED. Its population is everyone still on the books (the WHERE below), which is
        -- deliberately NOT the dated-departures population the recent-exits query below walks:
        -- 199 of those 421 are terminations, and the 12 that separate the two figures are
        -- terminated people carrying no leaving date, who cannot appear in a dated list at all.
        COUNT(*) FILTER (WHERE lifecycle_status = 'TERMINATED')::int AS terminations,
        COUNT(*) FILTER (WHERE joining_date > ${BUSINESS_TODAY_SQL} - INTERVAL '90 days')::int AS "joins90d"
      FROM assayers
      -- Attrition counts people who LEFT, which is a different thing from a record that was
      -- deleted. Resigning or being terminated leaves the row live and dated; deletion clears
      -- is_active. Without this, a deleted profile inflated both the exit count and joins90d.
      WHERE is_active = true${totalsScope}
    `, totalsParams);

    const recentParams: unknown[] = [];
    const recentScope = HrWorkforceService.scopeSql('assayers', recentParams, scope);
    const recent = await this.dataSource.query(`
      SELECT id, assayer_code AS "assayerCode", display_name AS "displayName", state,
             COALESCE(exit_date, termination_date) AS "exitDate",
             -- How somebody left, read from the lifecycle rather than from which date column was
             -- filled in. This tested termination_date IS NOT NULL, and that column is NULL on
             -- every row in the table — the roster importer never had a source for it — so the
             -- CASE could not produce 'TERMINATED' at all and labelled all 421 dated departures
             -- 'Resigned'. Only 106 of them had resigned. 199 were terminated, and three had died:
             -- the screen told HR that a dead colleague resigned, which is the exact thing the
             -- data-integrity scanner's leftWord was rewritten to stop saying.
             CASE
               WHEN upper(coalesce(unavailable_reason, '')) = 'DECEASED' THEN 'DECEASED'
               WHEN lifecycle_status IN ('TERMINATED') THEN 'TERMINATED'
               WHEN lifecycle_status IN ('RESIGNED') THEN 'RESIGNED'
               WHEN termination_date IS NOT NULL THEN 'TERMINATED'
               ELSE 'LEFT'
             END AS mode,
             joining_date AS "joiningDate"
      FROM assayers
      WHERE is_active = true AND (exit_date IS NOT NULL OR termination_date IS NOT NULL)${recentScope}
      ORDER BY COALESCE(exit_date, termination_date) DESC
      LIMIT 20
    `, recentParams);

    const headcountParams: unknown[] = [];
    const headcountScope = HrWorkforceService.scopeSql('assayers', headcountParams, scope);
    const headcount = await this.dataSource.query(`
      SELECT COUNT(*)::int AS active FROM assayers
      WHERE ${ON_ROSTER}${headcountScope}
    `, headcountParams);

    const active = HrWorkforceService.num(headcount[0]?.active);
    const exits12m = HrWorkforceService.num(totals.exits12m);
    /**
     * Everyone the rate is measured against: those still on the roster plus those who left
     * during the window. The standard read — you cannot leave a population you were never in.
     *
     * The 25 people who left with no leaving date are in NEITHER term, and cannot honestly be put
     * in either: `active` correctly excludes them (they have gone) and `exits12m` cannot place an
     * undated departure inside a 12-month window. So they are absent from the denominator rather
     * than wrongly counted, and `undatedExits` is published so the screen can say the rate is
     * computed on a population that excludes them. Quietly folding them into one side or the other
     * would move the published rate by a number nobody could account for afterwards.
     */
    const averageHeadcount12m = active + exits12m;
    return {
      ...totals,
      recent,
      attritionRate12m: active ? Math.round((exits12m / averageHeadcount12m) * 1000) / 10 : 0,
      /**
       * The denominator, sent rather than left for the screen to guess.
       *
       * The tile's hover used `headcount.total` to explain the percentage, and that is a
       * different population — it counts every live record including people who left before the
       * window. So a tile reading 25% was explained underneath by two numbers that work out to
       * 20%, and the figure anyone would repeat in a meeting was the wrong one.
       */
      averageHeadcount12m,
    };
  }

  // ── Traceability ─────────────────────────────────────────────────────────

  /** Who changed what, and when. Every HR action on a person lands here. */
  private async recentActivity(scope?: GlobalScope) {
    const params: unknown[] = [];
    // Scoped to the assayer the activity is ABOUT (`a`), not to `actor` — the person who
    // performed it may be an HR user outside any region, or an assayer in a different one, and
    // this feed answers "what happened to people in my patch", not "who in my patch did something".
    const scopeClause = HrWorkforceService.scopeSql('a', params, scope);
    return this.dataSource.query(`
      SELECT act.id, act.event_type AS "eventType", act.previous_state AS "previousState",
             act.new_state AS "newState",
             -- performed_by_name is written null at event time, so resolve the actor
             -- here: a staff user, or an assayer acting on their own record.
             COALESCE(
               act.performed_by_name,
               NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
               u.username,
               actor.display_name
             ) AS "performedBy",
             act.remarks, act.occurred_at AS "occurredAt",
             a.id AS "assayerId", a.assayer_code AS "assayerCode", a.display_name AS "displayName"
      -- soft-delete-exempt: an activity trail is history, and history does not stop being true
      -- when someone leaves. Filtering deleted assayers out here would silently rewrite the
      -- record of who did what — the same reason a CANCELLED assignment stays visible rather
      -- than being flagged inactive.
      FROM assayer_activities act
      JOIN assayers a ON a.id = act.assayer_id
      LEFT JOIN users u ON act.performed_by::text ~ '^[0-9a-fA-F-]{36}$' AND u.id = act.performed_by::uuid
      -- soft-delete-exempt: the actor is here to name who performed the act, and an act does
      -- not become anonymous because the person who did it has since left.
      LEFT JOIN assayers actor ON act.performed_by::text ~ '^[0-9a-fA-F-]{36}$' AND actor.id = act.performed_by::uuid
      WHERE TRUE${scopeClause}
      ORDER BY act.occurred_at DESC
      LIMIT 40
    `, params);
  }

  // ── Roster segments ──────────────────────────────────────────────────────

  /**
   * Every count the roster's segment chips show, from the one place that can see the whole
   * scoped population.
   *
   * `ROSTER_SEGMENTS` in the web app's `roster-filters.ts` used to be counted client-side, over
   * whichever page of up to 1,000 rows had actually loaded. On a roster bigger than that window —
   * which is the normal case, not an edge one — "Cannot be paid: 47" meant 47 among the rows on
   * screen, and the number changed as somebody scrolled or paged, without the underlying set of
   * people changing at all. `COUNT(DISTINCT a.id)` here runs over the full scoped population every
   * time, so the chip's number and this one can never disagree about who is being counted.
   *
   * The key names are `ROSTER_SEGMENTS[].key` verbatim — this is the contract the frontend reads —
   * and each predicate is that segment's `match` function translated into SQL, checked against it
   * line by line rather than re-derived from scratch:
   *
   *  - `all`, `active`, `to-verify`, `background-due` read the lifecycle status alone, exactly as
   *    `ROSTER_SEGMENTS` does, with NO `stillWorkable`/`ON_ROSTER_A` gate — a departed person still
   *    carrying e.g. `DOCUMENT_VERIFICATION` on their way out is still counted here, because the
   *    chip they back does not ask whether they stayed.
   *  - `onboarding` is the same four-stage membership test as `isOnboardingStage`, ALSO ungated.
   *    This is deliberately a different number from the "onboarding" key inside `headcount()`'s
   *    totals, which DOES gate on `ON_ROSTER` because that panel's active/onboarding/exited
   *    buckets must partition the roster without anybody counted twice or left out. Two panels
   *    asking a different question share one English word; each mirrors its OWN consumer.
   *  - `ready` is `isReadyToActivate`: the state machine's only edge from an onboarding stage to
   *    ACTIVE is `TRAINING → ACTIVE` (see `ASSAYER_LIFECYCLE_TRANSITIONS` in `@fapoms/shared`), so
   *    "the next legal step is ACTIVE and isOnboardingStage" collapses to `lifecycle_status =
   *    'TRAINING'` — named directly rather than re-deriving the transition table in SQL.
   *  - `incomplete`/`unpayable` reuse `anyCriticalMissingSql`/`anyPayoutBlockingMissingSql` (the
   *    same fragments `recordCompliance()` uses), gated on `ON_ROSTER_A` for `stillWorkable`.
   *  - `unprofiled` mirrors `!a.skills || a.skills.length === 0`: the roster's `skills` field is
   *    hydrated from `workforce_attributes` rows of `type = 'SKILL'`
   *    (`AssayerService.hydrateWorkforceAttributes`), never a column on `assayers` itself, so "no
   *    skills" is a NOT EXISTS against that table — the same population `capability()`'s
   *    `withSkill` counts.
   *  - `exited` is `!stillWorkable(a)`, i.e. `NOT (ON_ROSTER_A)` — and since the outer WHERE
   *    already restricts to `is_active = true`, that negation reduces to exactly the departed-OR-
   *    dated predicate `headcount()`'s own `exited` counter uses.
   *  - `someone-else` reuses `workByOthersCount`'s predicate (`ON_ROSTER_A AND
   *    a.work_done_by_someone_else = true`) rather than a second copy of it.
   *  - `lapsed` is EXISTS a `workforce_attributes` row of `type = 'CERTIFICATION'` whose
   *    `expiry_date` is before today — see `certificate-lapsed-parity.spec.ts` for this pinned
   *    against fixtures, and the note on `bucketsFor` in `expiries()` for the untyped-row bug this
   *    same type filter fixes there.
   *
   * One round trip, one row: every segment is a `FILTER` on one aggregate query over `assayers a`,
   * so the twelve counts can never land at slightly different moments relative to a concurrent
   * write the way twelve separate queries could.
   */
  private async segments(scope?: GlobalScope): Promise<Record<string, number>> {
    const anyMissing = HrWorkforceService.anyCriticalMissingSql();
    const anyPayoutMissing = HrWorkforceService.anyPayoutBlockingMissingSql();
    const params: unknown[] = [];
    const scopeClause = HrWorkforceService.scopeSql('a', params, scope);

    const [row] = await this.dataSource.query(`
      SELECT
        COUNT(DISTINCT a.id)::int AS "all",
        COUNT(DISTINCT a.id) FILTER (WHERE a.lifecycle_status = 'ACTIVE')::int AS "active",
        COUNT(DISTINCT a.id) FILTER (
          WHERE a.lifecycle_status IN ('INVITED','DOCUMENT_VERIFICATION','BACKGROUND_VERIFICATION','TRAINING')
        )::int AS "onboarding",
        COUNT(DISTINCT a.id) FILTER (WHERE a.lifecycle_status = 'DOCUMENT_VERIFICATION')::int AS "to-verify",
        COUNT(DISTINCT a.id) FILTER (WHERE a.lifecycle_status = 'BACKGROUND_VERIFICATION')::int AS "background-due",
        COUNT(DISTINCT a.id) FILTER (WHERE a.lifecycle_status = 'TRAINING' AND NOT (${anyMissing}))::int AS "ready",
        COUNT(DISTINCT a.id) FILTER (WHERE ${ON_ROSTER_A} AND (${anyMissing}))::int AS "incomplete",
        COUNT(DISTINCT a.id) FILTER (WHERE ${ON_ROSTER_A} AND (${anyPayoutMissing}))::int AS "unpayable",
        COUNT(DISTINCT a.id) FILTER (
          WHERE ${ON_ROSTER_A} AND NOT EXISTS (
            SELECT 1 FROM workforce_attributes w
             WHERE w.assayer_id = a.id AND w.is_active = true AND w.type = 'SKILL'
          )
        )::int AS "unprofiled",
        COUNT(DISTINCT a.id) FILTER (WHERE NOT (${ON_ROSTER_A}))::int AS "exited",
        COUNT(DISTINCT a.id) FILTER (WHERE ${ON_ROSTER_A} AND a.work_done_by_someone_else = true)::int AS "someone-else",
        COUNT(DISTINCT a.id) FILTER (
          WHERE ${ON_ROSTER_A} AND EXISTS (
            SELECT 1 FROM workforce_attributes w
             WHERE w.assayer_id = a.id AND w.is_active = true AND w.type = 'CERTIFICATION'
               AND w.expiry_date IS NOT NULL AND w.expiry_date::date < ${BUSINESS_TODAY_SQL}
          )
        )::int AS "lapsed"
      FROM assayers a
      WHERE a.is_active = true${scopeClause}
    `, params);

    const keys = [
      'all', 'active', 'onboarding', 'to-verify', 'background-due', 'ready', 'incomplete',
      'unpayable', 'unprofiled', 'exited', 'someone-else', 'lapsed',
    ];
    const out: Record<string, number> = {};
    for (const key of keys) out[key] = HrWorkforceService.num(row?.[key]);
    return out;
  }

  // ── What to do about it ──────────────────────────────────────────────────

  /**
   * Turns the panels above into a ranked worklist. Without this the dashboard
   * reports nine facts and leaves the prioritising to the reader, which is the
   * complaint the existing page attracted.
   */
  private deriveActions(parts: any): any[] {
    const actions: any[] = [];

    // First, and on its own severity: this is not a gap in a record, it is somebody unvetted
    // walking into a bank vault under a code we issued.
    const workByOthers = parts.compliance?.workByOthersCount ?? 0;
    if (workByOthers > 0) {
      actions.push({
        severity: 'critical',
        area: 'Vetting',
        title: `${workByOthers} ${workByOthers === 1 ? 'appraiser has' : 'appraisers have'} work attended by somebody else`,
        detail: 'A member of staff, a relative or a friend is attending under their code. '
          + 'That person is not vetted by us and not empanelled by the client.',
        link: '/hr/roster?segment=someone-else',
      });
    }

    const criticalGaps = (parts.compliance?.fields ?? []).filter((f: any) => f.critical && f.missing > 0);
    for (const gap of criticalGaps) {
      actions.push({
        severity: gap.pct === 0 ? 'critical' : 'high',
        area: 'Record',
        title: `${gap.missing} of ${parts.compliance.roster} missing ${gap.label}`,
        detail: `Blocks ${gap.blocks.toLowerCase()}.`,
        link: '/hr/roster?segment=incomplete',
      });
    }

    if (parts.pipeline?.stalled?.length) {
      actions.push({
        severity: 'high',
        area: 'Onboarding',
        title: `${parts.pipeline.stalled.length} candidate(s) stalled over ${STALLED_AFTER_DAYS} days`,
        detail: 'Onboarding has not advanced; they cannot be assigned work until active.',
        link: '/hr/roster?segment=onboarding',
      });
    }

    const expired = (parts.expiries?.certifications?.expired ?? 0) + (parts.expiries?.documents?.expired ?? 0);
    if (expired > 0) {
      actions.push({
        severity: 'critical',
        area: 'Compliance',
        title: `${expired} credential(s) already expired`,
        detail: 'Assayers holding expired credentials should not be deployed.',
        link: '/hr/roster?segment=lapsed',
      });
    }
    const soon = (parts.expiries?.certifications?.within30 ?? 0) + (parts.expiries?.documents?.within30 ?? 0);
    if (soon > 0) {
      actions.push({
        severity: 'medium',
        area: 'Compliance',
        title: `${soon} credential(s) expire within 30 days`,
        detail: 'Start renewals now to avoid losing deployable capacity.',
        link: '/hr/roster?segment=lapsed',
      });
    }

    for (const t of parts.deployment?.hiringNeeded ?? []) {
      actions.push({
        severity: t.posture === 'NO_COVERAGE' ? 'critical' : 'medium',
        area: 'Staffing',
        title:
          t.posture === 'NO_COVERAGE'
            ? `${t.state}: ${t.branches} branches, no active assayer`
            : `${t.state}: ${t.branchesPerAssayer} branches per assayer`,
        detail: t.posture === 'NO_COVERAGE' ? 'Work here cannot be staffed at all.' : 'Team is stretched; consider hiring.',
        link: '/hr/where?view=coverage',
      });
    }

    if (parts.utilisation?.neverAssigned > 0) {
      actions.push({
        severity: 'medium',
        area: 'Utilisation',
        title: `${parts.utilisation.neverAssigned} active assayer(s) have never been assigned`,
        detail: 'Onboarded but never deployed — a retention risk and a wasted hire.',
        link: '/hr/where?view=workload',
      });
    }

    const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return actions.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 12);
  }
}
