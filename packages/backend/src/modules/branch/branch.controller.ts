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
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsBoolean, Min } from 'class-validator';
import { BranchService, CreateBranchDto, UpdateBranchDto, CreateContactDto, UpdateContactDto, CreateDocumentDto } from './branch.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

class CreateBranchRequestDto implements CreateBranchDto {
  @IsString() @IsNotEmpty() branchCode: string;
  @IsOptional() @IsString() solId?: string;
  @IsString() @IsNotEmpty() name: string;
  @IsString() @IsNotEmpty() address: string;
  @IsString() @IsNotEmpty() state: string;
  @IsString() @IsNotEmpty() district: string;
  @IsString() @IsNotEmpty() city: string;
  @IsOptional() @IsString() pincode?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() territory?: string;
  @IsOptional() @IsString() zoneId?: string;
  @IsOptional() @IsString() branchType?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() managerName?: string;
  @IsOptional() @IsString() openingDate?: string;
  @IsOptional() @IsString() lastAuditDate?: string;
  @IsOptional() @IsNumber() latitude?: number;
  @IsOptional() @IsNumber() longitude?: number;
  @IsOptional() @IsString() clientId?: string;
  @IsOptional() @IsNumber() riskScore?: number;
  @IsOptional() @IsString() riskCategory?: string;
  @IsOptional() @IsString() complexity?: string;
  @IsOptional() @IsNumber() estimatedDurationHours?: number;
  @IsOptional() @IsString({ each: true }) requiredCompetencies?: string[];
}

class UpdateBranchRequestDto implements UpdateBranchDto {
  @IsOptional() @IsString() branchCode?: string;
  @IsOptional() @IsString() solId?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() district?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() pincode?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() territory?: string;
  @IsOptional() @IsString() zoneId?: string;
  @IsOptional() @IsString() branchType?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() managerName?: string;
  @IsOptional() @IsString() openingDate?: string;
  @IsOptional() @IsString() lastAuditDate?: string;
  @IsOptional() @IsNumber() latitude?: number;
  @IsOptional() @IsNumber() longitude?: number;
  @IsOptional() @IsString() clientId?: string;
  @IsOptional() @IsNumber() riskScore?: number;
  @IsOptional() @IsString() riskCategory?: string;
  @IsOptional() @IsString() complexity?: string;
  @IsOptional() @IsNumber() estimatedDurationHours?: number;
  @IsOptional() @IsString({ each: true }) requiredCompetencies?: string[];
}

class CreateContactRequestDto implements CreateContactDto {
  @IsString() @IsNotEmpty() name: string;
  @IsString() @IsNotEmpty() email: string;
  @IsString() @IsNotEmpty() phone: string;
  @IsString() @IsNotEmpty() designation: string;
  @IsOptional() @IsString() department?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
  @IsOptional() @IsString() notes?: string;
}

class UpdateContactRequestDto implements UpdateContactDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() designation?: string;
  @IsOptional() @IsString() department?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
  @IsOptional() @IsString() notes?: string;
}

class CreateDocumentRequestDto implements CreateDocumentDto {
  @IsString() @IsNotEmpty() fileName: string;
  @IsString() @IsNotEmpty() filePath: string;
  @IsNumber() @Min(0) fileSize: number;
  @IsOptional() @IsString() mimeType?: string;
  @IsString() @IsNotEmpty() category: string;
  @IsOptional() @IsString() remarks?: string;
}

@ApiTags('Branches')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('branches')
export class BranchController {
  constructor(private readonly branchService: BranchService) {}

  // -----------------------------------------------------------------------
  // Profile
  // -----------------------------------------------------------------------

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Create a new branch' })
  async create(@Body() dto: CreateBranchRequestDto, @Req() req: any) {
    const branch = await this.branchService.create(dto, req.user.id);
    return { success: true, data: branch };
  }

  @Get()
  @ApiOperation({ summary: 'List branches with filters' })
  async findAll(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Query('clientId') clientId?: string,
    @Query('region') region?: string,
    @Query('zoneId') zoneId?: string,
  ) {
    const { branches, total } = await this.branchService.findAll(page, limit, clientId, region, zoneId);
    return {
      success: true,
      data: branches,
      meta: {
        pagination: {
          page, limit, total,
          totalPages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrevious: page > 1,
        },
      },
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get branch with contacts and documents' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const branch = await this.branchService.findOne(id);
    return { success: true, data: branch };
  }

  @Put(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Update branch details' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBranchRequestDto, @Req() req: any) {
    const branch = await this.branchService.update(id, dto, req.user.id);
    return { success: true, data: branch };
  }

  @Delete(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Soft delete branch' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.branchService.remove(id, req.user.id);
    return { success: true, data: { message: 'Branch deleted successfully' } };
  }

  // -----------------------------------------------------------------------
  // Contacts
  // -----------------------------------------------------------------------

  @Get(':id/contacts')
  @ApiOperation({ summary: 'List branch contacts' })
  async findContacts(@Param('id', ParseUUIDPipe) id: string) {
    const contacts = await this.branchService.findContacts(id);
    return { success: true, data: contacts };
  }

  @Post(':id/contacts')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Add branch contact' })
  async addContact(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateContactRequestDto, @Req() req: any) {
    const contact = await this.branchService.addContact(id, dto, req.user.id);
    return { success: true, data: contact };
  }

  @Put(':id/contacts/:contactId')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Update branch contact' })
  async updateContact(@Param('contactId', ParseUUIDPipe) contactId: string, @Body() dto: UpdateContactRequestDto, @Req() req: any) {
    const contact = await this.branchService.updateContact(contactId, dto, req.user.id);
    return { success: true, data: contact };
  }

  @Delete(':id/contacts/:contactId')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Remove branch contact' })
  async removeContact(@Param('contactId', ParseUUIDPipe) contactId: string, @Req() req: any) {
    await this.branchService.removeContact(contactId, req.user.id);
    return { success: true, data: { message: 'Contact removed successfully' } };
  }

  // -----------------------------------------------------------------------
  // Documents
  // -----------------------------------------------------------------------

  @Get(':id/documents')
  @ApiOperation({ summary: 'List branch documents' })
  async findDocuments(@Param('id', ParseUUIDPipe) id: string) {
    const documents = await this.branchService.findDocuments(id);
    return { success: true, data: documents };
  }

  @Post(':id/documents')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Add branch document' })
  async addDocument(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateDocumentRequestDto, @Req() req: any) {
    const doc = await this.branchService.addDocument(id, dto, req.user.id);
    return { success: true, data: doc };
  }

  @Delete(':id/documents/:documentId')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Remove branch document' })
  async removeDocument(@Param('documentId', ParseUUIDPipe) documentId: string, @Req() req: any) {
    await this.branchService.removeDocument(documentId, req.user.id);
    return { success: true, data: { message: 'Document removed successfully' } };
  }

  // -----------------------------------------------------------------------
  // Excel Import
  // -----------------------------------------------------------------------

  @Post('import/:clientId')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Import branches from Excel' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  async importExcel(
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) {
      return { success: false, error: 'No file uploaded.' };
    }
    const result = await this.branchService.importExcel(file.buffer, clientId, req.user.id);
    return { success: true, data: result };
  }
}
