import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

@ApiTags('System Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('system-dashboard')
export class SystemDashboardController {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  @Get('metrics')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Retrieve live aggregated system counts and event history metrics' })
  async getMetrics() {
    // Run simple count queries for live aggregates
    const clientsCount = await this.dataSource.query('SELECT COUNT(*) AS count FROM clients WHERE is_active = true');
    const projectsCount = await this.dataSource.query('SELECT COUNT(*) AS count FROM projects WHERE is_active = true');
    const activeProjectsCount = await this.dataSource.query("SELECT COUNT(*) AS count FROM projects WHERE is_active = true AND status = 'EXECUTION'");
    const branchesCount = await this.dataSource.query('SELECT COUNT(*) AS count FROM branches WHERE is_active = true');
    const activeBranchesCount = await this.dataSource.query("SELECT COUNT(*) AS count FROM project_branches WHERE is_active = true AND status = 'ASSIGNMENT_CONFIRMED'");
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
