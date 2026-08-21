import { Controller, Get, Query, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { SearchService } from './search.service';

/**
 * Global search — the one place that reads across every table at once.
 *
 * It carried `@UseGuards(JwtAuthGuard)` alone: no `RolesGuard`, so the deny-by-default rule
 * that governs every other controller never ran, and no `@Roles`, so *any* authenticated
 * principal reached it — a field assayer's handset token and a client user included. What it
 * returned was the national index: branches, projects, clients, assignments, and assayers
 * with their phone numbers. A desk operator holding three permissions could read the lot.
 *
 * It is staff-only now, and its results go through the same region boundary as every other
 * list, so search cannot be the way around a scope the rest of the app enforces.
 */
@ApiTags('Search')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Global search across branches, assayers, projects, clients, assignments' })
  @ApiQuery({ name: 'q', required: true, description: 'Search term' })
  async search(@Query('q') q: string, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    if (!q || q.length < 1) {
      return { success: true, data: { branches: [], assayers: [], projects: [], clients: [], assignments: [] } };
    }
    const data = await this.searchService.searchAll(q, scope, rolesOf(req.user));
    return { success: true, data };
  }
}

/** Role names off the principal, in the shape the visibility helpers expect. */
function rolesOf(user: any): string[] {
  return (user?.roles ?? []).map((r: any) => r?.name ?? r).filter(Boolean);
}
