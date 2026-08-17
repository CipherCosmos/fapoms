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
import { OperationsControlCenterService } from './operations-control-center.service';
import { OperationsExecutionService, GroupPackageDto } from './operations-execution.service';
import { FieldOperationsService } from './field-operations.service';
import { CoveragePlanStatus } from './coverage-plan.entity';
import { OperationsExceptionCategory } from './operations-exception.entity';
import { OperationsTaskPriority } from './operations-task.entity';
import { NegotiationParticipant } from './operations-execution-conversation.entity';
import { ExecutionGroupStatus } from './operations-execution-group.entity';
import { FieldVisitStatus } from './field-visit.entity';
import { IncidentSeverity } from './field-incident.entity';
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
 * Runtime-validated body for execution packaging. Was typed as the `GroupPackageDto`
 * interface, which is erased at compile time — so ValidationPipe saw nothing and an empty
 * body reached the service, which then threw on a missing assayer.
 */
class GroupPackageRequestDto implements GroupPackageDto {
  @IsUUID()
  assayerId: string;

  @IsOptional() @IsString()
  name?: string;

  @IsArray() @ArrayNotEmpty() @IsUUID('4', { each: true })
  assignmentIds: string[];

  @IsOptional() @IsObject()
  logisticsPreferences?: any;
}


/**
 * Runtime-validated bodies for the operations control-centre and field-visit routes.
 *
 * These three took their `@Body()` as an inline TypeScript object literal
 * (`{ projectId: string; ... }`). Like an interface, that type is erased at compile time, so
 * ValidationPipe had nothing to check and an empty body reached the service — each returned a
 * 500 instead of telling the caller which fields were missing. Twenty-two other routes across
 * the codebase still take bodies this way; these are the three that demonstrably crash.
 */
class CreateOperationsTaskRequestDto {
  @IsUUID()
  projectId: string;

  @IsString() @IsNotEmpty()
  title: string;

  @IsString() @IsNotEmpty()
  reason: string;

  @IsEnum(OperationsTaskPriority)
  priority: OperationsTaskPriority;
}

class CreateOperationsExceptionRequestDto {
  @IsUUID()
  projectId: string;

  @IsEnum(OperationsExceptionCategory)
  category: OperationsExceptionCategory;

  @IsString() @IsNotEmpty()
  message: string;

  @IsOptional() @IsUUID()
  targetEntityId?: string;
}

class CreateFieldVisitRequestDto {
  @IsUUID()
  coveragePlanId: string;

  @IsUUID()
  executionGroupId: string;

  @IsUUID()
  branchId: string;

  @IsUUID()
  assayerId: string;

  @IsDateString()
  plannedDate: string;
}


/**
 * Runtime-validated bodies for the remaining planning mutations.
 *
 * All of these took inline object literals, which TypeScript erases — so status and severity
 * fields typed as enums were accepted as any string, and required ids as anything at all.
 */
class UpdateFieldVisitStatusRequestDto {
  @IsEnum(FieldVisitStatus)
  status: FieldVisitStatus;
}

class CreateFieldIncidentRequestDto {
  @IsString() @IsNotEmpty() @MaxLength(255)
  title: string;

  @IsString() @IsNotEmpty() @MaxLength(4000)
  description: string;

  @IsEnum(IncidentSeverity)
  severity: IncidentSeverity;
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

class CreateConversationRequestDto {
  @IsEnum(NegotiationParticipant)
  sender: NegotiationParticipant;

  @IsString() @IsNotEmpty() @MaxLength(4000)
  message: string;

  @IsOptional() @IsNumber() @Min(0)
  feeOverride?: number;

  @IsOptional() @IsDateString()
  dateOverride?: string;
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
    private readonly controlCenterService: OperationsControlCenterService,
    private readonly executionService: OperationsExecutionService,
    private readonly fieldService: FieldOperationsService,
    private readonly dayPlannerService: DayPlannerService,
    private readonly planningJobsService: PlanningJobsService,
    private readonly regionGuard: RegionGuardService,
  ) {}

  @Post('field/visits')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Initialize new field visit execution record' })
  async createVisit(
    @Body() body: CreateFieldVisitRequestDto,
    @Req() req: any
  ) {
    const visit = await this.fieldService.createFieldVisit(
      body.coveragePlanId,
      body.executionGroupId,
      body.branchId,
      body.assayerId,
      body.plannedDate,
      req.user?.id
    );
    return {
      success: true,
      data: visit,
    };
  }

  @Put('field/visits/:visitId/status')
  // OPERATIONS_EXECUTIVE was listed here but was never granted PLANNING:EDIT/CREATE, so the
  // permission guard refused it right after the role guard admitted it — a dead entry that
  // made this route look wider than it has ever been.
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:edit:organization')
  @ApiOperation({ summary: 'Transition field visit execution status (e.g. READY to TRAVELLING)' })
  async transitionVisit(
    @Param('visitId', ParseUUIDPipe) visitId: string,
    @Body() body: UpdateFieldVisitStatusRequestDto,
    @Req() req: any
  ) {
    const visit = await this.fieldService.transitionVisitStatus(visitId, body.status, req.user?.id);
    return {
      success: true,
      data: visit,
    };
  }

