import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  ParseUUIDPipe,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, IsNotEmpty, IsOptional, IsObject, IsArray, IsUUID, IsEnum, IsDateString, IsNumber, IsBoolean, Min, MaxLength, ValidateIf, ArrayNotEmpty, ArrayMaxSize } from 'class-validator';

import { CommandCenterService } from './command-center.service';
import { PlanningService, CreateBusinessRuleDto, UpdateBusinessRuleDto } from './planning.service';
import { PlanningOrchestratorService } from './planning-orchestrator.service';
import { ProjectPlanningService } from './project-planning.service';
import { OptimizationEngine } from './optimization.engine';
import { ScenarioPlanningService } from './scenario-planning.service';
import { CoveragePlanningEngine } from './coverage-planning.engine';
import { DayPlannerService } from './day-planner.service';
import { PlanningJobsService } from './planning-jobs.service';
import { PlanningWriteJobsService } from './planning-write-jobs.service';
import { jobActorFrom } from '../../infrastructure/queue/job-actor';
import { OperationsPlanningService, PlanOverrideDto } from './operations-planning.service';
import { CoveragePlanStatus } from './coverage-plan.entity';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, AllowPermissionFallback } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole } from '@fapoms/shared';
import { GlobalScopeFilter, GlobalScope, assignedRegions } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';

/**
 * The `scope` values `BusinessRuleEntity` actually stores (see its own column comment) and the
 * `ruleType` values `RuleEngine.evaluate` actually dispatches on (modules/platform/rules/rule.engine.ts —
 * its switch matches `CERTIFICATION`, `SKILL`, `TERRITORY` and `CAPACITY` only).
 *
 * This DTO used to comment `ruleType` as 'ELIGIBILITY', 'CAPACITY', 'CERTIFICATION', 'TERRITORY'
 * — stale, and 'ELIGIBILITY' has never been a value the engine understands. A rule created with
 * a value outside this set would save (both fields are plain unindexed varchar columns) but then
 * either match no branch of the engine's switch — an inert rule that silently never fires — or
 * sit under a scope the engine never queries for. `Rules.tsx` (the only writer) only ever sends
 * one of these four rule types through its dropdown, so this tightens the API boundary without
 * touching a value the working UI relies on. `PREFERENCE` is a
 * client-side-only display label for the client-preference list (see the engine's own comment on
 * why there is no PREFERENCE branch) and is never created through this endpoint, so it is
 * deliberately absent here.
 *
 * Declared here rather than reusing a type from `business-rule.entity.ts` because no such type
 * exists there yet, and this agent's ownership for this task is scoped to these two DTOs only.
 */
export enum PlanningRuleType {
  CERTIFICATION = 'CERTIFICATION',
  SKILL = 'SKILL',
  TERRITORY = 'TERRITORY',
  CAPACITY = 'CAPACITY',
}

export enum PlanningRuleScope {
  GLOBAL = 'GLOBAL',
  CLIENT = 'CLIENT',
  BRANCH = 'BRANCH',
}

export class CreateBusinessRuleRequestDto implements CreateBusinessRuleDto {
  @IsString() @IsNotEmpty()
  name: string;

  @IsEnum(PlanningRuleScope)
  scope: string;

  /**
   * Required for CLIENT/BRANCH, and only then. `RuleEngine.loadRules` matches a CLIENT-scoped
   * row on `targetId: clientId` and a BRANCH-scoped one on `targetId: branch.id` — an exact
   * match against a real id, never against null. A rule saved as `scope: 'BRANCH'` with no
   * `targetId` therefore cannot match ANY branch, ever: it sits in the rules list looking
   * exactly like a working rule (active, no error, no warning) while silently doing nothing
   * for every branch it could have applied to. The frontend already refuses to submit this
   * combination (`Rules.tsx`'s pre-submit check), but that only protects the one client this
   * API ships with — this is the actual boundary a nonsensical rule can currently walk past.
   * GLOBAL is untouched: `targetId` stays optional there, exactly as before.
   */
  @ValidateIf((o) => o.scope !== PlanningRuleScope.GLOBAL)
  @IsString() @IsNotEmpty({ message: 'targetId is required when scope is CLIENT or BRANCH — a rule scoped this way with no target can never match anything.' })
  targetId?: string;

