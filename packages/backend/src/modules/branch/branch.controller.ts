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
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiBody, ApiQuery } from '@nestjs/swagger';
import { Region } from '@fapoms/shared';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { MAX_UPLOAD_BYTES } from '../document/upload-validation';
import { ParseLimitPipe } from '../../infrastructure/http/parse-limit.pipe';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsBoolean, Min, IsObject, IsUUID } from 'class-validator';

/**
 * Same shape as `documentUploadMulterOptions` in document.controller.ts: multer's own `limits`
 * enforced at the streaming layer, capped to the same `MAX_UPLOAD_BYTES` the app-level checks use,
 * so a request this large is rejected mid-stream rather than fully buffered into memory first.
 */
const branchUploadMulterOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
};
import { BranchService, CreateBranchDto, UpdateBranchDto, CreateContactDto, UpdateContactDto, CreateDocumentDto } from './branch.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole } from '@fapoms/shared';

class CreateBranchRequestDto implements CreateBranchDto {
  /** The SOL ID — the branch's single unique identifier, required (a bank file's "BRANCH" column). */
  @IsString() @IsNotEmpty() solId: string;
  @IsString() @IsNotEmpty() name: string;
  /**
   * Address, district and city are optional on admission; state is not.
   *
   * The branch importer has always drawn the line here — it refuses a row only for a missing
   * name, code or state, because state is what sets the region, zone and public-holiday calendar
   * a branch is planned against. Requiring three more fields on the manual form meant a branch
   * that imports cleanly could not be typed in by hand, and the operator's workaround for a
   * client list that omits the town is to invent one.
   */
  @IsOptional() @IsString() address?: string;
  @IsString() @IsNotEmpty() state: string;
  @IsOptional() @IsString() district?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() pincode?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() territory?: string;
  @IsOptional() @IsUUID() zoneId?: string;
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
  @IsOptional() @IsObject() operatingHours?: Record<string, any>;
}

/**
 * `zoneId` is validated as a UUID rather than a bare string on both DTOs. A malformed id used to
 * reach Postgres and come back as a 500 "Internal server error"; the id of a zone that does not
 * exist has always been answered properly ("Zone … not found."), and a value that is not an id at
 * all should be answered the same way rather than as a crash.
 */
class UpdateBranchRequestDto implements UpdateBranchDto {
  @IsOptional() @IsString() solId?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() district?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() pincode?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() territory?: string;
  @IsOptional() @IsUUID() zoneId?: string;
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
  @IsOptional() @IsObject() operatingHours?: Record<string, any>;
}

class CreateContactRequestDto implements CreateContactDto {
  @IsString() @IsNotEmpty() name: string;
  @IsString() @IsNotEmpty() email: string;
  @IsString() @IsNotEmpty() phone: string;
  // Relaxed, not removed: a contact known only by a phone number can now be recorded. Callers
  // that send a designation are unaffected.
  @IsOptional() @IsString() designation?: string;
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
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
// Internal book: staff only. Individual routes narrow this further.
@Roles(...STAFF_ROLES)
@Controller('branches')
export class BranchController {
  constructor(
    private readonly branchService: BranchService,
    private readonly regionGuard: RegionGuardService,
  ) {}

  // -----------------------------------------------------------------------
  // Profile
  // -----------------------------------------------------------------------

  @Post()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('branch:create:organization')
  @ApiOperation({ summary: 'Create a new branch' })
  async create(@Body() dto: CreateBranchRequestDto, @Req() req: any) {
    const branch = await this.branchService.create(dto, req.user.id, req.user.organizationId);
    return { success: true, data: branch };
  }

