/**
 * FAPOMS — Assayer Controller
 *
 * REST API endpoints for Assayer profile administration (Part 5 §5).
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
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsEmail, IsArray, IsInt, IsObject } from 'class-validator';

import { AssayerService, CreateAssayerDto, UpdateAssayerDto } from './assayer.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole, AssayerStatus } from '@fapoms/shared';

class CreateAssayerRequestDto implements CreateAssayerDto {
  @IsString() @IsNotEmpty()
  assayerCode: string;

  @IsString() @IsNotEmpty()
  firstName: string;

  @IsString() @IsNotEmpty()
  lastName: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsString() @IsNotEmpty()
  phone: string;

  @IsOptional() @IsString()
  alternatePhone?: string;

  @IsString() @IsNotEmpty()
  address: string;

  @IsString() @IsNotEmpty()
  state: string;

  @IsString() @IsNotEmpty()
  district: string;

  @IsString() @IsNotEmpty()
  city: string;

  @IsOptional() @IsString()
  pincode?: string;

  @IsOptional() @IsNumber()
  latitude?: number;

  @IsOptional() @IsNumber()
  longitude?: number;

  @IsOptional() @IsString()
  panNumber?: string;

  @IsOptional() @IsString()
  bankAccountNumber?: string;

  @IsOptional() @IsString()
  ifscCode?: string;

  @IsOptional() @IsString()
  notes?: string;

  @IsOptional() @IsString()
  employmentType?: string;

  @IsOptional() @IsArray()
  skills?: string[];

  @IsOptional() @IsArray()
  certifications?: { name: string; expiryDate: string }[];

  @IsOptional() @IsArray()
  languages?: string[];

  @IsOptional() @IsArray()
  preferredRegions?: string[];

  @IsOptional() @IsArray()
  specializations?: string[];

  @IsOptional() @IsInt()
  experienceYears?: number;

  @IsOptional() @IsNumber()
  performanceRating?: number;

  @IsOptional() @IsArray()
  leaves?: { startDate: string; endDate: string }[];

  @IsOptional() @IsObject()
  workingHours?: { start: string; end: string };

  @IsOptional() @IsInt()
  maxDailyWorkload?: number;

  @IsOptional() @IsInt()
  maxWeeklyWorkload?: number;
}

class UpdateAssayerRequestDto implements UpdateAssayerDto {
  @IsOptional() @IsString()
  firstName?: string;

  @IsOptional() @IsString()
  lastName?: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString()
  phone?: string;

  @IsOptional() @IsString()
  alternatePhone?: string;

  @IsOptional() @IsString()
  address?: string;

  @IsOptional() @IsString()
  state?: string;

  @IsOptional() @IsString()
  district?: string;

  @IsOptional() @IsString()
  city?: string;

  @IsOptional() @IsString()
  pincode?: string;

  @IsOptional() @IsNumber()
  latitude?: number;

  @IsOptional() @IsNumber()
  longitude?: number;

  @IsOptional() @IsString()
  status?: AssayerStatus;

  @IsOptional() @IsString()
  panNumber?: string;

  @IsOptional() @IsString()
  bankAccountNumber?: string;

  @IsOptional() @IsString()
  ifscCode?: string;

  @IsOptional() @IsString()
  notes?: string;

  @IsOptional() @IsString()
  employmentType?: string;

  @IsOptional() @IsArray()
  skills?: string[];

  @IsOptional() @IsArray()
  certifications?: { name: string; expiryDate: string }[];

  @IsOptional() @IsArray()
  languages?: string[];

  @IsOptional() @IsArray()
  preferredRegions?: string[];

  @IsOptional() @IsArray()
  specializations?: string[];

  @IsOptional() @IsInt()
  experienceYears?: number;

  @IsOptional() @IsNumber()
  performanceRating?: number;

  @IsOptional() @IsArray()
  leaves?: { startDate: string; endDate: string }[];

  @IsOptional() @IsObject()
  workingHours?: { start: string; end: string };

  @IsOptional() @IsInt()
  maxDailyWorkload?: number;

  @IsOptional() @IsInt()
  maxWeeklyWorkload?: number;
}

@ApiTags('Assayers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('assayers')
export class AssayerController {
  constructor(private readonly assayerService: AssayerService) {}

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Register a new field assayer' })
  async create(@Body() dto: CreateAssayerRequestDto, @Req() req: any) {
    const assayer = await this.assayerService.create(dto, req.user.id);
    return {
      success: true,
      data: assayer,
    };
  }

  @Get()
  @ApiOperation({ summary: 'List all registered assayers' })
  async findAll(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    const { assayers, total } = await this.assayerService.findAll(page, limit);
    return {
      success: true,
      data: assayers,
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
  @ApiOperation({ summary: 'Get details for a single assayer by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const assayer = await this.assayerService.findOne(id);
    return {
      success: true,
      data: assayer,
    };
  }

  @Put(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Update assayer contact, banking, or operational details' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssayerRequestDto,
    @Req() req: any,
  ) {
    const assayer = await this.assayerService.update(id, dto, req.user.id);
    return {
      success: true,
      data: assayer,
    };
  }

  @Delete(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Soft delete assayer profile' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.assayerService.remove(id, req.user.id);
    return {
      success: true,
      data: { message: 'Assayer profile deleted successfully' },
    };
  }

  // Commercial Profile CRUD APIs
  @Post(':assayerId/commercial')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Create a commercial profile for an assayer' })
  async createCommercial(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Body() dto: CreateCommercialProfileRequestDto,
    @Req() req: any,
  ) {
    const profile = await this.assayerService.createCommercialProfile(assayerId, dto, req.user.id);
    return {
      success: true,
      data: profile,
    };
  }

  @Put('commercial/:id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Update a commercial profile by ID' })
  async updateCommercial(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCommercialProfileRequestDto,
    @Req() req: any,
  ) {
    const profile = await this.assayerService.updateCommercialProfile(id, dto, req.user.id);
    return {
      success: true,
      data: profile,
    };
  }

  @Get(':assayerId/commercial')
  @ApiOperation({ summary: 'Get all commercial profiles for an assayer' })
  async getCommercials(@Param('assayerId', ParseUUIDPipe) assayerId: string) {
    const profiles = await this.assayerService.getCommercialProfiles(assayerId);
    return {
      success: true,
      data: profiles,
    };
  }

  @Get(':assayerId/commercial/active')
  @ApiOperation({ summary: 'Get currently active commercial profile for an assayer' })
  async getActiveCommercial(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Query('date') dateStr?: string,
  ) {
    const date = dateStr ? new Date(dateStr) : new Date();
    const profile = await this.assayerService.getActiveCommercialProfile(assayerId, date);
    return {
      success: true,
      data: profile,
    };
  }

  // Workforce Attribute CRUD APIs
  @Post(':assayerId/workforce-attribute')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Add a skill, certification, or language to an assayer profile' })
  async addWorkforceAttribute(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Body() dto: CreateWorkforceAttributeRequestDto,
    @Req() req: any,
  ) {
    const attr = await this.assayerService.addWorkforceAttribute(assayerId, dto, req.user.id);
    return {
      success: true,
      data: attr,
    };
  }

  @Put('workforce-attribute/:id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Update a workforce attribute by ID' })
  async updateWorkforceAttribute(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkforceAttributeRequestDto,
    @Req() req: any,
  ) {
    const attr = await this.assayerService.updateWorkforceAttribute(id, dto, req.user.id);
    return {
      success: true,
      data: attr,
    };
  }

  @Delete('workforce-attribute/:id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Remove a workforce attribute by ID' })
  async removeWorkforceAttribute(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.assayerService.removeWorkforceAttribute(id, req.user.id);
    return {
      success: true,
      data: { message: 'Workforce attribute removed successfully' },
    };
  }

  @Get(':assayerId/workforce-attribute')
  @ApiOperation({ summary: 'Get workforce attributes for an assayer' })
  async getWorkforceAttributes(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Query('type') type?: string,
  ) {
    const attrs = await this.assayerService.getWorkforceAttributes(assayerId, type);
    return {
      success: true,
      data: attrs,
    };
  }
}

export class CreateWorkforceAttributeRequestDto {
  @IsString() @IsNotEmpty()
  type: string;

  @IsString() @IsNotEmpty()
  name: string;

  @IsOptional() @IsString()
  level?: string;

  @IsOptional() @IsString()
  expiryDate?: string;

  @IsOptional() @IsObject()
  metadata?: Record<string, any>;
}

export class UpdateWorkforceAttributeRequestDto {
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsString()
  level?: string;

  @IsOptional() @IsString()
  expiryDate?: string | null;

  @IsOptional() @IsObject()
  metadata?: Record<string, any>;
}

export class CreateCommercialProfileRequestDto {
  @IsNumber() @IsNotEmpty()
  baseFee: number;

  @IsNumber() @IsNotEmpty()
  hourlyRate: number;

  @IsNumber() @IsNotEmpty()
  dailyRate: number;

  @IsNumber() @IsNotEmpty()
  travelReimbursement: number;

  @IsNumber() @IsNotEmpty()
  accommodationAllowance: number;

  @IsNumber() @IsNotEmpty()
  mealAllowance: number;

  @IsOptional() @IsString()
  currency?: string;

  @IsString() @IsNotEmpty()
  effectiveStartDate: string;

  @IsOptional() @IsString()
  effectiveEndDate?: string | null;
}

export class UpdateCommercialProfileRequestDto {
  @IsOptional() @IsNumber()
  baseFee?: number;

  @IsOptional() @IsNumber()
  hourlyRate?: number;

  @IsOptional() @IsNumber()
  dailyRate?: number;

  @IsOptional() @IsNumber()
  travelReimbursement?: number;

  @IsOptional() @IsNumber()
  accommodationAllowance?: number;

  @IsOptional() @IsNumber()
  mealAllowance?: number;

  @IsOptional() @IsString()
  currency?: string;

  @IsOptional() @IsString()
  effectiveStartDate?: string;

  @IsOptional() @IsString()
  effectiveEndDate?: string | null;
}
