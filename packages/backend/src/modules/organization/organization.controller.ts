import {
  Controller, Get, Post, Put, Delete,
  Body, Param, Query, UseGuards, Req, ParseUUIDPipe, HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEmail } from 'class-validator';
import { OrganizationService, CreateOrganizationDto, UpdateOrganizationDto } from './organization.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

class CreateOrganizationRequestDto implements CreateOrganizationDto {
  @IsString() @IsNotEmpty()
  code: string;

  @IsString() @IsNotEmpty()
  name: string;

  @IsOptional() @IsString()
  displayName?: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsString()
  address?: string;

  @IsOptional() @IsEmail()
  contactEmail?: string;

  @IsOptional() @IsString()
  contactPhone?: string;

  @IsOptional() @IsString()
  taxId?: string;

  @IsOptional() @IsString()
  registrationNumber?: string;
}

class UpdateOrganizationRequestDto implements UpdateOrganizationDto {
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsString()
  displayName?: string;

  @IsOptional() @IsString()
  address?: string;

  @IsOptional() @IsEmail()
  contactEmail?: string;

  @IsOptional() @IsString()
  contactPhone?: string;
}

@ApiTags('Organizations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('organizations')
export class OrganizationController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Post()
  @HttpCode(201)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Create a new organization' })
  async create(@Body() dto: CreateOrganizationRequestDto, @Req() req: any) {
    const org = await this.organizationService.create(dto, req.user.id);
    return { success: true, data: org };
  }

  @Get()
  @ApiOperation({ summary: 'List all organizations' })
  async findAll(@Query('page') page = 1, @Query('limit') limit = 50) {
    const { organizations, total } = await this.organizationService.findAll(page, limit);
    return {
      success: true,
      data: organizations,
      meta: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasNext: page * limit < total, hasPrevious: page > 1 },
      },
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an organization by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const org = await this.organizationService.findOne(id);
    return { success: true, data: org };
  }

  @Put(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Update an organization' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOrganizationRequestDto, @Req() req: any) {
    const org = await this.organizationService.update(id, dto, req.user.id);
    return { success: true, data: org };
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMINISTRATOR)
  @ApiOperation({ summary: 'Soft delete an organization' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any): Promise<void> {
    await this.organizationService.remove(id, req.user.id);
  }
}