  @Post('field/visits/:visitId/incidents')
  // OPERATIONS_EXECUTIVE was listed here but was never granted PLANNING:EDIT/CREATE, so the
  // permission guard refused it right after the role guard admitted it — a dead entry that
  // made this route look wider than it has ever been.
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Report operational field incident (e.g. branch closed, assayer illness)' })
  async reportIncident(
    @Param('visitId', ParseUUIDPipe) visitId: string,
    @Body() body: CreateFieldIncidentRequestDto,
    @Req() req: any
  ) {
    const incident = await this.fieldService.reportIncident(visitId, body.title, body.description, body.severity, req.user?.id);
    return {
      success: true,
      data: incident,
    };
  }

  @Put('field/incidents/:incidentId/resolve')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:edit:organization')
  @ApiOperation({ summary: 'Resolve active field incident' })
  async resolveIncident(
    @Param('incidentId', ParseUUIDPipe) incidentId: string,
    @Body() body: JustificationRequestDto,
    @Req() req: any
  ) {
    const incident = await this.fieldService.resolveIncident(incidentId, body.justification, req.user?.id);
    return {
      success: true,
      data: incident,
    };
  }

  @Get('field/visits/:visitId/handover')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Generate handover package validation contract for OCR processing' })
  async getHandover(@Param('visitId', ParseUUIDPipe) visitId: string) {
    const pkg = await this.fieldService.generateHandoverPackage(visitId);
    return {
      success: true,
      data: pkg,
    };
  }

  @Get('field/dashboards/:coveragePlanId')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Get Field Execution dashboard stats summary' })
  async getFieldDashboard(@Param('coveragePlanId', ParseUUIDPipe) coveragePlanId: string) {
    const summary = await this.fieldService.getFieldOperationsDashboard(coveragePlanId);
    return {
      success: true,
      data: summary,
    };
  }

  @Post('execution/packages')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Bundle multiple operational assignments into a single deployment package' })
  async packageAssignments(@Body() dto: GroupPackageRequestDto) {
    const pkg = await this.executionService.packageAssignments(dto);
    return {
      success: true,
      data: pkg,
    };
  }

  @Post('execution/packages/:groupId/conversations')
  // OPERATIONS_EXECUTIVE was listed here but was never granted PLANNING:EDIT/CREATE, so the
  // permission guard refused it right after the role guard admitted it — a dead entry that
  // made this route look wider than it has ever been.
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Record conversation message with fee/date negotiations' })
  async postMessage(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() body: CreateConversationRequestDto
  ) {
    const msg = await this.executionService.postConversationMessage(
      groupId,
      body.sender,
      body.message,
      body.feeOverride,
      body.dateOverride
    );
    return {
      success: true,
      data: msg,
    };
  }

  @Get('execution/packages/:groupId/readiness')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Audit operational readiness constraints of a deployment package' })
  async getReadiness(@Param('groupId', ParseUUIDPipe) groupId: string) {
    const audit = await this.executionService.evaluateOperationalReadiness(groupId);
    return {
      success: true,
      data: audit,
    };
  }

  @Get('control-center/dashboard')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Get live Control Center execution statistics and KPI risk parameters' })
  async getControlCenterDashboard() {
    const summary = await this.controlCenterService.getDashboardSummary();
    return {
      success: true,
      data: summary,
    };
  }

  @Post('control-center/tasks')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Generate manual operational task in the queue' })
  async createTask(
    @Body() body: CreateOperationsTaskRequestDto,
    @Req() req: any
  ) {
    const task = await this.controlCenterService.createOperationsTask(body.projectId, body.title, body.reason, body.priority, req.user?.id);
    return {
      success: true,
      data: task,
    };
  }

  @Put('control-center/tasks/:taskId/resolve')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:edit:organization')
  @ApiOperation({ summary: 'Resolve an operations task with justification log' })
  async resolveTask(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: JustificationRequestDto,
    @Req() req: any
  ) {
    const task = await this.controlCenterService.resolveOperationsTask(taskId, body.justification, req.user?.id);
    return {
      success: true,
      data: task,
    };
  }

  @Post('control-center/exceptions')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Flag managed exception rule violations' })
  async createException(
    @Body() body: CreateOperationsExceptionRequestDto,
    @Req() req: any
  ) {
    const exc = await this.controlCenterService.flagException(body.projectId, body.category, body.message, body.targetEntityId, req.user?.id);
    return {
      success: true,
      data: exc,
    };
  }

  @Put('control-center/exceptions/:exceptionId/resolve')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:edit:organization')
  @ApiOperation({ summary: 'Resolve or bypass exception log with justification' })
  async resolveException(
    @Param('exceptionId', ParseUUIDPipe) exceptionId: string,
    @Body() body: JustificationRequestDto,
    @Req() req: any
  ) {
    const exc = await this.controlCenterService.resolveException(exceptionId, body.justification, req.user?.id);
    return {
      success: true,
      data: exc,
    };
  }

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
        message: `Coverage plan deployed: ${result.deployed.length} assignment(s) created${result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : ''}.`,
        deployedCount: result.deployed.length,
        skippedCount: result.skipped.length,
        deployed: result.deployed,
        skipped: result.skipped,
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