  @IsEnum(PlanningRuleType)
  ruleType: string;

  @IsObject() @IsNotEmpty()
  conditions: Record<string, any>;

  @IsOptional() @IsObject()
  actions?: Record<string, any>;
}

export class UpdateBusinessRuleRequestDto implements UpdateBusinessRuleDto {
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsEnum(PlanningRuleScope)
  scope?: string;

  @IsOptional() @IsString()
  targetId?: string | null;

  @IsOptional() @IsEnum(PlanningRuleType)
  ruleType?: string;

  @IsOptional() @IsObject()
  conditions?: Record<string, any>;

  @IsOptional() @IsObject()
  actions?: Record<string, any> | null;
}

/**
 * Deployment date for an approved coverage plan. Without it, execution silently used "today",
 * which on any holiday or weekend means every assignment is rejected by the date rules and
 * nothing can be deployed at all.
 */
class ExecutePlanRequestDto {
  @IsOptional() @IsDateString()
  scheduledDate?: string;
}

class CreateCoveragePlanRequestDto {
  @IsOptional() @IsArray()
  overrides?: PlanOverrideDto[];

  @IsOptional() @IsString() @MaxLength(2000)
  justification?: string;

  /** The campaign start date the plan is judged on (F1) — the date the modal deploys from. */
  @IsOptional() @IsDateString()
  startDate?: string;
}

/** A `YYYY-MM-DD` start date from a query or body, or null. */
const validDateKey = (v?: string | null): string | null =>
  v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;

/** The coverage-plan preview's body: only the start date it is judged on (F1). */
class CoveragePlanPreviewRequestDto {
  @IsOptional() @IsDateString()
  startDate?: string;
}

/**
 * The most branches one bulk run takes. The planning queue's select-all tops out at the few hundred
 * branches of the largest project; a thousand is a ceiling on a body a caller controls, not a target.
 */
const MAX_BULK_BRANCHES = 1000;

/**
 * "Offer all to …" from the planning queue, as one request.
 *
 * Field rules are the ones `POST /assignments` applies to the same fields
 * (`CreateAssignmentRequestDto`), because the worker hands them to the same `create` without passing
 * back through that DTO.
 */
export class BulkOfferRequestDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(MAX_BULK_BRANCHES) @IsUUID('all', { each: true })
  projectBranchIds: string[];

  @IsUUID()
  assayerId: string;

  /** Only for the remark written on each assignment ("Bulk-assigned to …"). */
  @IsOptional() @IsString() @MaxLength(200)
  assayerName?: string;

  @IsOptional() @IsDateString()
  scheduledDate?: string;

  @IsOptional() @IsBoolean()
  acceptOnBehalf?: boolean;

  @IsOptional() @IsString() @MaxLength(1000)
  acceptanceReason?: string;

  /**
   * Waives an overridable rule (rotation, required skills, the service ceiling) on each branch,
   * recorded against every offer it is used on — the same `overrideReason` `POST /assignments`
   * takes, applied per branch by the same `create()`.
   */
  @IsOptional() @IsString() @MaxLength(1000)
  overrideReason?: string;
}

/** "Mark unable to cover" over a selection, as one request. */
export class BulkUnableToCoverRequestDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(MAX_BULK_BRANCHES) @IsUUID('all', { each: true })
  projectBranchIds: string[];

  // Required, as on the single-branch route: the status exists so the cause is reportable.
  @IsString() @IsNotEmpty() @MaxLength(2000)
  reason: string;
}

class TransitionCoveragePlanRequestDto {
  @IsEnum(CoveragePlanStatus)
  status: CoveragePlanStatus;
}

class SimulateScenarioRequestDto {
  @IsUUID()
  projectId: string;

  @IsOptional() @IsObject()
  weightOverrides?: Record<string, number>;

  @IsOptional() @IsNumber() @Min(0)
  defaultRadiusOverride?: number;
}

