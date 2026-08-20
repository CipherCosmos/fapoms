import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards';
import { SearchService } from './search.service';

@ApiTags('Search')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
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
