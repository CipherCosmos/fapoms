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
import { IsString, IsNotEmpty, IsOptional, IsObject } from 'class-validator';

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

@ApiTags('Planning')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('planning')
export class PlanningController {
  constructor(
    private readonly planningService: PlanningService,
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
    @Body() body: { coveragePlanId: string; executionGroupId: string; branchId: string; assayerId: string; plannedDate: string }
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
  @RequirePermissions('planning:update:organization')
  @ApiOperation({ summary: 'Transition field visit execution status (e.g. READY to TRAVELLING)' })
  async transitionVisit(
    @Param('visitId', ParseUUIDPipe) visitId: string,
    @Body() body: { status: FieldVisitStatus }
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
    @Body() body: { title: string; description: string; severity: IncidentSeverity }
  ) {
    const incident = await this.fieldService.reportIncident(visitId, body.title, body.description, body.severity);
    return {
      success: true,
      data: incident,
    };
  }

  @Put('field/incidents/:incidentId/resolve')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:update:organization')
  @ApiOperation({ summary: 'Resolve active field incident' })
  async resolveIncident(
    @Param('incidentId', ParseUUIDPipe) incidentId: string,
    @Body() body: { justification: string }
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
  async packageAssignments(@Body() dto: GroupPackageDto) {
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
    @Body() body: { sender: NegotiationParticipant; message: string; feeOverride?: number; dateOverride?: string }
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
    @Body() body: { projectId: string; title: string; reason: string; priority: OperationsTaskPriority }
  ) {
    const task = await this.controlCenterService.createOperationsTask(body.projectId, body.title, body.reason, body.priority);
    return {
      success: true,
      data: task,
    };
  }

  @Put('control-center/tasks/:taskId/resolve')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:update:organization')
  @ApiOperation({ summary: 'Resolve an operations task with justification log' })
  async resolveTask(
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: { justification: string }
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
    @Body() body: { projectId: string; category: OperationsExceptionCategory; message: string; targetEntityId?: string }
  ) {
    const exc = await this.controlCenterService.flagException(body.projectId, body.category, body.message, body.targetEntityId);
    return {
      success: true,
      data: exc,
    };
  }

  @Put('control-center/exceptions/:exceptionId/resolve')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('planning:update:organization')
  @ApiOperation({ summary: 'Resolve or bypass exception log with justification' })
  async resolveException(
    @Param('exceptionId', ParseUUIDPipe) exceptionId: string,
    @Body() body: { justification: string }
  ) {
    const exc = await this.controlCenterService.resolveException(exceptionId, body.justification);
    return {
      success: true,
      data: exc,
    };
  }

  @Get('projects/:projectId/coverage')
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
    @Body() body: { overrides?: PlanOverrideDto[]; justification?: string },
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
  @RequirePermissions('planning:update:organization')
  @ApiOperation({ summary: 'Transition coverage plan lifecycle status (e.g. DRAFT to APPROVED)' })
  async transitionPlan(
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: { status: CoveragePlanStatus },
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
    @Body() dto: { projectId: string; weightOverrides?: Record<string, number>; defaultRadiusOverride?: number }
  ) {
    const plan = await this.scenarioPlanningService.simulatePlanningScenario(dto);
    return {
      success: true,
      data: plan,
    };
  }

  @Get('recommendations')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Retrieve and rank candidate assayers for a branch' })
  async getRecommendations(@Query('branchId', ParseUUIDPipe) branchId: string) {
    const recommendations = await this.planningService.getRecommendedCandidates(branchId);
    return {
      success: true,
      data: recommendations,
    };
  }

  @Get('projects/:projectId/day-plans')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Generate multi-branch day plans grouping nearby branches for single assayer coverage' })
  async getDayPlans(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('targetDate') targetDate?: string,
  ) {
    const plan = await this.dayPlannerService.generateDayPlans(projectId, targetDate);
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
  @RequirePermissions('planning:update:organization')
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
  @ApiOperation({ summary: 'Get a business planning rule by ID' })
  async getRule(@Param('id', ParseUUIDPipe) id: string) {
    const rule = await this.planningService.getRule(id);
    return {
      success: true,
      data: rule,
    };
  }
}