@ApiTags('Planning')
@ApiBearerAuth()
/**
 * Reading the plan is a permission; changing it is still a name.
 *
 * Every route below that asks only for `planning:view:organization` carries
 * `@AllowPermissionFallback()`, so a role built in Admin → Roles and granted planning:view reaches
 * it. Without that the `@Roles` lists were closed whitelists of built-in names, and a custom role
 * holding PLANNING:VIEW got a 403 from `/planning/command-center` while the web app's own routing
 * table offered it `/executive-map` and `/planning` on the strength of that very grant — the page
 * opened and could not fill itself.
 *
 * The `planning:create`, `planning:edit` and `planning:delete` routes deliberately do NOT carry it.
 * Opening a screen and committing a coverage plan against real branches are different decisions,
 * and this change is scoped to the first. A custom role granted a planning write today still meets
 * the `@Roles` list; widening that is a product decision, not a parity repair, and the safe
 * direction to leave it in is the one where nothing new can be written.
 *
 * The POST `…/jobs` routes are on the read side on purpose: they require only planning:view because
 * they queue a computation and return a job id. They read the book; they do not change it.
 */
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('planning')
export class PlanningController {
  constructor(
    private readonly planningService: PlanningService,
    private readonly commandCenterService: CommandCenterService,
    private readonly planningOrchestratorService: PlanningOrchestratorService,
    private readonly projectPlanningService: ProjectPlanningService,
    private readonly optimizationEngine: OptimizationEngine,
    private readonly scenarioPlanningService: ScenarioPlanningService,
    private readonly coveragePlanningEngine: CoveragePlanningEngine,
    private readonly operationsPlanningService: OperationsPlanningService,
    private readonly dayPlannerService: DayPlannerService,
    private readonly planningJobsService: PlanningJobsService,
    private readonly regionGuard: RegionGuardService,
    private readonly planningWriteJobs: PlanningWriteJobsService,
  ) {}

  @Get('projects/:projectId/coverage')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Get project planning coverage and metrics summary' })
  async getProjectCoverage(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertProjectInScope(projectId, scope);
    const coverage = await this.planningOrchestratorService.getProjectCoverage(projectId);
    return coverage;
  }

