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
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsEmail, IsArray, IsInt, IsObject, IsEnum, IsDateString } from 'class-validator';

import { AssayerService, CreateAssayerDto, UpdateAssayerDto } from './assayer.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole, AssayerLifecycleStatus } from '@fapoms/shared';

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

  @IsOptional() @IsDateString()
  joiningDate?: string;

  @IsOptional() @IsString()
  managerId?: string;

  @IsOptional() @IsString()
  department?: string;

  @IsOptional() @IsString()
  region?: string;

  @IsOptional() @IsString()
  emergencyContactName?: string;

  @IsOptional() @IsString()
  emergencyContactPhone?: string;

  @IsOptional() @IsString()
  emergencyContactRelation?: string;

  @IsOptional() @IsString()
  employeeId?: string;

  @IsOptional() @IsString()
  employeeCode?: string;

  @IsOptional() @IsString()
  photograph?: string;

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

  @IsOptional() @IsArray()
  eligibleClients?: string[];
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
  panNumber?: string;

  @IsOptional() @IsString()
  bankAccountNumber?: string;

  @IsOptional() @IsString()
  ifscCode?: string;

  @IsOptional() @IsString()
  notes?: string;

  @IsOptional() @IsString()
  employmentType?: string;

  @IsOptional() @IsDateString()
  joiningDate?: string;

  @IsOptional() @IsDateString()
  exitDate?: string;

  @IsOptional() @IsDateString()
  terminationDate?: string;

  @IsOptional() @IsString()
  managerId?: string;

  @IsOptional() @IsString()
  department?: string;

  @IsOptional() @IsString()
  region?: string;

  @IsOptional() @IsString()
  emergencyContactName?: string;

  @IsOptional() @IsString()
  emergencyContactPhone?: string;

  @IsOptional() @IsString()
  emergencyContactRelation?: string;

  @IsOptional() @IsString()
  employeeId?: string;

  @IsOptional() @IsString()
  employeeCode?: string;

  @IsOptional() @IsString()
  photograph?: string;

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

  @IsOptional() @IsArray()
  eligibleClients?: string[];
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

export class TransitionLifecycleDto {
  @IsString() @IsNotEmpty()
  targetStatus: string;

  @IsOptional() @IsString()
  reason?: string;
}

export class CreateGovernmentDocumentRequestDto {
  @IsString() @IsNotEmpty()
  documentType: string;

  @IsString() @IsNotEmpty()
  documentNumber: string;

  @IsOptional() @IsDateString()
  expiryDate?: string;

  @IsOptional() @IsArray()
  filePaths?: string[];

  @IsOptional() @IsString()
  remarks?: string;
}

export class UpdateGovernmentDocumentRequestDto {
  @IsOptional() @IsString()
  documentNumber?: string;

  @IsOptional() @IsDateString()
  expiryDate?: string | null;

  @IsOptional() @IsString()
  verificationStatus?: string;

  @IsOptional() @IsString()
  verifiedBy?: string;

  @IsOptional() @IsArray()
  filePaths?: string[];

  @IsOptional() @IsString()
  remarks?: string;
}

export class CreateAssayerDocumentRequestDto {
  @IsString() @IsNotEmpty()
  documentType: string;

  @IsString() @IsNotEmpty()
  fileName: string;

  @IsString() @IsNotEmpty()
  filePath: string;

  @IsNumber() @IsNotEmpty()
  fileSize: number;

  @IsOptional() @IsString()
  mimeType?: string;

  @IsOptional() @IsString()
  parentDocumentId?: string;

  @IsOptional() @IsString()
  remarks?: string;
}

export class CreateRemarkRequestDto {
  @IsString() @IsNotEmpty()
  content: string;

  @IsString() @IsNotEmpty()
  category: string;

  @IsString() @IsNotEmpty()
  visibility: string;

  @IsOptional() @IsArray()
  attachmentPaths?: string[];

  @IsOptional() @IsNumber()
  rating?: number;
}

export class UpdateRemarkRequestDto {
  @IsOptional() @IsString()
  content?: string;

  @IsOptional() @IsString()
  category?: string;

  @IsOptional() @IsString()
  visibility?: string;

  @IsOptional() @IsArray()
  attachmentPaths?: string[];

  @IsOptional() @IsNumber()
  rating?: number;
}

export class UpdateAssayerDocumentRequestDto {
  @IsOptional() @IsString()
  documentType?: string;

  @IsOptional() @IsString()
  fileName?: string;

  @IsOptional() @IsString()
  filePath?: string;

  @IsOptional() @IsNumber()
  fileSize?: number;

  @IsOptional() @IsString()
  mimeType?: string;

  @IsOptional() @IsString()
  remarks?: string;
}

