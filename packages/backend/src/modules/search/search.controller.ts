import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SearchService } from './search.service';

/**
 * Global search is a back-office tool, and it must be gated like one.
 *
 * With only `JwtAuthGuard` and no `RolesGuard`, this controller never ran the deny-by-default
 * role check, and the handler carried no `@Roles` — so ANY authenticated principal reached it,
 * including a field ASSAYER holding a mobile token. One `GET /search?q=a` then returned ten
 * branches, ten colleagues (name, code, phone), ten projects, ten clients and ten assignments,
 * across every region, and any query string enumerated more. The mobile app never calls this
 * endpoint (it has its own assignment list), so restricting it to staff removes the enumeration
 * path and changes nothing a real user does — the web sidebar search is a staff surface.
 */
@ApiTags('Search')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Global search across branches, assayers, projects, clients, assignments' })
  @ApiQuery({ name: 'q', required: true, description: 'Search term' })
  async search(@Query('q') q: string) {
    if (!q || q.length < 1) {
      return { success: true, data: { branches: [], assayers: [], projects: [], clients: [], assignments: [] } };
    }
    const data = await this.searchService.searchAll(q);
    return { success: true, data };
  }
}
