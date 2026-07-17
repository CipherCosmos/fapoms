/**
 * FAPOMS — Client Controller
 *
 * REST API endpoints for corporate Client CRUD operations (Part 5 §3).
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
import { IsString, IsNotEmpty, IsOptional, IsObject, IsArray, IsNumber } from 'class-validator';
import { ClientService, CreateClientDto, UpdateClientDto } from './client.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

class CreateClientConfigDto {
  @IsOptional() @IsObject()
  importMapping?: Record<string, string>;

  @IsOptional() @IsArray()
  workingDays?: number[];

  @IsOptional() @IsNumber()
  defaultRadius?: number;

  @IsOptional() @IsObject()
  slaRules?: Record<string, any>;
}

class CreateClientRequestDto implements CreateClientDto {
  @IsString() @IsNotEmpty()
  clientCode: string;

  @IsString() @IsNotEmpty()
  name: string;

  @IsString() @IsNotEmpty()
  displayName: string;

  @IsOptional() @IsString()
  contactPerson?: string;

  @IsOptional() @IsString()
  contactEmail?: string;

  @IsOptional() @IsString()
  contactPhone?: string;

  @IsOptional() @IsString()
  address?: string;

  @IsOptional() @IsObject()
  configuration?: CreateClientConfigDto;
}

class UpdateClientRequestDto implements UpdateClientDto {
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsString()
  displayName?: string;

  @IsOptional() @IsString()
  contactPerson?: string;

  @IsOptional() @IsString()
  contactEmail?: string;

  @IsOptional() @IsString()
  contactPhone?: string;

  @IsOptional() @IsString()
  address?: string;

  @IsOptional() @IsObject()
  configuration?: CreateClientConfigDto;
}

@ApiTags('Clients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('clients')
export class ClientController {
  constructor(private readonly clientService: ClientService) {}

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Create a new client profile with default configuration' })
  async create(@Body() dto: CreateClientRequestDto, @Req() req: any) {
    const client = await this.clientService.create(dto, req.user.id);
    return {
      success: true,
      data: client,
    };
  }

  @Get()
  @ApiOperation({ summary: 'List all active client profiles' })
  async findAll(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    const { clients, total } = await this.clientService.findAll(page, limit);
    return {
      success: true,
      data: clients,
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
  @ApiOperation({ summary: 'Get a single client profile by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const client = await this.clientService.findOne(id);
    return {
      success: true,
      data: client,
    };
  }

  @Put(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Update client details and operational parameters' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClientRequestDto,
    @Req() req: any,
  ) {
    const client = await this.clientService.update(id, dto, req.user.id);
    return {
      success: true,
      data: client,
    };
  }

  @Delete(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Soft delete client profile' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.clientService.remove(id, req.user.id);
    return {
      success: true,
      data: { message: 'Client profile deleted successfully' },
    };
  }
}
