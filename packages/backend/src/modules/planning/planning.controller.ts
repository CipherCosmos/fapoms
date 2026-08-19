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
import { IsString, IsNotEmpty, IsOptional, IsObject, IsArray, ArrayNotEmpty, IsUUID, IsEnum, IsDateString, IsNumber, Min, MaxLength } from 'class-validator';

import { CommandCenterService } from './command-center.service';
import { PlanningService, CreateBusinessRuleDto, UpdateBusinessRuleDto } from './planning.service';
import { PlanningOrchestratorService } from './planning-orchestrator.service';
import { ProjectPlanningService } from './project-planning.service';
import { OptimizationEngine } from './optimization.engine';
import { ScenarioPlanningService } from './scenario-planning.service';
import { CoveragePlanningEngine } from './coverage-planning.engine';
import { DayPlannerService } from './day-planner.service';
import { PlanningJobsService } from './planning-jobs.service';
import { OperationsPlanningService, PlanOverrideDto } from './operations-planning.service';
import { CoveragePlanStatus } from './coverage-plan.entity';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole } from '@fapoms/shared';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';

export class CreateBusinessRuleRequestDto implements CreateBusinessRuleDto {
  @IsString() @IsNotEmpty()
  name: string;

  @IsString() @IsNotEmpty()
  scope: string; // 'GLOBAL', 'CLIENT', 'BRANCH'

  @IsOptional() @IsString()
  targetId?: string;

  @IsString() @IsNotEmpty()
  ruleType: string; // 'ELIGIBILITY', 'CAPACITY', 'CERTIFICATION', 'TERRITORY'

  @IsObject() @IsNotEmpty()
  conditions: Record<string, any>;

  @IsOptional() @IsObject()
  actions?: Record<string, any>;
}

export class UpdateBusinessRuleRequestDto implements UpdateBusinessRuleDto {
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsString()
  scope?: string;

  @IsOptional() @IsString()
  targetId?: string | null;

  @IsOptional() @IsString()
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

/** Resolving anything operational requires a stated reason — that is the point of the record. */
class JustificationRequestDto {
  @IsString() @IsNotEmpty() @MaxLength(2000)
  justification: string;
}

class CreateCoveragePlanRequestDto {
  @IsOptional() @IsArray()
  overrides?: PlanOverrideDto[];

  @IsOptional() @IsString() @MaxLength(2000)
  justification?: string;
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
  ) {}

