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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsObject, IsArray, ArrayNotEmpty, IsUUID, IsEnum, IsDateString, IsNumber, Min, MaxLength } from 'class-validator';

import { CommandCenterService } from './command-center.service';
import { PlanningService, CreateBusinessRuleDto, UpdateBusinessRuleDto } from './planning.service';
import { PlanningOrchestratorService } from './planning-orchestrator.service';
import { ProjectPlanningService } from './project-planning.service';
import { OptimizationEngine } from './optimization.engine';
import { ScenarioPlanningService } from './scenario-planning.service';
import { CoveragePlanningEngine } from './coverage-planning.engine';
import { DayPlannerService } from './day-planner.service';
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
  ) {}

  @Post('field/visits')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Initialize new field visit execution record' })
  async createVisit(
    @Body() body: CreateFieldVisitRequestDto
  ) {
    const visit = await this.fieldService.createFieldVisit(
      body.coveragePlanId,
      body.executionGroupId,
      body.branchId,
      body.assayerId,
      body.plannedDate
    );
    return {
      success: true,
      data: visit,
    };
  }

  @Put('field/visits/:visitId/status')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @RequirePermissions('planning:edit:organization')
  @ApiOperation({ summary: 'Transition field visit execution status (e.g. READY to TRAVELLING)' })
  async transitionVisit(
    @Param('visitId', ParseUUIDPipe) visitId: string,
    @Body() body: UpdateFieldVisitStatusRequestDto
  ) {
    const visit = await this.fieldService.transitionVisitStatus(visitId, body.status);
    return {
      success: true,
      data: visit,
    };
  }

  @Post('field/visits/:visitId/incidents')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Report operational field incident (e.g. branch closed, assayer illness)' })
  async reportIncident(
    @Param('visitId', ParseUUIDPipe) visitId: string,
    @Body() body: CreateFieldIncidentRequestDto
  ) {
    const incident = await this.fieldService.reportIncident(visitId, body.title, body.description, body.severity);
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
    @Body() body: JustificationRequestDto
  ) {
    const incident = await this.fieldService.resolveIncident(incidentId, body.justification);
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
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
    @Body() body: CreateOperationsTaskRequestDto
  ) {
    const task = await this.controlCenterService.createOperationsTask(body.projectId, body.title, body.reason, body.priority);
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
    @Body() body: JustificationRequestDto
  ) {
    const task = await this.controlCenterService.resolveOperationsTask(taskId, body.justification);
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
    @Body() body: CreateOperationsExceptionRequestDto
  ) {
    const exc = await this.controlCenterService.flagException(body.projectId, body.category, body.message, body.targetEntityId);
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
    @Body() body: JustificationRequestDto
  ) {
    const exc = await this.controlCenterService.resolveException(exceptionId, body.justification);
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

  @Get('projects/:projectId/coverage-plan')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Generate detailed coverage planning statistics, capacity analysis, and cluster plans' })
  async getProjectCoveragePlan(@Param('projectId', ParseUUIDPipe) projectId: string) {
    const plan = await this.coveragePlanningEngine.generateCoveragePlan(projectId);
    return {
      success: true,
      data: plan,
    };
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:create:organization')
  @ApiOperation({ summary: 'Deploy approved plan and automatically spawn operational assignments' })
  async executePlan(
    @Param('planId', ParseUUIDPipe) planId: string,
    @Req() req: any
  ) {
    await this.operationsPlanningService.executeApprovedPlan(planId, req.user.id);
    return {
      success: true,
      data: { message: 'Approved coverage plan executed and deployed successfully.' },
    };
  }

  @Get('projects/:projectId/candidates')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Retrieve candidates for all unassigned branches of a project' })
  async getProjectCandidates(@Param('projectId', ParseUUIDPipe) projectId: string) {
    const report = await this.projectPlanningService.getProjectPlanningCandidates(projectId);
    return {
      success: true,
      data: report,
    };
  }

  @Post('projects/:projectId/optimize')
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
  async commandCenter(@Query('clientId') clientId?: string, @Query('state') state?: string) {
    return { success: true, data: await this.commandCenterService.overview({ clientId, state }) };
  }

  @Get('recommendations')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Retrieve and rank candidate assayers for a branch' })
  async getRecommendations(@Query('branchId', ParseUUIDPipe) branchId: string) {
    const recommendations = await this.planningService.getRecommendedCandidates(branchId);
    return {
      success: true,
      data: recommendations,
      // Candidates the filters removed, with the reason. Ops needs this to distinguish
      // "nobody is suitable" from "everyone was blocked by one misconfigured rule".
      meta: { excluded: (recommendations as any).excluded || [] },
    };
  }

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
