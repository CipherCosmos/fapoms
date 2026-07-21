/**
 * FAPOMS — Planning Controller
 *
 * Exposes API endpoints for candidate recommendations and proximity search (Part 5 §6).
 */

import {
  Controller,
  Get,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { PlanningService } from './planning.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

@ApiTags('Planning')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('planning')
export class PlanningController {
  constructor(private readonly planningService: PlanningService) {}

  @Get('recommendations')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Retrieve and rank candidates assayers by PostGIS proximity sphere' })
  async getRecommendations(@Query('branchId', ParseUUIDPipe) branchId: string) {
    const recommendations = await this.planningService.getRecommendedCandidates(branchId);
    return {
      success: true,
      data: recommendations,
    };
  }
}