  @Get('projects/:projectId/coverage')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Get project planning coverage and metrics summary' })
  async getProjectCoverage(@Param('projectId', ParseUUIDPipe) projectId: string) {
    const coverage = await this.planningOrchestratorService.getProjectCoverage(projectId);
    return {
      success: true,
      data: coverage,
    };
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Generate detailed coverage planning statistics, capacity analysis, and cluster plans' })
  async getProjectCoveragePlan(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    const plan = await this.coveragePlanningEngine.generateCoveragePlan(projectId, scope);
    return {
      success: true,
      data: plan,
    };
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Queue coverage plan generation; returns a job id to poll' })
  async queueProjectCoveragePlan(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // The scope resolved here — region already intersected against `users.regions` and refused
    // if not held — is frozen into the job payload. The worker has no request and so no
    // principal of its own; without this the queued run would be unscoped and would hand a
    // regional operator the national plan.
    const enqueued = await this.planningJobsService.enqueueCoveragePlan(projectId, scope ?? null, req.user?.id);
    return { success: true, data: enqueued };
  }

  @Post('projects/:projectId/coverage-plan')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Create or regenerate coverage plan version with manual overrides' })
  async createOrRegeneratePlan(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() body: CreateCoveragePlanRequestDto,
    @Req() req: any
  ) {
    const plan = await this.operationsPlanningService.createOrRegeneratePlan(projectId, body.overrides || [], req.user.id, body.justification);
    return {
      success: true,
      data: plan,
    };
  }

  @Put('coverage-plans/:planId/transition')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:edit:organization')
  @ApiOperation({ summary: 'Transition coverage plan lifecycle status (e.g. DRAFT to APPROVED)' })
  async transitionPlan(
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: TransitionCoveragePlanRequestDto,
    @Req() req: any
  ) {
    const plan = await this.operationsPlanningService.transitionPlanStatus(planId, body.status, req.user.id);
    return {
      success: true,
      data: plan,
    };
  }

  @Post('coverage-plans/:planId/execute')
  // Engine-heavy and write-heavy (spawns assignments across a whole project). Capped
  // well below the global default so one caller cannot pin the CPU with repeated runs.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Deploy approved plan and automatically spawn operational assignments' })
  async executePlan(
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: ExecutePlanRequestDto,
    @Req() req: any
  ) {
    const result = await this.operationsPlanningService.executeApprovedPlan(planId, req.user.id, body?.scheduledDate);
    return {
      success: true,
      data: {
        message: result.fullySkipped
          ? `Nothing could be deployed — ${result.skipped.length} allocation(s) were skipped.`
          : `Coverage plan deployed: ${result.deployed.length} assignment(s) created${result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : ''}` +
            (result.dateRange ? ` across ${result.dateRange.start} → ${result.dateRange.end}.` : '.'),
        deployedCount: result.deployed.length,
        skippedCount: result.skipped.length,
        deployed: result.deployed,
        skipped: result.skipped,
        // Additive: a fully-skipped deploy is now an explained outcome rather than a thrown
        // error, and each branch carries its own workable date instead of one shared one.
        skippedReasons: result.skippedReasons,
        fullySkipped: result.fullySkipped,
        dateRange: result.dateRange,
      },
    };
  }

  /** Same shape of work as the coverage plan: the engine, once per unassigned branch. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('projects/:projectId/candidates')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Retrieve candidates for all unassigned branches of a project' })
  async getProjectCandidates(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    const report = await this.projectPlanningService.getProjectPlanningCandidates(projectId, scope);
    return {
      success: true,
      data: report,
    };
  }

  /**
   * The queued twin of the candidates report — the slowest of the three at a measured 12.2 s for
   * a 200-branch project, because it runs the whole recommendation engine once per unassigned
   * branch. Same roles, same scope handling, same answer; only the waiting moves.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('projects/:projectId/candidates/jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Queue the project-wide candidates report; returns a job id to poll' })
  async queueProjectCandidates(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    const enqueued = await this.planningJobsService.enqueueProjectCandidates(projectId, scope ?? null, req.user?.id);
    return { success: true, data: enqueued };
  }

  @Post('projects/:projectId/optimize')
  // Runs the scoring engine across every branch × candidate for a project — the most
  // CPU-intensive endpoint in the system. Tightly throttled.
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Generate optimized project-wide assayer matching and routing deployment plan' })
  async optimizeProjectDeployment(@Param('projectId', ParseUUIDPipe) projectId: string) {
    const plan = await this.optimizationEngine.generateProjectDeploymentPlan(projectId);
    return {
      success: true,
      data: plan,
    };
  }

  @Post('scenarios/simulate')
  // What-if simulation runs the full optimizer without persisting; heavy CPU, so it
  // gets the same tight budget as optimize.
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Simulate planning scenario with weight and config overrides without mutating database' })
  async simulateScenario(
    @Body() dto: SimulateScenarioRequestDto
  ) {
    const plan = await this.scenarioPlanningService.simulatePlanningScenario(dto);
    return {
      success: true,
      data: plan,
    };
  }

  @Get('command-center')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE, SystemRole.FINANCE_MANAGER, SystemRole.READ_ONLY_AUDITOR)
  @ApiOperation({ summary: 'Executive geographic intelligence: coverage, capacity, workload and value by territory' })
  async commandCenter(@GlobalScopeFilter() scope: GlobalScope) {
    // Takes the whole global scope now — the map is the surface where an operator most expects
    // "show me my region" to mean it, both for the branch pins and for the assayer pins.
    return { success: true, data: await this.commandCenterService.overview(scope) };
  }

  @Get('suggest-date')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Suggest the first workable audit date for a branch (skips Sundays, holidays, off Saturdays)' })
  async suggestAuditDate(
    @Query('branchId', ParseUUIDPipe) branchId: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertBranchInScope(branchId, scope);
    return { success: true, data: await this.planningService.suggestAuditDate(branchId) };
  }

  @Get('recommendations')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Retrieve and rank candidate assayers for a branch, for a given audit date' })
  async getRecommendations(
    @Query('branchId', ParseUUIDPipe) branchId: string,
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
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // Ranked candidate assayers for an arbitrary branch id — the same data the scoped
    // candidates report returns, so it takes the same ceiling.
    await this.regionGuard.assertBranchInScope(branchId, scope);
    const parsedRadius = Number(radiusKm);
    const recommendations = await this.planningService.getRecommendedCandidates(branchId, {}, date, {
      relaxAvailability: includeUnavailable === 'true' || includeUnavailable === '1',
      searchRadiusKm: Number.isFinite(parsedRadius) && parsedRadius > 0 ? parsedRadius : undefined,
    });
    return {
      success: true,
      data: recommendations,
      // Candidates the filters removed, with the reason. Ops needs this to distinguish
      // "nobody is suitable" from "everyone was blocked by one misconfigured rule".
      meta: { excluded: (recommendations as any).excluded || [] },
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Generate day plans spanning several projects, so one assayer can cover nearby branches across engagements' })
  async getMultiProjectDayPlans(
    @Query('projectIds') projectIds: string,
    @Query('targetDate') targetDate?: string,
    @Query('minDistanceKm') minDistanceKm?: string,
  ) {
    const ids = this.parseProjectIds(projectIds);
    const manualMinDistanceKm = minDistanceKm !== undefined ? Number(minDistanceKm) : undefined;
    const plan = await this.dayPlannerService.generateDayPlans(
      ids,
      targetDate,
      Number.isFinite(manualMinDistanceKm) ? manualMinDistanceKm : undefined,
    );
    return { success: true, data: plan };
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Queue multi-project day plan generation; returns a job id to poll' })
  async queueMultiProjectDayPlans(
    @Query('projectIds') projectIds: string,
    @Req() req: any,
    @Query('targetDate') targetDate?: string,
    @Query('minDistanceKm') minDistanceKm?: string,
  ) {
    const ids = this.parseProjectIds(projectIds);
    const manualMinDistanceKm = minDistanceKm !== undefined ? Number(minDistanceKm) : undefined;
    const enqueued = await this.planningJobsService.enqueueDayPlans(
      ids,
      targetDate,
      Number.isFinite(manualMinDistanceKm) ? manualMinDistanceKm : undefined,
      req.user?.id,
    );
    return { success: true, data: enqueued };
  }

  /** Clustering plus the engine per branch per cluster, then a route optimisation per plan. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('projects/:projectId/day-plans')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Generate multi-branch day plans grouping nearby branches for single assayer coverage' })
  async getDayPlans(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('targetDate') targetDate?: string,
    // Same "Min Radius Filter" control already used on the single-branch Planning view —
    // previously this endpoint had no minimum-distance concept at all (see
    // DayPlannerService.resolveMinDistanceKm).
    @Query('minDistanceKm') minDistanceKm?: string,
  ) {
    const manualMinDistanceKm = minDistanceKm !== undefined ? Number(minDistanceKm) : undefined;
    const plan = await this.dayPlannerService.generateDayPlans(
      projectId,
      targetDate,
      Number.isFinite(manualMinDistanceKm) ? manualMinDistanceKm : undefined,
    );
    return {
      success: true,
      data: plan,
    };
  }

  /** The queued twin of the single-project day planner. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('projects/:projectId/day-plans/jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Queue day plan generation for one project; returns a job id to poll' })
  async queueDayPlans(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Req() req: any,
    @Query('targetDate') targetDate?: string,
    @Query('minDistanceKm') minDistanceKm?: string,
  ) {
    const manualMinDistanceKm = minDistanceKm !== undefined ? Number(minDistanceKm) : undefined;
    const enqueued = await this.planningJobsService.enqueueDayPlans(
      [projectId],
      targetDate,
      Number.isFinite(manualMinDistanceKm) ? manualMinDistanceKm : undefined,
      req.user?.id,
    );
    return { success: true, data: enqueued };
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Poll a queued planning job for progress and, once done, its result' })
  async getPlanningJob(@Param('jobId') jobId: string, @Req() req: any) {
    return { success: true, data: await this.planningJobsService.status(jobId, req.user?.id) };
  }

  // Rule Engine Management REST Endpoints
  @Post('rules')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Create a new business planning rule' })
  async createRule(@Body() dto: CreateBusinessRuleRequestDto, @Req() req: any) {
    const rule = await this.planningService.createRule(dto, req.user.id);
    return {
      success: true,
      data: rule,
    };
  }

  @Put('rules/:id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:edit:organization')
  @ApiOperation({ summary: 'Update a business planning rule by ID' })
  async updateRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBusinessRuleRequestDto,
    @Req() req: any,
  ) {
    const rule = await this.planningService.updateRule(id, dto, req.user.id);
    return {
      success: true,
      data: rule,
    };
  }

  @Delete('rules/:id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @RequirePermissions('planning:delete:organization')
  @ApiOperation({ summary: 'Soft delete/disable a business planning rule' })
  async deleteRule(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.planningService.deleteRule(id, req.user.id);
    return {
      success: true,
      data: { message: 'Business rule deleted successfully' },
    };
  }

  @Roles(...STAFF_ROLES)
  @Get('rules')
  @ApiOperation({ summary: 'List all active business planning rules' })
  async getRules(@Query('scope') scope?: string) {
    const rules = await this.planningService.getRules(scope);
    return {
      success: true,
      data: rules,
    };
  }

  @Get('rules/:id')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Get a business planning rule by ID' })
  async getRule(@Param('id', ParseUUIDPipe) id: string) {
    const rule = await this.planningService.getRule(id);
    return {
      success: true,
      data: rule,
    };
  }
}