  /**
   * Throttled like the optimiser it is as expensive as. This runs the recommendation engine
   * once per branch in the project, so one call is bounded by the size of the book rather than
   * by anything the caller passes; a page that re-fires it on every socket event, or two
   * operators refreshing together, is enough to hold connections for the whole pool. The POST
   * variants have carried a limit since they were written — these GETs simply never did.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('projects/:projectId/coverage-plan')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:view:organization')
  @AllowPermissionFallback()  // see the note on this controller: planning:view is the gate
  @ApiOperation({ summary: 'Generate detailed coverage planning statistics, capacity analysis, and cluster plans' })
  async getProjectCoveragePlan(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @GlobalScopeFilter() scope?: GlobalScope,
    @Query('startDate') startDate?: string,
  ) {
    const day = startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : null;
    const plan = await this.coveragePlanningEngine.generateCoveragePlan(projectId, scope, undefined, day);
    return plan;
  }

  /**
   * The same coverage plan as the GET above, run on the queue instead of in the request.
   *
   * Additive on purpose. The GET stays exactly as it is because the web app calls it today and
   * this must be deployable without a coordinated frontend release; a client migrates to the
   * queued pair when it is ready to, and a project small enough to answer in half a second has
   * no reason to.
   *
   * POST rather than GET despite being a read: it creates a job resource, it is not cacheable,
   * and it must not be replayed by a browser prefetch or a proxy.
   *
   * Roles are copied from the GET rather than from the sibling `POST …/coverage-plan`. What this
   * returns is the read-only plan, so requiring `planning:create:organization` (which that route
   * needs because it *persists* a plan version) would refuse operations executives access to a
   * report they can already open synchronously.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('projects/:projectId/coverage-plan/jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:view:organization')
  @AllowPermissionFallback()  // see the note on this controller: planning:view is the gate
  @ApiOperation({ summary: 'Queue coverage plan generation; returns a job id to poll' })
  async queueProjectCoveragePlan(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
    @Body() body?: CoveragePlanPreviewRequestDto,
  ) {
    // The scope resolved here — region already intersected against `users.regions` and refused
    // if not held — is frozen into the job payload. The worker has no request and so no
    // principal of its own; without this the queued run would be unscoped and would hand a
    // regional operator the national plan.
    const enqueued = await this.planningJobsService.enqueueCoveragePlan(projectId, scope ?? null, req.user?.id, body?.startDate?.slice(0, 10) ?? null);
    return enqueued;
  }

  @Post('projects/:projectId/coverage-plan')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Create or regenerate coverage plan version with manual overrides' })
  async createOrRegeneratePlan(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() body: CreateCoveragePlanRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertProjectInScope(projectId, scope);
    // The caller's scope and start date — the same the preview used (F19 / F1).
    const plan = await this.operationsPlanningService.createOrRegeneratePlan(
      projectId, body.overrides || [], req.user.id, body.justification, undefined,
      { scope: scope ?? undefined, startDate: body.startDate?.slice(0, 10) ?? null },
    );
    return plan;
  }

  /**
   * The same plan version as the POST above, generated on the write queue.
   *
   * Generating a version runs the whole coverage engine — the same per-branch work the read-only
   * preview was moved off the request for — and then writes a version row. Same roles, permission
   * and region check as the synchronous route; the response is a job id, and the job's result is
   * the plan the POST returned.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('projects/:projectId/coverage-plan/versions/jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Queue creating or regenerating a coverage plan version; returns a job id to poll' })
  async queueCreateOrRegeneratePlan(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() body: CreateCoveragePlanRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertProjectInScope(projectId, scope);
    return await this.planningWriteJobs.enqueueGenerateVersion(
      projectId,
      (body.overrides ?? []) as unknown as Array<Record<string, unknown>>,
      body.justification,
      this.writeRequester(req),
      // The same scope and start date the preview used (F19 / F1).
      { scope: scope ?? null, startDate: body.startDate?.slice(0, 10) ?? null },
    );
  }

  @Put('coverage-plans/:planId/transition')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:edit:organization')
  @ApiOperation({ summary: 'Transition coverage plan lifecycle status (e.g. DRAFT to APPROVED)' })
  async transitionPlan(
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: TransitionCoveragePlanRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertCoveragePlanInScope(planId, scope);
    const plan = await this.operationsPlanningService.transitionPlanStatus(planId, body.status, req.user.id);
    return plan;
  }

  /**
   * Deploy an approved plan — ACCEPTED, not performed.
   *
   * This used to create every assignment inside the request: per branch an eligibility check, a fee
   * quote, a road route, a row lock, a transaction and audit writes, with up to ten dated attempts.
   * A 166-branch plan passes the web client's 30 s budget, so the screen said the deploy failed
   * while the server carried on creating offers, and pressing Deploy again started a second run.
   *
   * It now answers 202 `{ jobId, deduplicated, backgroundJobId }`. The job's result, read from
   * `GET /planning/write-jobs/:jobId`, is exactly the body this route used to return
   * (`describeDeployment`). A second press by the same account while the run is going joins it.
   * The run is tracked (`backgroundJobId`), so after a refresh it is still in the Jobs tray.
   *
   * The region check stays here, at the request, where the principal's scope is known.
   */
  @Post('coverage-plans/:planId/execute')
  // Write-heavy (spawns assignments across a whole project). Capped well below the global default.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Queue deploying an approved plan (one offer per branch); returns a job id to poll' })
  async executePlan(
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: ExecutePlanRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertCoveragePlanInScope(planId, scope);
    return await this.planningWriteJobs.enqueueExecutePlan(planId, body?.scheduledDate, this.writeRequester(req));
  }

