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
  UseInterceptors,
  UploadedFile,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';

import { IsString, IsNotEmpty, IsOptional, IsNumber, IsArray, IsObject } from 'class-validator';
import { ProjectService, CreateProjectDto } from './project.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

export class CreateProjectRequestDto implements CreateProjectDto {
  @IsString() @IsNotEmpty() name: string;
  @IsString() @IsNotEmpty() projectNumber: string;
  @IsOptional() @IsString() description?: string;
  @IsString() @IsNotEmpty() clientId: string;
  @IsString() @IsNotEmpty() priority: string;
  @IsOptional() @IsString() startDate?: string;
  @IsOptional() @IsString() endDate?: string;
  @IsOptional() @IsNumber() budget?: number;
  @IsOptional() @IsString() scope?: string;
  @IsOptional() @IsArray() requiredSkills?: string[];
  @IsOptional() @IsArray() requiredCertifications?: string[];
  @IsOptional() @IsObject() sla?: Record<string, any>;
  @IsOptional() @IsObject() risks?: Record<string, any>;
  @IsOptional() @IsObject() milestones?: Record<string, any>;
  @IsOptional() @IsObject() dependencies?: Record<string, any>;
  @IsOptional() @IsString() status?: string;
}

@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('projects')
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Create a new project linked to a client institution' })
  async create(@Body() dto: CreateProjectRequestDto, @Req() req: any) {
    const project = await this.projectService.create(dto, req.user.id, req.user.organizationId);
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
    @Body() dto: CreateProjectRequestDto,
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

  @Post(':id/branches')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Associate branches with a project' })
  async associateBranches(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { branchIds: string[] },
    @Req() req: any
  ) {
    const list = await this.projectService.associateBranches(id, dto.branchIds, req.user.id);
    return {
      success: true,
      data: list,
    };
  }

  @Post(':id/branches/upload')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload branches from Excel spreadsheet and associate with project' })
  async uploadBranches(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: any,
    @Req() req: any
  ) {
    const list = await this.projectService.uploadBranchesFromExcel(id, file.buffer, req.user.id);
    return {
      success: true,
      data: list,
    };
  }

  @Get(':id/branches/template')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Download Excel template for branch data entry' })
  async downloadTemplate(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const buffer = await this.projectService.generateBranchTemplate(id);
    const filename = encodeURIComponent('branch_upload_template.xlsx');
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${filename}`,
    });
    res.send(buffer);
  }

  @Delete(':id/branches/:pbId')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Remove a branch association from a project' })
  async removeBranch(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('pbId', ParseUUIDPipe) pbId: string,
    @Req() req: any
  ) {
    const list = await this.projectService.removeProjectBranch(id, pbId, req.user.id);
    return {
      success: true,
      data: list,
    };
  }
}