@ApiTags('Assayers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('assayers')
export class AssayerController {
  constructor(private readonly assayerService: AssayerService) {}

  @Post()
  @HttpCode(201)
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

  @Get(':assayerId/profile')
  @ApiOperation({ summary: 'Get detailed profile with stats for an assayer' })
  async getProfile(@Param('assayerId', ParseUUIDPipe) assayerId: string) {
    const assayer = await this.assayerService.getProfile(assayerId);
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
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Soft delete assayer profile' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any): Promise<void> {
    await this.assayerService.remove(id, req.user.id);
  }

  // Commercial Profile CRUD APIs
  @Post(':assayerId/commercial')
  @HttpCode(201)
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
  @HttpCode(201)
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

  // Lifecycle management
  @Post(':id/lifecycle')
  @HttpCode(201)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Transition assayer lifecycle status' })
  async transitionLifecycle(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionLifecycleDto,
    @Req() req: any,
  ) {
    const assayer = await this.assayerService.transitionLifecycle(id, dto.targetStatus, req.user.id, dto.reason);
    return { success: true, data: assayer };
  }

  // Government Documents
  @Post(':assayerId/government-document')
  @HttpCode(201)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Add a government document to an assayer' })
  async addGovernmentDocument(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Body() dto: CreateGovernmentDocumentRequestDto,
    @Req() req: any,
  ) {
    const doc = await this.assayerService.addGovernmentDocument(assayerId, dto, req.user.id);
    return { success: true, data: doc };
  }

  @Put('government-document/:id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Update a government document verification status' })
  async updateGovernmentDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGovernmentDocumentRequestDto,
    @Req() req: any,
  ) {
    const doc = await this.assayerService.updateGovernmentDocument(id, dto, req.user.id);
    return { success: true, data: doc };
  }

  @Get(':assayerId/government-document')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'List government documents for an assayer' })
  async getGovernmentDocuments(@Param('assayerId', ParseUUIDPipe) assayerId: string) {
    const docs = await this.assayerService.getGovernmentDocuments(assayerId);
    return { success: true, data: docs };
  }

  @Delete('government-document/:id')
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Soft delete a government document' })
  async removeGovernmentDocument(@Param('id', ParseUUIDPipe) id: string, @Req() req: any): Promise<void> {
    await this.assayerService.removeGovernmentDocument(id, req.user.id);
  }

  // Assayer Documents
  @Post(':assayerId/document')
  @HttpCode(201)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Upload a new versioned document for an assayer' })
  async addAssayerDocument(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Body() dto: CreateAssayerDocumentRequestDto,
    @Req() req: any,
  ) {
    const doc = await this.assayerService.addAssayerDocument(assayerId, dto, req.user.id);
    return { success: true, data: doc };
  }

  @Put(':assayerId/document/:docId')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Update document metadata' })
  async updateAssayerDocument(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @Body() dto: UpdateAssayerDocumentRequestDto,
    @Req() req: any,
  ) {
    const doc = await this.assayerService.updateAssayerDocument(docId, dto, req.user.id);
    return { success: true, data: doc };
  }

  @Get(':assayerId/document')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'List documents for an assayer' })
  async getAssayerDocuments(@Param('assayerId', ParseUUIDPipe) assayerId: string) {
    const docs = await this.assayerService.getAssayerDocuments(assayerId);
    return { success: true, data: docs };
  }

  @Delete('document/:id')
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Soft delete an assayer document' })
  async removeAssayerDocument(@Param('id', ParseUUIDPipe) id: string, @Req() req: any): Promise<void> {
    await this.assayerService.removeAssayerDocument(id, req.user.id);
  }

  // Remarks
  @Post(':assayerId/remark')
  @HttpCode(201)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Add a remark to an assayer profile' })
  async addRemark(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Body() dto: CreateRemarkRequestDto,
    @Req() req: any,
  ) {
    const remark = await this.assayerService.addRemark(assayerId, dto, req.user.id, req.user.name || req.user.email);
    return { success: true, data: remark };
  }

  @Put(':assayerId/remark/:remarkId')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Update a remark' })
  async updateRemark(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Param('remarkId', ParseUUIDPipe) remarkId: string,
    @Body() dto: UpdateRemarkRequestDto,
    @Req() req: any,
  ) {
    const remark = await this.assayerService.updateRemark(remarkId, dto, req.user.id);
    return { success: true, data: remark };
  }

  @Delete(':assayerId/remark/:remarkId')
  @HttpCode(204)
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Delete a remark' })
  async removeRemark(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Param('remarkId', ParseUUIDPipe) remarkId: string,
    @Req() req: any,
  ): Promise<void> {
    await this.assayerService.removeRemark(remarkId, req.user.id);
  }

  @Get(':assayerId/remark')
  @ApiOperation({ summary: 'List remarks for an assayer' })
  async getRemarks(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Query('visibility') visibility?: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    const { remarks, total } = await this.assayerService.getRemarks(assayerId, visibility, page, limit);
    return {
      success: true,
      data: remarks,
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

  // Activity Timeline
  @Get(':assayerId/activity')
  @ApiOperation({ summary: 'Get activity timeline for an assayer' })
  async getActivityTimeline(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    const { activities, total } = await this.assayerService.getActivityTimeline(assayerId, page, limit);
    return {
      success: true,
      data: activities,
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
}

