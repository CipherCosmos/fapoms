/**
 * FAPOMS — the appraiser-roster import as a background job (`ROSTER_IMPORT`).
 *
 * The upload route (`POST /assayers/roster/import`) stores the workbook and answers 202; this runs
 * it. Every import is rehearsed first: the rehearsal performs the entire import inside a
 * transaction and rolls it back, then waits in AWAITING_REVIEW with what it WOULD do. The operator
 * commits it (`POST /jobs/:id/commit`), which starts a child job over the same stored file, and
 * that one writes. Both are rows in `background_jobs`, so a refreshed page — or the Jobs tray —
 * finds the rehearsal still waiting for its answer, or the import still going.
 *
 * Why the definition says what it says:
 *
 *  - `idempotent: true` — the rows are written in one transaction keyed on appraiser code (a death
 *    mid-write rolls all of it back); references, documents, empanelments and review issues are
 *    matched before they are written; lifecycle moves are queued only for people not already at the
 *    target. The importer was built to be re-run on a corrected file, and a restart is exactly
 *    that. A rehearsal writes nothing at all.
 *  - `exclusive: 'kind'` — one roster run at a time, system-wide, rehearsals included. A rehearsal
 *    beside a real import would describe a roster the import is halfway through changing, and two
 *    real imports of overlapping people would race each other's inserts. This used to be the
 *    single concurrency-1 `roster-import-jobs` queue.
 *  - `start` — the Jobs tray's "Go ahead" and the page's confirm both commit through the generic
 *    `POST /jobs/:id/commit`, which requires a start policy. It names the route's permission; the
 *    route's ROLE whitelist (ADMIN / OPERATIONS) cannot be expressed there, so `prepare` enforces
 *    it against the principal — for a fresh start through `POST /jobs` and for a commit alike.
 */

import { ForbiddenException, Injectable, OnModuleInit } from '@nestjs/common';
import { expandRoles, SystemRole } from '@fapoms/shared';
import { BackgroundJobRegistry } from '../../infrastructure/background-jobs/background-job.registry';
import {
  awaitReview,
  succeed,
  type BackgroundJobDefinition,
  type PrepareContext,
  type PrepareOutcome,
  type RunContext,
  type RunOutcome,
} from '../../infrastructure/background-jobs/background-jobs.contract';
import type { JobActor } from '../../infrastructure/queue/job-actor';
import { RosterImportService, type RosterImportSummary } from './roster-import.service';

export const ROSTER_IMPORT_KIND = 'ROSTER_IMPORT' as const;

/** The roster is one national list: every roster job shares this scope. */
export const ROSTER_IMPORT_SCOPE = { type: 'ROSTER', id: null } as const;

/** The permission `POST /assayers/roster/import` requires, and so what committing one requires. */
export const ROSTER_IMPORT_PERMISSION = 'assayer:create:organization';

/** The roles `POST /assayers/roster/import` admits (`@Roles`), checked again for every start. */
export const ROSTER_IMPORT_ROLES: readonly string[] = [SystemRole.ADMIN, SystemRole.OPERATIONS];

/** A type, not an interface, so it is assignable to the foundation's `Record<string, unknown>` params. */
export type RosterImportJobParams = {
  /** A rehearsal: everything is tried and rolled back. Only an explicit `true` rehearses. */
  dryRun?: boolean;
  /** "Sheet wins": a disagreeing stored value is replaced rather than filed for review. */
  overwrite?: boolean;
  /** A sheet to read, for a workbook whose roster the scored search would not pick. */
  sheetName?: string | null;
};

/** Notes are sentences about the run; a pathological file cannot make the result large. */
const MAX_NOTES = 50;
const MAX_NOTE_LENGTH = 600;

/**
 * Whether this run is the rehearsal.
 *
 * A job with a parent is the COMMIT of a reviewed rehearsal, and a commit is the real run by
 * definition, whatever params it inherited: `commitReviewed` merges the rehearsal's own
 * `{ dryRun: true }` into the child, so a commit that did not restate `dryRun: false` (the Jobs
 * tray's "Go ahead" sends no params) would otherwise rehearse a second time and the operator's
 * confirmation would land nothing.
 */
export function isRehearsal(job: { parentJobId: string | null }, params: RosterImportJobParams): boolean {
  if (job.parentJobId) return false;
  return params?.dryRun === true;
}

/** The route's `@Roles(ADMIN, OPERATIONS)`, with the same hierarchy (DEVELOPER implies ADMIN). */
export function assertMayRunRosterImport(actor: Pick<JobActor, 'roleNames'>): void {
  const held = expandRoles(actor.roleNames ?? []);
  if (!ROSTER_IMPORT_ROLES.some((role) => held.includes(role))) {
    throw new ForbiddenException('Insufficient role permissions');
  }
}

