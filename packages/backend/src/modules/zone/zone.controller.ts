/**
 * FAPOMS — Zone Controller
 *
 * REST API endpoints for operational Zone CRUD (Part 5 §11).
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
  Req,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsArray } from 'class-validator';

import { ZoneService, CreateZoneDto, UpdateZoneDto } from './zone.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

class CreateZoneRequestDto implements CreateZoneDto {
  @IsString() @IsNotEmpty()
  name: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsString()
  clientId?: string;

  @IsOptional() @IsArray()
  states?: string[];

  @IsOptional() @IsArray()
  districts?: string[];
}

class UpdateZoneRequestDto implements UpdateZoneDto {
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsArray()
  states?: string[];

  @IsOptional() @IsArray()
  districts?: string[];
}

@ApiTags('Zones')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('zones')
export class ZoneController {
  constructor(private readonly zoneService: ZoneService) {}

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Create an operational zone' })
  async create(@Body() dto: CreateZoneRequestDto, @Req() req: any) {
    const zone = await this.zoneService.create(dto, req.user.id);
    return {
      success: true,
      data: zone,
    };
  }

  @Get()
  @ApiOperation({ summary: 'List all operational zones' })
  async findAll(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Query('clientId') clientId?: string,
  ) {
    const { zones, total } = await this.zoneService.findAll(page, limit, clientId);
    return {
      success: true,
      data: zones,
      meta: {
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrevious: page > 1,
        },
      },
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details for a single zone by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const zone = await this.zoneService.findOne(id);
    return {
      success: true,
      data: zone,
    };
  }

  @Put(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Update operational zone mappings' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateZoneRequestDto,
    @Req() req: any,
  ) {
    const zone = await this.zoneService.update(id, dto, req.user.id);
    return {
      success: true,
      data: zone,
    };
  }

  @Delete(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Soft delete zone mapping' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.zoneService.remove(id, req.user.id);
    return {
      success: true,
      data: { message: 'Zone deleted successfully' },
    };
  }
}
