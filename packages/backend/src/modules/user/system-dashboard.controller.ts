import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { OperationsSnapshotService } from './operations-snapshot.service';
import { SystemRole } from '@fapoms/shared';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';

@ApiTags('System Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('system-dashboard')
export class SystemDashboardController {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly operationsSnapshot: OperationsSnapshotService,
  ) {}

  @Get('operations')
  // Every staff role gets a dashboard — the payload itself is scoped to what the
  // caller's roles allow, so restricting the route as well would only lock people
  // out of their own view (the validator role was 403'd by exactly that).
  @Roles(
    SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR,
    SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE,
    SystemRole.FINANCE_MANAGER, SystemRole.HR_MANAGER,
    SystemRole.VALIDATION_MANAGER, SystemRole.VALIDATOR,
    SystemRole.DOCUMENT_EXECUTIVE, SystemRole.DATA_ENTRY_HEAD,
    SystemRole.READ_ONLY_AUDITOR, SystemRole.CLIENT_USER,
  )
  @ApiOperation({ summary: "Role-scoped operational snapshot: only the sections the caller's roles include" })
  async getOperations(@Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    // Sections follow the caller's own roles rather than a query parameter, so the
    // view cannot be widened by editing the request. The global scope narrows only the
    // territorial sections — see OperationsSnapshotService.TERRITORIAL_SECTIONS.
    const roles: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r).filter(Boolean);
    return { success: true, data: await this.operationsSnapshot.snapshot(roles, req.user?.id, scope) };
  }

  @Get('metrics')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Retrieve live aggregated system counts and event history metrics' })
  async getMetrics(@GlobalScopeFilter() scope?: GlobalScope) {
    // Branch counts are territorial and follow the caller's region assignment; clients and
    // users are national registries and deliberately are not. OPERATIONS_MANAGER can hold this
    // route and can be region-assigned, so an unscoped branch count would contradict every
    // other screen that manager opens.
    const regions = scope?.regions ?? null;
    const regionParam = regions ? [regions] : [];
    const branchFilter = regions ? ' AND b.region = ANY($1)' : '';

    // Run simple count queries for live aggregates
    const clientsCount = await this.dataSource.query('SELECT COUNT(*) AS count FROM clients WHERE is_active = true');
    const projectsCount = await this.dataSource.query('SELECT COUNT(*) AS count FROM projects WHERE is_active = true');
    const activeProjectsCount = await this.dataSource.query("SELECT COUNT(*) AS count FROM projects WHERE is_active = true AND status = 'EXECUTION'");
    const branchesCount = await this.dataSource.query(
      `SELECT COUNT(*) AS count FROM branches b WHERE b.is_active = true${branchFilter}`,
      regionParam,
    );
    const activeBranchesCount = await this.dataSource.query(
      // `b.is_active` as well as `pb.is_active`: the join reaches a branch that may itself have
      // been deleted, and a link whose own flag has not caught up would otherwise count a
      // branch that no longer exists anywhere else in the product.
      `SELECT COUNT(*) AS count FROM project_branches pb
         JOIN branches b ON b.id = pb.branch_id
        WHERE pb.is_active = true AND b.is_active = true AND pb.status = 'ASSIGNMENT_CONFIRMED'${branchFilter}`,
      regionParam,
    );
    const usersCount = await this.dataSource.query('SELECT COUNT(*) AS count FROM users WHERE is_active = true');

    const recentActivities = await this.dataSource.query(`
      SELECT id, event_type AS action, remarks AS detail, occurred_at AS "occurredAt"
      FROM audit_events
      ORDER BY occurred_at DESC
      LIMIT 10
    `);

    return {
      success: true,
      data: {
        clients: Number(clientsCount[0]?.count || 0),
        projects: Number(projectsCount[0]?.count || 0),
        activeProjects: Number(activeProjectsCount[0]?.count || 0),
        branches: Number(branchesCount[0]?.count || 0),
        activeBranches: Number(activeBranchesCount[0]?.count || 0),
        users: Number(usersCount[0]?.count || 0),
        activities: recentActivities,
      },
    };
  }
}
