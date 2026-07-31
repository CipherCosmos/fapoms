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

import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsArray, IsObject } from 'class-validator';
import { ProjectService, CreateProjectDto } from './project.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, Public } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';
import { UserEntity } from '../user/user.entity';

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
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('projects')
export class ProjectController {
  constructor(
    private readonly projectService: ProjectService,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {}

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('project:create:organization')
  @ApiOperation({ summary: 'Create a new project linked to a client institution' })
  async create(@Body() dto: CreateProjectRequestDto, @Req() req: any) {
    const project = await this.projectService.create(dto, req.user.id, req.user.organizationId);
    return {
      success: true,
      data: project,
    };
  }

  @Get()
  @Public()
  @ApiOperation({ summary: 'Get paginated list of projects' })
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
  @RequirePermissions('project:update:organization')
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
  @RequirePermissions('project:delete:organization')
  @ApiOperation({ summary: 'Soft delete a project' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.projectService.remove(id, req.user.id);
    return {
      success: true,
      data: { message: 'Project deleted successfully' },
    };
  }

  // Was @Public() — anyone reaching the API could read every project branch's assignment
  // fees and negotiation state without authenticating. Fixed alongside adding operator
  // attribution below, since that made the gap more consequential (it would have exposed
  // which staff member is handling which negotiation to an unauthenticated caller too).
  @Get(':id/branches')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @ApiOperation({ summary: 'Get unassigned and planning branches queue for project' })
  async getProjectBranches(@Param('id', ParseUUIDPipe) id: string) {
    const branches = await this.projectService.findProjectBranches(id);

    // Sorted-descending most-recently-touched assignment per branch, computed once and reused
    // below rather than recomputed per field.
    const activeAssignmentByBranch = new Map(
      branches.map(b => [
        b.id,
        b.assignments
          ?.filter(a => a.status !== 'CANCELLED' && a.status !== 'REJECTED')
          ?.sort((a, b2) => new Date(b2.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
          ?.[0],
      ]),
    );

    // Resolves "who is negotiating this branch" — the ops user who created the offer, i.e.
    // who first made contact with the assayer. `createdBy` on the assignment is just a raw
    // user id (see BaseEntity), so without this the frontend has no way to show it as a name;
    // operators had no visibility into which colleague already owns a given negotiation,
    // risking duplicate outreach to the same assayer. Batched into one query rather than
    // resolved per-branch to avoid N+1 lookups on a list endpoint.
    const creatorIds = [...new Set(
      [...activeAssignmentByBranch.values()].map(a => a?.createdBy).filter((v): v is string => !!v),
    )];
    const creators = creatorIds.length
      ? await this.userRepository.find({ where: { id: In(creatorIds) }, select: ['id', 'displayName'] })
      : [];
    const creatorNameById = new Map(creators.map(u => [u.id, u.displayName]));

    const data = branches.map(b => {
      const activeAssignment = activeAssignmentByBranch.get(b.id);
      return {
        ...b,
        assignment: activeAssignment ? {
          id: activeAssignment.id,
          status: activeAssignment.status,
          proposedFee: activeAssignment.proposedFee,
          agreedFee: activeAssignment.agreedFee,
          scheduledDate: activeAssignment.scheduledDate,
          // Was declared in the frontend's type but never actually sent — the counter-offer
          // banner's "(Remarks: ...)" text always rendered "None" as a result.
          remarks: activeAssignment.remarks,
          negotiatedByName: activeAssignment.createdBy
            ? creatorNameById.get(activeAssignment.createdBy) ?? null
            : null,
          // proposeCounterFee() auto-declines once this reaches 3 — surfaced so ops can see
          // how many rounds remain before that happens, instead of it silently auto-declining.
          negotiationCount: activeAssignment.negotiationCount ?? 0,
          assayer: activeAssignment.assayer ? {
            displayName: activeAssignment.assayer.displayName,
            id: activeAssignment.assayer.id,
            assayerCode: activeAssignment.assayer.assayerCode,
          } : undefined,
        } : null,
        assignments: undefined,
      };
    });
    return {
      success: true,
      data,
    };
  }

  @Post(':id/branches')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @RequirePermissions('project:create:organization')
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
  @RequirePermissions('project:create:organization')
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
  @RequirePermissions('project:delete:organization')
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
