/**
 * FAPOMS — `BRANCH_IMPORT`: a branch list, rehearsed, reviewed by a person, then committed, all in
 * the background.
 *
 * ## The life of one upload
 *
 *  1. `POST /branches/import/:clientId` (Branches page) or `POST /projects/:id/branches/import`
 *     (a project) stores the file and answers 202 at once. `prepare` has already refused a wrong
 *     file, a missing client or project, and any row reaching outside the uploader's regions.
 *  2. The worker REHEARSES (`phase: 'rehearse'`): reads, matches, looks up, places — writes no
 *     branch — stores the review as `branch-review.json` and waits (AWAITING_REVIEW). A refreshed
 *     page reads the job back from `/jobs` and offers the review again.
 *  3. The person commits from the review (`.../jobs/:jobId/commit`, or `.../import/:jobId/commit` on
 *     a project) with their DECISIONS. That starts a child job (`phase: 'commit'`, `parentJobId` =
 *     the rehearsal) which applies them to the stored review and writes in chunks.
 *  4. A job that failed can be retried (`.../retry`) over the same stored file and decisions.
 *
 * ## Why this kind is only started from its own routes
 *
 * It declares no `start` policy, so the generic `POST /jobs` and `POST /jobs/:id/commit` refuse it.
 * Its routes carry the same `@Roles(ADMIN, OPERATIONS)` whitelist and permissions the old import
 * routes did; the generic door checks permissions only, and would have widened who may write the
 * branch master to any custom role holding one permission.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  applyBranchDecisions,
  BACKGROUND_JOB_KIND_INFO,
  resolveRegion,
  type BackgroundJobAccepted,
  type BackgroundJobSummary,
  type BranchImportCommitDetails,
  type BranchImportDecisions,
  type BranchImportRehearsalDetails,
  type BranchReviewReport,
} from '@fapoms/shared';
import { BackgroundJobRegistry } from '../../../infrastructure/background-jobs/background-job.registry';
import {
  BackgroundJobsService,
  type IncomingJobFile,
  type JobReader,
} from '../../../infrastructure/background-jobs/background-jobs.service';
import {
  awaitReview,
  BackgroundJobCancelledError,
  succeed,
  type PrepareContext,
  type PrepareOutcome,
  type RunContext,
  type RunOutcome,
} from '../../../infrastructure/background-jobs/background-jobs.contract';
import type { JobActor } from '../../../infrastructure/queue/job-actor';
import { RegionGuardService } from '../../../infrastructure/scope/region-guard.service';
import { buildWorkbook, EXCEL_MIME } from '../../reports/excel-export';
import { GeoPrecisionService } from '../../geo/geo-precision.service';
import { isPlausibleIndianCoord } from '../../geo/coordinate-resolution';
import { geocodeIndiaRobust, isGoogleGeocodingConfigured } from '../../geo/india-geocoder';
import { lookupBranchByIfscOrSol } from '../../geo/ifsc-lookup.helper';
import { lookupPincode } from '../../geo/pincode-lookup.helper';
import { branchSheetRegions, isBlankBranchRow, parseBranchSheet, readBranchRow } from './branch-sheet';
import { rehearseBranchImport } from './branch-import.rehearsal';
import { commitBranchImport, type CommitOutcome } from './branch-import.commit';
import { BranchImportStore } from './branch-import.store';
import type {
  BranchImportHooks,
  BranchImportLookups,
  BranchImportParams,
  BranchImportScopeType,
  BranchImportTarget,
} from './branch-import.types';

export const BRANCH_IMPORT_KIND = 'BRANCH_IMPORT' as const;
/** One name, in shared: the Jobs tray recognises this file as the page's review, not a report. */
export const REVIEW_FILE_NAME = BACKGROUND_JOB_KIND_INFO.BRANCH_IMPORT.reviewFileName!;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const n = (v: number) => v.toLocaleString('en-IN');