  /**
   * "Offer all to …" over a selection, as one job.
   *
   * The planning queue used to send one `POST /assignments` per ticked branch from the browser,
   * five at a time — up to 500 requests, each subject to the per-user rate limit. Same permission
   * as `POST /assignments`, because that is what it does per branch; the region ceiling that route
   * asserts per call is asserted per branch in the worker, against the scope frozen here.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('bulk-offers/jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assignment:create:organization')
  @ApiOperation({ summary: 'Queue offering a selection of branches to one assayer; returns a job id to poll' })
  async queueBulkOffers(
    @Body() body: BulkOfferRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    return await this.planningWriteJobs.enqueueBulkOffer(body, scope ?? null, this.writeRequester(req));
  }

  /**
   * "Mark unable to cover" over a selection, as one job.
   *
   * Replaces an unbounded browser `Promise.all` of one POST per ticked branch: 500 ticked branches
   * is past the 300-a-minute per-user brake, so some were refused with 429 and the screen reported
   * only their names. Same permission as the single-branch route; region ceiling per branch in the
   * worker.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('unable-to-cover/jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('project:edit:organization')
  @ApiOperation({ summary: 'Queue recording a selection of branches as unable to cover; returns a job id to poll' })
  async queueBulkUnableToCover(
    @Body() body: BulkUnableToCoverRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    const reason = body.reason.trim();
    if (!reason) throw new BadRequestException('reason is required — say why these branches cannot be staffed.');
    return await this.planningWriteJobs.enqueueBulkUnableToCover(
      body.projectBranchIds,
      reason,
      scope ?? null,
      this.writeRequester(req),
    );
  }

  /** Same shape of work as the coverage plan: the engine, once per unassigned branch. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('projects/:projectId/candidates')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:view:organization')
  @AllowPermissionFallback()  // see the note on this controller: planning:view is the gate
  @ApiOperation({ summary: 'Retrieve candidates for all unassigned branches of a project' })
  async getProjectCandidates(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @GlobalScopeFilter() scope?: GlobalScope,
    @Query('startDate') startDate?: string,
  ) {
    const report = await this.projectPlanningService.getProjectPlanningCandidates(projectId, scope, undefined, validDateKey(startDate));
    return report;
  }

  /**
   * The queued twin of the candidates report — the slowest of the three at a measured 12.2 s for
   * a 200-branch project, because it runs the whole recommendation engine once per unassigned
   * branch. Same roles, same scope handling, same answer; only the waiting moves.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('projects/:projectId/candidates/jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:view:organization')
  @AllowPermissionFallback()  // see the note on this controller: planning:view is the gate
  @ApiOperation({ summary: 'Queue the project-wide candidates report; returns a job id to poll' })
  async queueProjectCandidates(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
    @Body() body?: CoveragePlanPreviewRequestDto,
  ) {
    const enqueued = await this.planningJobsService.enqueueProjectCandidates(projectId, scope ?? null, req.user?.id, validDateKey(body?.startDate));
    return enqueued;
  }

  @Post('projects/:projectId/optimize')
  // Runs the scoring engine across every branch × candidate for a project — the most
  // CPU-intensive endpoint in the system. Tightly throttled.
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Generate optimized project-wide assayer matching and routing deployment plan' })
  async optimizeProjectDeployment(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @GlobalScopeFilter() scope?: GlobalScope,
    @Query('startDate') startDate?: string,
  ) {
    await this.regionGuard.assertProjectInScope(projectId, scope);
    const plan = await this.optimizationEngine.generateProjectDeploymentPlan(projectId, {}, validDateKey(startDate));
    return plan;
  }

  @Post('scenarios/simulate')
  // What-if simulation runs the full optimizer without persisting; heavy CPU, so it
  // gets the same tight budget as optimize.
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Simulate planning scenario with weight and config overrides without mutating database' })
  async simulateScenario(
    @Body() dto: SimulateScenarioRequestDto,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertProjectInScope(dto.projectId, scope);
    const plan = await this.scenarioPlanningService.simulatePlanningScenario(dto);
    return plan;
  }

  @Get('command-center')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.AUDITOR)
  @RequirePermissions('planning:view:organization')
  @AllowPermissionFallback()  // see the note on this controller: planning:view is the gate
  @ApiOperation({ summary: 'Executive geographic intelligence: coverage, capacity, workload and value by territory' })
  async commandCenter(@GlobalScopeFilter() scope: GlobalScope) {
    // Takes the whole global scope now — the map is the surface where an operator most expects
    // "show me my region" to mean it, both for the branch pins and for the assayer pins.
    return await this.commandCenterService.overview(scope);
  }

  @Get('suggest-date')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:view:organization')
  @AllowPermissionFallback()  // see the note on this controller: planning:view is the gate
  @ApiOperation({ summary: 'Suggest the first workable audit date for a branch (skips Sundays, holidays, off Saturdays)' })
  async suggestAuditDate(
    @Query('branchId', ParseUUIDPipe) branchId: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertBranchInScope(branchId, scope);
    return await this.planningService.suggestAuditDate(branchId);
  }

  @Get('recommendations')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:view:organization')
  @AllowPermissionFallback()  // see the note on this controller: planning:view is the gate
  @ApiOperation({ summary: 'Retrieve and rank candidate assayers for a branch, for a given audit date' })
  async getRecommendations(
    /**
     * `branchId` is required, and the message says which parameter is missing.
     *
     * The bare `ParseUUIDPipe` answered an omitted `branchId` with "The value passed as UUID is
     * not a string" — the pipe describing its own internals, naming neither the parameter nor
     * what to do about it. A caller integrating against this endpoint reads that and has no idea
     * which of the six query parameters it means.
     */
    @Query('branchId', new ParseUUIDPipe({
      exceptionFactory: () => new BadRequestException(
        'branchId is required and must be a branch UUID — it is the branch you are asking for '
        + 'candidates at.',
      ),
    })) branchId: string,
    // The audit date availability is evaluated against (YYYY-MM-DD). Ops plans ahead, so the UI
    // sends its date picker; omitted, today is assumed (legacy callers).
    @Query('date') date?: string,
    // Rank the whole nearby workforce, treating "booked that day" and "on leave" as advisory
    // rather than disqualifying — each such candidate comes back carrying `dateConflict`. Ops
    // uses this on a first pass, when the question is who can cover the branch at all rather
    // than who is free on one particular day. Onboarding and active-status checks still apply.
    @Query('includeUnavailable') includeUnavailable?: string,
    /**
     * How far to look for candidates, in km — the operator's own radius control.
     *
     * Omitted, the engine keeps its default search area. Supplied, it widens (never narrows
     * below the client's configured serviceability radius), so the assayers the planning map
     * draws inside the operator's radius are the same ones the engine actually considers.
     */
    @Query('radiusKm') radiusKm?: string,
    /**
     * Rank people the client has not empanelled, instead of excluding them.
     *
     * The standing is still computed and still travels back on the candidate
     * (`clientStandingIssue`), and `AssignmentService` still refuses to create the assignment
     * without a stated reason — this changes what the operator can SEE, not what they may do
     * unrecorded. It exists because on this estate a compliance-strict list is frequently an
     * empty one: more than half the active workforce has no Active or Recommended standing
     * recorded with any client, and an empty candidate list gets worked around outside the
     * system rather than inside it.
     */
    @Query('ignoreClientPolicy') ignoreClientPolicy?: string,
    /**
     * Search the whole workforce rather than a disc around the branch.
     *
     * Turns off the distance PRE-FILTER, which is the only distance rule that removes somebody
     * without producing a reason — it runs before every filter, so anyone it drops is simply
     * absent from both lists. The client's conflict-of-interest floor is untouched and always
     * will be: relaxing it here would only put candidates on screen that the write path refuses
     * outright, which is the dead end this whole area was just fixed to remove.
     */
    @Query('ignoreDistancePolicy') ignoreDistancePolicy?: string,
    @GlobalScopeFilter() scope?: GlobalScope,
    /** The project being planned — whose skills apply, and "this cycle" for the rotation rule. */
    @Query('projectId') projectId?: string,
  ) {
    // Ranked candidate assayers for an arbitrary branch id — the same data the scoped
    // candidates report returns, so it takes the same ceiling.
    await this.regionGuard.assertBranchInScope(branchId, scope);
    const parsedRadius = Number(radiusKm);
    const recommendations = await this.planningService.getRecommendedCandidates(branchId, {}, date, {
      relaxAvailability: includeUnavailable === 'true' || includeUnavailable === '1',
      searchRadiusKm: Number.isFinite(parsedRadius) && parsedRadius > 0 ? parsedRadius : undefined,
      relaxClientEligibility: ignoreClientPolicy === 'true' || ignoreClientPolicy === '1',
      relaxDistancePrefilter: ignoreDistancePolicy === 'true' || ignoreDistancePolicy === '1',
      projectId: projectId && /^[0-9a-f-]{36}$/i.test(projectId) ? projectId : null,
    });
    return {
      success: true,
      data: recommendations,
      // Candidates the filters removed, with the reason. Ops needs this to distinguish
      // "nobody is suitable" from "everyone was blocked by one misconfigured rule".
      meta: {
        excluded: (recommendations as any).excluded || [],
        // "Showing the top N of M" — the list is capped (F9); the count of everyone ranked is not.
        candidateTotal: (recommendations as any).candidateTotal ?? recommendations.length,
        shown: recommendations.length,
      },
    };
  }

  /**
   * Day plans across several engagements at once.
   *
   * The per-project route below still works and is unchanged. This exists because an assayer
   * standing in a city with nearby branches should audit all of them, and whether those
   * branches belong to one engagement or three is an accounting distinction, not a routing
   * one. Planning one project at a time produced artificially short days and left neighbouring
   * branches for a second trip.
   *
   * Each branch keeps its own client's audit-duration agreement and rate card, and the
   * conflict-of-interest floor applied is the strictest across the clients in scope.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('day-plans')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:view:organization')
  @AllowPermissionFallback()  // see the note on this controller: planning:view is the gate
  @ApiOperation({ summary: 'Generate day plans spanning several projects, so one assayer can cover nearby branches across engagements' })
  async getMultiProjectDayPlans(
    @Query('projectIds') projectIds: string,
    @Query('targetDate') targetDate?: string,
    @Query('minDistanceKm') minDistanceKm?: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    const ids = this.parseProjectIds(projectIds);
    await this.regionGuard.assertProjectsInScope(ids, scope);
    const manualMinDistanceKm = minDistanceKm !== undefined ? Number(minDistanceKm) : undefined;
    const plan = await this.dayPlannerService.generateDayPlans(
      ids,
      targetDate,
      Number.isFinite(manualMinDistanceKm) ? manualMinDistanceKm : undefined,
    );
    return plan;
  }

  /**
   * Who started a planning write, as its tracked row records it: the principal the worker runs as,
   * and the regions that decide who else (an administrator) may see the row in the Jobs tray.
   */
  private writeRequester(req: any) {
    return { actor: jobActorFrom(req), regions: assignedRegions(req.user) };
  }

  /**
   * Parses and validates the comma-separated `projectIds` query parameter.
   *
   * Extracted so the synchronous route and its queued twin below cannot validate differently.
   * A malformed id that only the GET rejects would reach the worker, hit Postgres inside
   * `In(...)`, and surface as a job that failed with a driver-level cast error — the same
   * unhelpful 500 this validation was written to prevent, just an hour later and in a log.
   */
  private parseProjectIds(projectIds: string): string[] {
    const ids = (projectIds ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    if (ids.length === 0) {
      throw new BadRequestException('projectIds is required — pass one or more comma-separated project ids.');
    }

    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const malformed = ids.filter((id) => !UUID.test(id));
    if (malformed.length > 0) {
      throw new BadRequestException(`Not a valid project id: ${malformed.join(', ')}`);
    }

    return ids;
  }

  /** The queued twin of the multi-project day planner. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('day-plans/jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:view:organization')
  @AllowPermissionFallback()  // see the note on this controller: planning:view is the gate
  @ApiOperation({ summary: 'Queue multi-project day plan generation; returns a job id to poll' })
  async queueMultiProjectDayPlans(
    @Query('projectIds') projectIds: string,
    @Req() req: any,
    @Query('targetDate') targetDate?: string,
    @Query('minDistanceKm') minDistanceKm?: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    const ids = this.parseProjectIds(projectIds);
    await this.regionGuard.assertProjectsInScope(ids, scope);
    const manualMinDistanceKm = minDistanceKm !== undefined ? Number(minDistanceKm) : undefined;
    const enqueued = await this.planningJobsService.enqueueDayPlans(
      ids,
      targetDate,
      Number.isFinite(manualMinDistanceKm) ? manualMinDistanceKm : undefined,
      req.user?.id,
    );
    return enqueued;
  }

  /** Clustering plus the engine per branch per cluster, then a route optimisation per plan. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('projects/:projectId/day-plans')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:view:organization')
  @AllowPermissionFallback()  // see the note on this controller: planning:view is the gate
  @ApiOperation({ summary: 'Generate multi-branch day plans grouping nearby branches for single assayer coverage' })
  async getDayPlans(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('targetDate') targetDate?: string,
    // Same "Min Radius Filter" control already used on the single-branch Planning view —
    // previously this endpoint had no minimum-distance concept at all (see
    // DayPlannerService.resolveMinDistanceKm).
    @Query('minDistanceKm') minDistanceKm?: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertProjectInScope(projectId, scope);
    const manualMinDistanceKm = minDistanceKm !== undefined ? Number(minDistanceKm) : undefined;
    const plan = await this.dayPlannerService.generateDayPlans(
      projectId,
      targetDate,
      Number.isFinite(manualMinDistanceKm) ? manualMinDistanceKm : undefined,
    );
    return plan;
  }

  /** The queued twin of the single-project day planner. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('projects/:projectId/day-plans/jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:view:organization')
  @AllowPermissionFallback()  // see the note on this controller: planning:view is the gate
  @ApiOperation({ summary: 'Queue day plan generation for one project; returns a job id to poll' })
  async queueDayPlans(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Req() req: any,
    @Query('targetDate') targetDate?: string,
    @Query('minDistanceKm') minDistanceKm?: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertProjectInScope(projectId, scope);
    const manualMinDistanceKm = minDistanceKm !== undefined ? Number(minDistanceKm) : undefined;
    const enqueued = await this.planningJobsService.enqueueDayPlans(
      [projectId],
      targetDate,
      Number.isFinite(manualMinDistanceKm) ? manualMinDistanceKm : undefined,
      req.user?.id,
    );
    return enqueued;
  }

  /**
   * Poll one planning job.
   *
   * One route for all three job types, because a client that has a job id does not need to
   * remember which endpoint produced it, and because the polling loop is identical in every
   * case: keep going while `state` is `queued` or `running`, then read `result` or `error`.
   *
   * No `ParseUUIDPipe` — Bull job ids are a per-queue incrementing integer, not a UUID. That is
   * also exactly why `PlanningJobsService.status` refuses any job whose payload does not name
   * this account as its requester: these ids are guessable and the results behind them are
   * region-scoped.
   *
   * Not throttled beyond the global default. Polling is the intended access pattern here, and a
   * poll is one Redis read; throttling it would break the very clients this exists to serve.
   */
  @Get('jobs/:jobId')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:view:organization')
  @AllowPermissionFallback()  // see the note on this controller: planning:view is the gate
  @ApiOperation({ summary: 'Poll a queued planning job for progress and, once done, its result' })
  async getPlanningJob(@Param('jobId') jobId: string, @Req() req: any) {
    return await this.planningJobsService.status(jobId, req.user?.id);
  }

  /**
   * Poll one planning WRITE job (deploy, version generation, bulk offer, bulk unable-to-cover).
   *
   * A separate route from `jobs/:jobId` because the write queue numbers its jobs from 1 as well: the
   * same id on the two queues is two different jobs. Only the account that started the job can read
   * it — a 404 otherwise, see `assertJobVisibleTo`.
   */
  @Get('write-jobs/:jobId')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:view:organization')
  @AllowPermissionFallback()  // see the note on this controller: planning:view is the gate
  @ApiOperation({ summary: 'Poll a queued planning write job for progress and, once done, its per-branch result' })
  async getPlanningWriteJob(@Param('jobId') jobId: string, @Req() req: any) {
    return await this.planningWriteJobs.status(jobId, req.user?.id);
  }

  // Rule Engine Management REST Endpoints
  @Post('rules')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Create a new business planning rule' })
  async createRule(@Body() dto: CreateBusinessRuleRequestDto, @Req() req: any) {
    const rule = await this.planningService.createRule(dto, req.user.id);
    return rule;
  }

  @Put('rules/:id')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('planning:edit:organization')
  @ApiOperation({ summary: 'Update a business planning rule by ID' })
  async updateRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBusinessRuleRequestDto,
    @Req() req: any,
  ) {
    const rule = await this.planningService.updateRule(id, dto, req.user.id);
    return rule;
  }

  @Delete('rules/:id')
  @Roles(SystemRole.ADMIN)
  @RequirePermissions('planning:delete:organization')
  @ApiOperation({ summary: 'Soft delete/disable a business planning rule' })
  async deleteRule(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.planningService.deleteRule(id, req.user.id);
    return { message: 'Business rule deleted successfully' };
  }

  @Roles(...STAFF_ROLES)
  @Get('rules')
  @ApiOperation({ summary: 'List all active business planning rules' })
  async getRules(@Query('scope') scope?: string) {
    const rules = await this.planningService.getRules(scope);
    return rules;
  }

  @Get('rules/:id')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Get a business planning rule by ID' })
  async getRule(@Param('id', ParseUUIDPipe) id: string) {
    const rule = await this.planningService.getRule(id);
    return rule;
  }
}
