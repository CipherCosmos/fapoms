import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { BILLING_READ_ROLES } from '../billing-engine/billing-roles';
import { SystemRole, BillingState } from '@fapoms/shared';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { rolesOf } from '../assayer/assayer-visibility';
import { ReportsService } from './reports.service';
import { ReportJobsService } from './report-jobs.service';
import { EXCEL_MIME } from './excel-export';


/** Roster is PII-scoped per caller role inside the service, so keep it to staff. */
const ROSTER_ROLES = STAFF_ROLES;

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly reportJobsService: ReportJobsService,
  ) {}

  private send(res: Response, buffer: Buffer, filename: string): void {
    const encoded = encodeURIComponent(filename);
    res.set({
      'Content-Type': EXCEL_MIME,
      'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
      'Content-Length': String(buffer.length),
    });
    res.send(buffer);
  }

  // Synchronous xlsx.write blocks the event loop with no yield; the queued POST twins are
  // throttled and these were not. Same ceiling so a burst of exports can't stall the process.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('coverage/:projectId')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Export project coverage report (branch-level) to Excel' })
  async coverage(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Res() res: Response,
  ): Promise<void> {
    const buffer = await this.reportsService.coverage(projectId);
    this.send(res, buffer, `coverage_${projectId}.xlsx`);
  }

  // Synchronous xlsx.write blocks the event loop with no yield; the queued POST twins are
  // throttled and these were not. Same ceiling so a burst of exports can't stall the process.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('assignments')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Export assignment status report to Excel' })
  async assignments(
    @Query('status') status?: string,
    @Query('projectBranchStatus') projectBranchStatus?: string,
    @Query('priority') priority?: string,
    @GlobalScopeFilter() scope?: GlobalScope,
    @Res() res?: Response,
  ): Promise<void> {
    const buffer = await this.reportsService.assignments({ status, projectBranchStatus, priority, scope });
    this.send(res!, buffer, `assignments_${Date.now()}.xlsx`);
  }

  // Synchronous xlsx.write blocks the event loop with no yield; the queued POST twins are
  // throttled and these were not. Same ceiling so a burst of exports can't stall the process.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('billing')
  @Roles(...BILLING_READ_ROLES)
  @ApiOperation({ summary: 'Export billing entries and invoices to Excel' })
  async billing(
    @Query('clientId') clientId?: string,
    @Query('projectId') projectId?: string,
    @Query('assayerId') assayerId?: string,
    @Query('state') state?: BillingState,
    @Res() res?: Response,
  ): Promise<void> {
    const buffer = await this.reportsService.billing({ clientId, projectId, assayerId, state });
    this.send(res!, buffer, `billing_${Date.now()}.xlsx`);
  }

  // Synchronous xlsx.write blocks the event loop with no yield; the queued POST twins are
  // throttled and these were not. Same ceiling so a burst of exports can't stall the process.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('command-center')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Export Command Center territory summary to Excel' })
  async commandCenter(
    @GlobalScopeFilter() scope?: GlobalScope,
    @Res() res?: Response,
  ): Promise<void> {
    const buffer = await this.reportsService.commandCenter(scope ?? {});
    this.send(res!, buffer, `command_center_${Date.now()}.xlsx`);
  }

  // Synchronous xlsx.write blocks the event loop with no yield; the queued POST twins are
  // throttled and these were not. Same ceiling so a burst of exports can't stall the process.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('assayer-roster')
  @Roles(...ROSTER_ROLES)
  @ApiOperation({ summary: 'Export assayer roster and payroll rate card to Excel' })
  async assayerRoster(
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
    @Res() res?: Response,
  ): Promise<void> {
    const buffer = await this.reportsService.assayerRoster(req.user, { scope });
    this.send(res!, buffer, `assayer_roster_${Date.now()}.xlsx`);
  }

  // ── Queued exports ───────────────────────────────────────────────────────
  //
  // Every GET above stays exactly as it is — the web app calls them today and this has to be
  // deployable without a coordinated frontend release. The routes below are the additive
  // alternative for the exports that hurt: they hydrate thousands of rows and then serialise a
  // workbook with `xlsx.write`, which is synchronous CPU with no yield point, so for its
  // duration the process serves nothing at all. On the queue that blackout happens once, at
  // concurrency 1, with nobody's connection held open waiting for it.
  //
  // Each POST takes the *same query parameters* as its GET, deliberately: the job then calls the
  // same service method with the same arguments and produces the same workbook, so there is no
  // second filter contract to keep in step.
  //
  // `GET /reports/coverage/:projectId` has no queued twin. It reads one project's branches — a
  // bounded, unaggregated query — and has never been on the slow list; adding a job for it would
  // be ceremony without a problem behind it.

  /**
   * @Throttle mirrors the planning job routes. Enqueuing is cheap, but each accepted job is
   * seconds of exclusive CPU later, so the budget belongs at the door rather than at the worker.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('assignments/jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Queue the assignment status export; returns a job id to poll' })
  async queueAssignments(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('projectBranchStatus') projectBranchStatus?: string,
    @Query('priority') priority?: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // The scope resolved by the decorator — region already checked against `users.regions` — is
    // frozen into the payload. The worker has no request and therefore no principal; without
    // this the queued export would run unscoped and hand a regional operator the national list.
    const enqueued = await this.reportJobsService.enqueueAssignments(
      { status, projectBranchStatus, priority, scope: scope ?? null },
      req.user?.id,
    );
    return { success: true, data: enqueued };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('billing/jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(...BILLING_READ_ROLES)
  @ApiOperation({ summary: 'Queue the billing export; returns a job id to poll' })
  async queueBilling(
    @Req() req: any,
    @Query('clientId') clientId?: string,
    @Query('projectId') projectId?: string,
    @Query('assayerId') assayerId?: string,
    @Query('state') state?: BillingState,
  ) {
    const enqueued = await this.reportJobsService.enqueueBilling(
      { clientId, projectId, assayerId, state },
      req.user?.id,
    );
    return { success: true, data: enqueued };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('command-center/jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Queue the Command Center territory export; returns a job id to poll' })
  async queueCommandCenter(@Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    const enqueued = await this.reportJobsService.enqueueCommandCenter({ scope: scope ?? null }, req.user?.id);
    return { success: true, data: enqueued };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('assayer-roster/jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(...ROSTER_ROLES)
  @ApiOperation({ summary: 'Queue the assayer roster export; returns a job id to poll' })
  async queueAssayerRoster(@Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    /**
     * The roster sheet's PII columns are decided by the caller's roles, and the worker has no
     * caller. So the roles are captured here and travel with the job — as `{ id, roles }` only,
     * because storing the whole user entity in Redis for the life of the job would put that
     * person's own PAN, bank and contact details there to answer a question about roles.
     *
     * A consequence worth being explicit about: the roles are frozen at enqueue time. If an
     * account's roles are reduced in the seconds between enqueue and execution, the export runs
     * with the wider set. The window is seconds and it matches what a synchronous request would
     * have done (that too resolves roles once, at the start), so it is a known limit rather than
     * a regression — but a *long*-lived job would need to re-resolve instead.
     */
    const enqueued = await this.reportJobsService.enqueueAssayerRoster(
      { principal: { id: req.user?.id, roles: rolesOf(req.user) }, scope: scope ?? null },
      req.user?.id,
    );
    return { success: true, data: enqueued };
  }

  /**
   * Poll one export job.
   *
   * Reports `state`, `progress` and — once done — the filename, size and how many seconds are
   * left to download it. Never the bytes: a client polling every two seconds would otherwise
   * pull the whole workbook out of Redis on every tick to render a progress bar.
   *
   * No `ParseUUIDPipe`: Bull job ids are a per-queue incrementing integer. That is exactly why
   * `ReportJobsService` refuses any job whose payload does not name this account as its
   * requester — the ids are guessable, and a billing export is not something to hand out on a
   * guess.
   *
   * One route for all four export kinds, and therefore `STAFF_ROLES` rather than each export's
   * own narrower list. That is not a widening: the narrow list is enforced where it matters, at
   * the POST that creates the job — `billing/jobs` still demands `BILLING_READ_ROLES` — and the
   * ownership check means the only jobs reachable here are ones this account was allowed to
   * create in the first place. A staff member outside `BILLING_READ_ROLES` has no billing job to
   * poll, because they were refused one.
   */
  @Get('jobs/:jobId')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Poll a queued report export for progress and, once done, its file metadata' })
  async reportJob(@Param('jobId') jobId: string, @Req() req: any) {
    return { success: true, data: await this.reportJobsService.status(jobId, req.user?.id) };
  }

  /**
   * Download the produced workbook.
   *
   * The same attachment response the synchronous routes send, so a browser handles it
   * identically. Authorisation is the job's, checked before the file is read — the file key is
   * never a way around the ownership rule that governs polling.
   */
  @Get('jobs/:jobId/download')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Download the workbook produced by a completed export job' })
  async downloadReportJob(@Param('jobId') jobId: string, @Req() req: any, @Res() res: Response): Promise<void> {
    const { buffer, meta } = await this.reportJobsService.download(jobId, req.user?.id);
    this.send(res, buffer, meta.filename);
  }
}