/** The directories, as the running server asks them. Tests pass their own. */
export function liveBranchImportLookups(): BranchImportLookups {
  return {
    ifsc: (bank, code) => lookupBranchByIfscOrSol(bank, code),
    pincode: (pin) => lookupPincode(pin),
    geocode: async (request) => {
      // The fast tiers only (`precise: false`): the precision worker upgrades coarse rows afterwards.
      const fix = await geocodeIndiaRobust(request.address, request.name, request.district, request.state, request.pincode, {
        precise: false,
        name: request.name,
      });
      return {
        lat: fix.lat,
        lng: fix.lng,
        geoSource: fix.source,
        geoAccuracyMeters: Math.round(fix.accuracyMeters),
        geoMatchedName: fix.matchedName ?? null,
      };
    },
    geocodeUsesAddress: isGoogleGeocodingConfigured(),
  };
}

/** The shape of `decisions` a commit may carry. Anything else is a 400, before anything is queued. */
export function validateDecisions(raw: unknown): BranchImportDecisions {
  const bad = (why: string) => new BadRequestException(`The review could not be committed: ${why}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('no decisions were sent.');
  const d = raw as Record<string, unknown>;
  if (d.mode !== 'all_valid' && d.mode !== 'ready_only') throw bad('choose whether to commit every valid row or only the ready ones.');
  const excluded = d.excluded ?? [];
  if (!Array.isArray(excluded) || excluded.some((x) => !Number.isInteger(x))) throw bad('the removed rows were not a list of row numbers.');
  const edits = d.edits ?? {};
  if (!edits || typeof edits !== 'object' || Array.isArray(edits)) throw bad('the edits were not understood.');
  for (const [row, edit] of Object.entries(edits as Record<string, unknown>)) {
    if (!/^\d+$/.test(row) || !edit || typeof edit !== 'object' || Array.isArray(edit)) throw bad(`the edit for row ${row} was not understood.`);
  }
  return { mode: d.mode, excluded: excluded as number[], edits: edits as BranchImportDecisions['edits'] };
}

@Injectable()
export class BranchImportJob implements OnModuleInit {
  private readonly logger = new Logger(BranchImportJob.name);
  /** Swappable in tests; the live directories otherwise. */
  lookups: BranchImportLookups = liveBranchImportLookups();

  constructor(
    private readonly registry: BackgroundJobRegistry,
    private readonly jobs: BackgroundJobsService,
    private readonly store: BranchImportStore,
    private readonly regionGuard: RegionGuardService,
    private readonly geoPrecision: GeoPrecisionService,
  ) {}

  onModuleInit(): void {
    this.registry.register<BranchImportParams>({
      kind: BRANCH_IMPORT_KIND,
      input: 'required',
      // A rehearsal writes nothing; a commit upserts by client + SOL ID and links only what is
      // missing, so a run restarted from the top converges on the same rows.
      idempotent: true,
      // One import per client or project at a time: two over the same rows would race.
      exclusive: 'scope',
      prepare: (ctx) => this.prepare(ctx),
      run: (ctx) => this.run(ctx),
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // The routes' half
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /** Upload → a rehearsal, answered as soon as the file is stored. */
  start(input: {
    scopeType: BranchImportScopeType;
    scopeId: string;
    actor: JobActor;
    regions: string[] | null;
    file: IncomingJobFile | null;
  }): Promise<BackgroundJobAccepted> {
    if (!input.file) throw new BadRequestException('No file was uploaded. Choose a file and try again.');
    return this.jobs.create({
      kind: BRANCH_IMPORT_KIND,
      actor: input.actor,
      regions: input.regions,
      scope: { type: input.scopeType, id: input.scopeId },
      params: { phase: 'rehearse' },
      file: input.file,
    });
  }

  /** The reviewed decisions → a commit job over the stored rehearsal. */
  async commit(
    reader: JobReader,
    actor: JobActor,
    scopeType: BranchImportScopeType,
    scopeId: string,
    jobId: string,
    decisions: unknown,
  ): Promise<BackgroundJobAccepted> {
    const rehearsal = await this.ownJob(reader, scopeType, scopeId, jobId);
    if ((rehearsal.params as BranchImportParams | null)?.phase !== 'rehearse') {
      throw new BadRequestException('Only a rehearsal can be committed.');
    }
    return this.jobs.commitReviewed(reader, actor, jobId, { phase: 'commit', decisions: validateDecisions(decisions) });
  }

  /** Run a failed or cancelled job again, over the same stored file (and, for a commit, the same decisions). */
  async retry(
    reader: JobReader,
    actor: JobActor,
    scopeType: BranchImportScopeType,
    scopeId: string,
    jobId: string,
  ): Promise<BackgroundJobAccepted> {
    const row = await this.ownJob(reader, scopeType, scopeId, jobId);
    if (row.status !== 'FAILED' && row.status !== 'CANCELLED') {
      throw new ConflictException('Only a job that failed or was cancelled can be retried.');
    }
    const params = (row.params ?? {}) as unknown as BranchImportParams;
    const phase = params.phase === 'commit' ? 'commit' : 'rehearse';
    return this.jobs.create({
      kind: BRANCH_IMPORT_KIND,
      actor,
      regions: reader.regions,
      scope: { type: scopeType, id: scopeId },
      params: phase === 'commit' ? { phase, decisions: params.decisions } : { phase },
      // A rehearsal is retried from the failed one (whose file it reuses); a commit from its rehearsal.
      parentJobId: phase === 'commit' ? row.parentJobId : row.id,
    });
  }

  private async ownJob(reader: JobReader, scopeType: string, scopeId: string, jobId: string) {
    const row = await this.jobs.visibleRow(reader, jobId);
    if (row.kind !== BRANCH_IMPORT_KIND || row.scopeType !== scopeType || row.scopeId !== scopeId) {
      // The same answer as a job that does not exist: an id is never confirmed across scopes.
      throw new NotFoundException('No such job. Jobs are kept for 30 days and are only visible to the person who started them.');
    }
    return row;
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // prepare — in the request
  // ───────────────────────────────────────────────────────────────────────────────────────────

  async prepare(ctx: PrepareContext<BranchImportParams>): Promise<PrepareOutcome> {
    const scopeType = ctx.scope?.type;
    const scopeId = ctx.scope?.id ?? '';
    if ((scopeType !== 'CLIENT' && scopeType !== 'PROJECT') || !UUID.test(scopeId)) {
      throw new BadRequestException('A branch import belongs to a client or a project.');
    }
    const target = await this.store.resolveTarget(scopeType, scopeId);
    const phase = ctx.params?.phase;

    if (phase === 'rehearse') {
      if (ctx.parent) {
        // A retry: the failed rehearsal's own file, checked again in the worker (see `run`).
        this.assertSameScopeParent(ctx.parent, scopeType, scopeId, ['FAILED', 'CANCELLED']);
        return { title: ctx.parent.title, stage: 'Waiting to start' };
      }
      if (!ctx.file) throw new BadRequestException('No file was uploaded. Choose a file and try again.');
      const sheet = parseBranchSheet(await ctx.file.read());
      const { regions, solsWithoutState } = branchSheetRegions(sheet);
      const sols = sheet.rows.map((r) => readBranchRow(r).solId).filter(Boolean);
      // Where the rows would land, and where the branches they name already are — for THIS client.
      // Both are the uploader's to touch or nothing is: the review shows every matched branch's
      // address and pin, so a branch in another region is not theirs to see either.
      for (const r of await this.store.regionsOfKnownBranches(target.clientId, [...sols, ...solsWithoutState])) regions.add(r);
      this.assertRegions(regions, ctx.regions);
      const rows = sheet.rows.filter((r) => !isBlankBranchRow(readBranchRow(r))).length;
      return { title: `${n(rows)} branches for ${target.label}`, total: rows, stage: 'Waiting to start' };
    }

    if (phase === 'commit') {
      if (!ctx.parent) throw new BadRequestException('A commit needs the review it was made from.');
      this.assertSameScopeParent(ctx.parent, scopeType, scopeId, ['AWAITING_REVIEW', 'SUCCEEDED']);
      if ((ctx.parent.result?.details as { phase?: string } | undefined)?.phase !== 'rehearse' || !ctx.parent.hasResultFile) {
        throw new BadRequestException('That job is not a finished branch review.');
      }
      const decisions = validateDecisions(ctx.params.decisions);
      const report = await this.readReview(readerFor(ctx.actor, ctx.regions), ctx.parent.id);
      const applied = applyBranchDecisions(report.rows, decisions, isPlausibleIndianCoord);
      const regions = new Set<string>();
      for (const row of applied.rows) {
        const region = resolveRegion(row.state);
        if (region) regions.add(region);
      }
      for (const r of await this.store.regionsOfKnownBranches(target.clientId, applied.rows.map((row) => row.solId))) regions.add(r);
      this.assertRegions(regions, ctx.regions);
      return { title: `${n(applied.rows.length)} reviewed branches for ${target.label}`, total: applied.rows.length, stage: 'Waiting to start' };
    }

    throw new BadRequestException('A branch import is either a rehearsal or a commit.');
  }

  private assertSameScopeParent(parent: BackgroundJobSummary, scopeType: string, scopeId: string, statuses: string[]): void {
    if (parent.kind !== BRANCH_IMPORT_KIND || parent.scopeType !== scopeType || parent.scopeId !== scopeId) {
      throw new BadRequestException('That job belongs to another import.');
    }
    if (!statuses.includes(parent.status)) {
      throw new ConflictException('That job cannot be used for this any more.');
    }
  }

  /** The ceiling on every region the rows touch — the one rule for the whole file. */
  private assertRegions(regions: Iterable<string>, allowed: string[] | null): void {
    for (const region of regions) this.regionGuard.assertRegionSettable(region, { regions: (allowed ?? undefined) as any });
  }

  private async readReview(reader: JobReader, rehearsalId: string): Promise<BranchReviewReport> {
    const file = await this.jobs.openResult(reader, rehearsalId);
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const report = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BranchReviewReport;
    if (report?.version !== 1 || !Array.isArray(report.rows)) {
      throw new BadRequestException('The stored review could not be read. Upload the file again.');
    }
    return report;
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // run — in the worker
  // ───────────────────────────────────────────────────────────────────────────────────────────

  async run(ctx: RunContext<BranchImportParams>): Promise<RunOutcome> {
    const scopeType = ctx.scope?.type as BranchImportScopeType;
    const target = await this.store.resolveTarget(scopeType, ctx.scope!.id!);
    const hooks: BranchImportHooks & { isCancelRequested(): Promise<boolean> } = {
      progress: (processed, total, stage, message) => ctx.progress(processed, total, stage, message),
      throwIfCancelled: () => ctx.throwIfCancelled(),
      isCancelRequested: () => ctx.isCancelRequested(),
    };
    return ctx.params?.phase === 'commit'
      ? this.runCommit(ctx, target, hooks)
      : this.runRehearsal(ctx, target, hooks);
  }

  private async runRehearsal(ctx: RunContext<BranchImportParams>, target: BranchImportTarget, hooks: BranchImportHooks): Promise<RunOutcome> {
    await ctx.stage('Reading the file');
    const sheet = parseBranchSheet(await ctx.readInput());
    const started = Date.now();
    const outcome = await rehearseBranchImport(sheet, target, this.store.readsFor(target), this.lookups, hooks);

    // The backstop: the request checked the regions; the rows are checked again where they are read.
    const outside = [...outcome.regions].filter((r) => ctx.regions && !ctx.regions.includes(r));
    if (outside.length > 0) {
      throw new ForbiddenException(`This file names branches in ${outside.join(', ')}, which your account is not assigned to.`);
    }

    await ctx.attachReport(REVIEW_FILE_NAME, Buffer.from(JSON.stringify(outcome.report)), 'application/json');
    const s = outcome.report.summary;
    this.logger.log(
      `Branch rehearsal ${ctx.job.id}: ${s.totalRows} rows in ${Math.round((Date.now() - started) / 1000)}s ` +
        `(ifsc=${outcome.lookups.ifsc} pincode=${outcome.lookups.pincode} geocode=${outcome.lookups.geocode} places=${outcome.lookups.geography})`,
    );
    const details: BranchImportRehearsalDetails = {
      phase: 'rehearse',
      summary: s,
      skippedBeforeReview: outcome.report.skipped.length,
      notes: outcome.report.notes.slice(0, 10),
    };
    return awaitReview({
      summary:
        `Ready to review: ${n(s.totalRows)} rows — ${n(s.existingInMaster)} already known, ${n(s.newBranches)} new` +
        (s.needsDetailsCount ? `, ${n(s.needsDetailsCount)} missing details` : '') +
        (outcome.report.skipped.length ? `; ${n(outcome.report.skipped.length)} set aside` : '') + '.',
      counts: { ...s, skipped: outcome.report.skipped.length },
      details,
    });
  }

  private async runCommit(
    ctx: RunContext<BranchImportParams>,
    target: BranchImportTarget,
    hooks: BranchImportHooks & { isCancelRequested(): Promise<boolean> },
  ): Promise<RunOutcome> {
    if (!ctx.job.parentJobId) throw new Error('This commit has lost the review it was made from. Upload the file again.');
    await ctx.stage('Reading the review');
    const report = await this.readReview(readerFor(ctx.actor, ctx.regions), ctx.job.parentJobId);
    const decisions = validateDecisions(ctx.params.decisions);

    const started = Date.now();
    const outcome = await commitBranchImport(
      { report, decisions, target, userId: ctx.actor.userId, jobId: ctx.job.id, regions: ctx.regions },
      this.store.commitStoreFor(target),
      this.lookups,
      { ...hooks, shouldStop: () => hooks.isCancelRequested() },
    );
    await this.finishCommit(ctx, target, outcome);
    const c = outcome.counts;
    if (outcome.stoppedEarly) {
      throw new BackgroundJobCancelledError({
        summary: `Stopped on request after ${n(outcome.saved)} of ${n(outcome.toSave)} rows: ${commitSentence(outcome, target)} ` +
          'Retry to finish — rows already saved are recognised, not duplicated.',
        counts: { ...c, removed: outcome.removed.length },
      });
    }
    this.logger.log(
      `Branch commit ${ctx.job.id}: created=${c.created} updated=${c.updated} unchanged=${c.unchanged} ` +
        `linked=${c.linked} skipped=${c.skipped} in ${Math.round((Date.now() - started) / 1000)}s (geocoded=${outcome.geocoded})`,
    );
    const details: BranchImportCommitDetails = {
      phase: 'commit',
      skipped: outcome.skipped.slice(0, 50),
      imprecise: outcome.imprecise.slice(0, 50),
      revived: outcome.revived.slice(0, 50),
    };
    return succeed({ summary: commitSentence(outcome, target), counts: { ...c, removed: outcome.removed.length }, details });
  }

  private async finishCommit(ctx: RunContext<BranchImportParams>, target: BranchImportTarget, outcome: CommitOutcome): Promise<void> {
    // Coarsely placed branches go to the precision worker now, not whenever the nightly sweep runs.
    void this.geoPrecision.enqueueBackfill('branch', outcome.impreciseBranchIds, `import into ${target.label}`);
    await this.store.recordImportSummary(
      target,
      ctx.actor.userId,
      ctx.job.id,
      `Branch import into ${target.label}: ${commitSentence(outcome, target)}`,
      { ...outcome.counts, removed: outcome.removed.length },
    );
    const noted = [
      ...outcome.skipped.map((r) => ['Not imported', r] as const),
      ...outcome.imprecise.map((r) => ['Placed approximately', r] as const),
      ...outcome.revived.map((r) => ['Restored from archive', r] as const),
      ...outcome.removed.map((r) => ['Removed in review', r] as const),
    ];
    if (noted.length > 0) {
      const workbook = buildWorkbook([{
        name: 'Branch import',
        headers: ['Row', 'SOL ID', 'What happened', 'Why'],
        rows: noted.sort((a, b) => a[1].row - b[1].row).map(([what, r]) => [r.row, r.solId ?? '', what, r.reason]),
        columnWidths: [8, 14, 22, 110],
      }]);
      await ctx.attachReport('branch-import-report.xlsx', workbook, EXCEL_MIME);
    }
  }
}

function readerFor(actor: JobActor, regions: string[] | null): JobReader {
  return { userId: actor.userId, roleNames: actor.roleNames, regions, organizationId: actor.organizationId ?? null };
}

export function commitSentence(outcome: Pick<CommitOutcome, 'counts'>, target: Pick<BranchImportTarget, 'projectId'>): string {
  const c = outcome.counts;
  const saved = c.created + c.updated + c.unchanged;
  const parts = [`${n(c.created)} new`, `${n(c.updated)} updated`];
  if (c.unchanged) parts.push(`${n(c.unchanged)} already up to date`);
  if (c.revived) parts.push(`${n(c.revived)} restored from the archive`);
  let sentence = `${n(saved)} branches saved (${parts.join(', ')})`;
  if (target.projectId) sentence += `; ${n(c.linked)} added to the project`;
  if (c.skipped) sentence += `; ${n(c.skipped)} not imported`;
  if (c.imprecise) sentence += `; ${n(c.imprecise)} placed approximately for now`;
  return `${sentence}.`;
}