/** The one sentence the Jobs tray and the page show. */
export function describeRosterImport(summary: RosterImportSummary): string {
  const n = (v: number) => v.toLocaleString('en-IN');
  const tail = [
    summary.skipped ? `${n(summary.skipped)} skipped` : '',
    summary.issues ? `${n(summary.issues)} cell(s) for review` : '',
  ].filter(Boolean).join(', ');
  const body = summary.dryRun
    ? `Checked ${n(summary.rowsRead)} row(s): importing would add ${n(summary.created)} and update ${n(summary.updated)} appraisers`
    : `Roster imported — ${n(summary.created)} new, ${n(summary.updated)} updated from ${n(summary.rowsRead)} row(s)`;
  return `${body}${tail ? `; ${tail}` : ''}.${summary.dryRun ? ' Nothing was saved.' : ''}`;
}

@Injectable()
export class RosterImportJob implements OnModuleInit {
  constructor(
    private readonly registry: BackgroundJobRegistry,
    private readonly rosterImport: RosterImportService,
  ) {}

  onModuleInit(): void {
    this.registry.register<RosterImportJobParams>(this.definition());
  }

  definition(): BackgroundJobDefinition<RosterImportJobParams> {
    return {
      kind: ROSTER_IMPORT_KIND,
      input: 'required',
      idempotent: true,
      exclusive: 'kind',
      start: { permissions: [ROSTER_IMPORT_PERMISSION] },
      prepare: (ctx) => this.prepare(ctx),
      run: (ctx) => this.run(ctx),
    };
  }

  /**
   * In the request, before anything is stored. Refuses the wrong role, and the wrong FILE — an
   * unreadable workbook, or the branch list uploaded to the roster screen — with the same
   * immediate 400 the upload always gave, rather than a cheerful 202 and a failure to go looking
   * for. `inspectSheet` opens no transaction and issues no query.
   */
  async prepare(ctx: PrepareContext<RosterImportJobParams>): Promise<PrepareOutcome> {
    assertMayRunRosterImport(ctx.actor);
    const rehearsal = !ctx.parent && ctx.params?.dryRun === true;

    if (!ctx.file) {
      // A commit: the rehearsal already read this file and counted its rows.
      const rows = ctx.parent?.result?.counts?.rowsRead ?? ctx.parent?.progress?.total ?? undefined;
      const from = ctx.parent?.inputFileName ? ` from ${ctx.parent.inputFileName}` : '';
      return {
        title: rows !== undefined && rows !== null
          ? `Import ${rows.toLocaleString('en-IN')} roster row(s)${from}`
          : `Import the roster${from}`,
        total: typeof rows === 'number' ? rows : undefined,
        stage: 'Waiting to start',
      };
    }

    const inspection = this.rosterImport.inspectSheet(await ctx.file.read(), ctx.params?.sheetName || undefined);
    const rows = inspection.rowsRead.toLocaleString('en-IN');
    return {
      title: rehearsal
        ? `Check ${rows} roster row(s) from ${ctx.file.originalName}`
        : `Import ${rows} roster row(s) from ${ctx.file.originalName}`,
      total: inspection.rowsRead,
      stage: 'Waiting to start',
    };
  }

  /** In the worker, as the person who started it. */
  async run(ctx: RunContext<RosterImportJobParams>): Promise<RunOutcome> {
    const dryRun = isRehearsal(ctx.job, ctx.params);
    // Before the transaction opens: a job cancelled while it waited never starts.
    await ctx.throwIfCancelled();
    await ctx.stage('Reading the workbook');
    const file = await ctx.readInput();

    const summary = await this.rosterImport.importAssayerSheet(file, ctx.actor.userId, {
      dryRun,
      overwrite: ctx.params?.overwrite === true,
      sheetName: ctx.params?.sheetName || undefined,
      fileName: ctx.job.inputFileName ?? undefined,
      onProgress: (processed, total, stage) => ctx.progress(processed, total, stage),
      // Between rows, inside the one transaction: a stop rolls every row back.
      checkpoint: () => ctx.throwIfCancelled(),
    });

    const details: RosterImportSummary = {
      ...summary,
      notes: summary.notes.slice(0, MAX_NOTES).map((note) => note.slice(0, MAX_NOTE_LENGTH)),
    };
    const result = {
      summary: describeRosterImport(summary),
      counts: {
        rowsRead: summary.rowsRead,
        created: summary.created,
        updated: summary.updated,
        skipped: summary.skipped,
        issues: summary.issues,
        references: summary.references,
        onboardingDocuments: summary.onboardingDocuments,
        backgroundChecks: summary.backgroundChecks,
        empanelments: summary.empanelments,
      },
      details,
    };
    /**
     * Returned, not thrown, when rows failed: a roster with 12 unusable rows out of 700 is a
     * successful import with the per-row reasons in the import-issues queue, not a failed job.
     */
    return dryRun ? awaitReview(result) : succeed(result);
  }
}
