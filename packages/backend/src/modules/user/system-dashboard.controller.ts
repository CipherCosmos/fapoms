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
    SystemRole.ADMIN,
    SystemRole.OPERATIONS,
    SystemRole.DESK,
    SystemRole.DESK_OPERATOR,
    SystemRole.AUDITOR,
    SystemRole.CLIENT_USER,
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @ApiOperation({ summary: 'Retrieve live aggregated system counts and event history metrics' })
  async getMetrics(@GlobalScopeFilter() scope?: GlobalScope) {
    // Branch counts are territorial and follow the caller's region assignment; clients and
    // users are national registries and deliberately are not. OPERATIONS_MANAGER can hold this
    // route and can be region-assigned, so an unscoped branch count would contradict every
    // other screen that manager opens.
    const regions = scope?.regions ?? null;
    const regionParam = regions ? [regions] : [];
    const branchFilter = regions ? ' AND b.region = ANY($1)' : '';

    // The six live aggregates were six `await`s in a row — six sequential round-trips to a
    // tunnelled Postgres for six independent scalar counts, the pattern the rest of this codebase
    // long since replaced with one query / one Promise.all. They fold into a single row of scalar
    // subqueries; `$1` (the region array) is referenced by both branch subqueries and ignored by
    // the rest. The recent-activity list runs alongside it, so the whole endpoint is one round-trip
    // of latency instead of seven. `b.is_active` as well as `pb.is_active` on the active-branches
    // count: the join reaches a branch that may itself have been deleted, and a link whose own flag
    // has not caught up would otherwise count a branch that no longer exists anywhere else.
    const [counts, recentActivities] = await Promise.all([
      this.dataSource.query(
        `SELECT
           (SELECT COUNT(*) FROM clients  WHERE is_active = true) AS clients,
           (SELECT COUNT(*) FROM projects WHERE is_active = true) AS projects,
           (SELECT COUNT(*) FROM projects WHERE is_active = true AND status = 'EXECUTION') AS active_projects,
           (SELECT COUNT(*) FROM branches b WHERE b.is_active = true${branchFilter}) AS branches,
           (SELECT COUNT(*) FROM project_branches pb
              JOIN branches b ON b.id = pb.branch_id
             WHERE pb.is_active = true AND b.is_active = true AND pb.status = 'ASSIGNMENT_CONFIRMED'${branchFilter}) AS active_branches,
           (SELECT COUNT(*) FROM users WHERE is_active = true) AS users`,
        regionParam,
      ),
      this.dataSource.query(`
        SELECT id, event_type AS action, remarks AS detail, occurred_at AS "occurredAt"
        FROM audit_events
        ORDER BY occurred_at DESC
        LIMIT 10
      `),
    ]);
    const c = counts[0] ?? {};

    return {
      success: true,
      data: {
        clients: Number(c.clients || 0),
        projects: Number(c.projects || 0),
        activeProjects: Number(c.active_projects || 0),
        branches: Number(c.branches || 0),
        activeBranches: Number(c.active_branches || 0),
        users: Number(c.users || 0),
        activities: recentActivities,
      },
    };
  }
}
