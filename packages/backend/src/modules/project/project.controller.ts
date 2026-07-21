/**
 * FAPOMS — Project Controller
 *
 * REST API endpoints for projects and project branch queue management (Part 5 §3).
 */

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
  ParseUUIDPipe,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

import { ProjectService, CreateProjectDto } from './project.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects')
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Create a new project linked to a client institution' })
  async create(@Body() dto: CreateProjectDto, @Req() req: any) {
    const project = await this.projectService.create(dto, req.user.id);
    return {
      success: true,
      data: project,
    };
  }

  @Get()
  @ApiOperation({ summary: 'List all active projects' })
  async findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const result = await this.projectService.findAll(page ? Number(page) : 1, limit ? Number(limit) : 50);
    return {
      success: true,
      data: result.projects,
      meta: {
        pagination: {
          page: page ? Number(page) : 1,
          limit: limit ? Number(limit) : 50,
          total: result.total,
        },
      },
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details for a single project by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const project = await this.projectService.findOne(id);
    return {
      success: true,
      data: project,
    };
  }

  @Put(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Update project details' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProjectDto,
    @Req() req: any,
  ) {
    const project = await this.projectService.update(id, dto, req.user.id);
    return {
      success: true,
      data: project,
    };
  }

  @Delete(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Soft delete a project' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.projectService.remove(id, req.user.id);
    return {
      success: true,
      data: { message: 'Project deleted successfully' },
    };
  }

  @Get(':id/branches')
  @ApiOperation({ summary: 'Get unassigned and planning branches queue for project' })
  async getProjectBranches(@Param('id', ParseUUIDPipe) id: string) {
    const branches = await this.projectService.findProjectBranches(id);
    return {
      success: true,
      data: branches,
    };
  }
}