  @Get()
  @ApiOperation({ summary: 'List branches under the global scope filter' })
  @ApiQuery({ name: 'clientId', required: false })
  @ApiQuery({ name: 'region', required: false, enum: Region })
  @ApiQuery({ name: 'zoneId', required: false })
  @ApiQuery({ name: 'state', required: false })
  @ApiQuery({ name: 'search', required: false, description: 'Matches branch name, code, SOL ID or city.' })
  @ApiQuery({ name: 'risk', required: false })
  @ApiQuery({ name: 'type', required: false })
  async findAll(
    @Query('page') page = 1,
    // Bounded here rather than trusted from the caller: this list feeds a table, and the page
    // that reads it used to ask for a thousand rows at a time and filter them in the browser.
    // ParseLimitPipe keeps the previous 1-200 range and 20 default; see parse-limit.pipe.ts.
    @Query('limit', new ParseLimitPipe({ default: 20, max: 200 })) limit: number,
    @GlobalScopeFilter() scope?: GlobalScope,
    @Query('search') search?: string,
    @Query('risk') risk?: string,
    @Query('type') type?: string,
  ) {
    const safeLimit = limit;
    const safePage = Math.max(1, Number(page) || 1);
    const { branches, total } = await this.branchService.findAll(
      safePage, safeLimit, scope, { search, risk, type },
    );
    return {
      success: true,
      data: branches,
      meta: {
        pagination: {
          page: safePage, limit: safeLimit, total,
          totalPages: Math.ceil(total / safeLimit),
          hasNext: safePage * safeLimit < total,
          hasPrevious: safePage > 1,
        },
      },
    };
  }

  @Get('summary')
  @ApiOperation({ summary: 'Counts for the branch list header, over the same filters as the list' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'risk', required: false })
  @ApiQuery({ name: 'type', required: false })
  async summary(
    @GlobalScopeFilter() scope?: GlobalScope,
    @Query('search') search?: string,
    @Query('risk') risk?: string,
    @Query('type') type?: string,
  ) {
    return { success: true, data: await this.branchService.summary(scope, { search, risk, type }) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get branch with contacts and documents' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @GlobalScopeFilter() scope?: GlobalScope) {
    const branch = await this.branchService.findOne(id);
    // The list is narrowed; this is the ceiling. Branch ids travel in payloads and bookmarks,
    // so without it the narrowing is discovery-only and any known id reads the record.
    this.regionGuard.assertRegionAllowed(branch.region, scope);
    return { success: true, data: branch };
  }

  @Put(':id')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('branch:edit:organization')
  @ApiOperation({ summary: 'Update branch details' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBranchRequestDto, @Req() req: any) {
    const branch = await this.branchService.update(id, dto, req.user.id);
    return { success: true, data: branch };
  }

  @Delete(':id')
  @Roles(SystemRole.ADMIN)
  @RequirePermissions('branch:delete:organization')
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('branch:create:organization')
  @ApiOperation({ summary: 'Add branch contact' })
  async addContact(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateContactRequestDto, @Req() req: any) {
    const contact = await this.branchService.addContact(id, dto, req.user.id);
    return { success: true, data: contact };
  }

  @Put(':id/contacts/:contactId')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('branch:edit:organization')
  @ApiOperation({ summary: 'Update branch contact' })
  async updateContact(@Param('contactId', ParseUUIDPipe) contactId: string, @Body() dto: UpdateContactRequestDto, @Req() req: any) {
    const contact = await this.branchService.updateContact(contactId, dto, req.user.id);
    return { success: true, data: contact };
  }

  @Delete(':id/contacts/:contactId')
  @Roles(SystemRole.ADMIN)
  @RequirePermissions('branch:delete:organization')
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('branch:create:organization')
  @ApiOperation({ summary: 'Add branch document' })
  async addDocument(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateDocumentRequestDto, @Req() req: any) {
    const doc = await this.branchService.addDocument(id, dto, req.user.id);
    return { success: true, data: doc };
  }

  @Delete(':id/documents/:documentId')
  @Roles(SystemRole.ADMIN)
  @RequirePermissions('branch:delete:organization')
  @ApiOperation({ summary: 'Remove branch document' })
  async removeDocument(@Param('documentId', ParseUUIDPipe) documentId: string, @Req() req: any) {
    await this.branchService.removeDocument(documentId, req.user.id);
    return { success: true, data: { message: 'Document removed successfully' } };
  }

  // -----------------------------------------------------------------------
  // Excel Import
  // -----------------------------------------------------------------------

  /**
   * `POST /branches/import/:clientId` now lives in `project/branch-import.controller.ts`.
   *
   * It was served here by `BranchService.importExcel`, a second branch-sheet importer that ran a
   * geography check, a `findOne` and a geocode per row inside the HTTP request. The queued
   * importer already existed one module away and did the same work with prefetching, progress and
   * per-row reasons; `BranchModule` simply could not reach it, because `ProjectModule` imports
   * this one. Both doors now open onto that single implementation.
   */
}
