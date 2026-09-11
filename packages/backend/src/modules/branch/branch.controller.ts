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
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Region } from '@fapoms/shared';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { ParseLimitPipe } from '../../infrastructure/http/parse-limit.pipe';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsBoolean, Min, IsObject, IsUUID } from 'class-validator';
import {
  BranchService, CreateBranchDto, UpdateBranchDto, CreateContactDto, UpdateContactDto, CreateDocumentDto,
  branchRegionAtCreate, branchRegionAfterUpdate,
} from './branch.service';
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
  async create(
    @Body() dto: CreateBranchRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    /**
     * There is no existing record to anchor on, so the ceiling is checked against the region this
     * request is ASKING FOR — resolved by the same function `BranchService.create` is about to
     * use, so the guard and the write can never disagree about what "the region" means.
     *
     * Verified live before this existed: an EAST-assigned OPERATIONS account posted
     * `{ state: 'Maharashtra', region: 'WEST' }` and got 201 with a branch it could not then read
     * (`GET /branches/<new id>` → 403). Creating work in a region you are refused sight of is the
     * same defect as editing it there, one step earlier.
     */
    this.regionGuard.assertRegionSettable(branchRegionAtCreate(dto), scope);
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
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBranchRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // The region ceiling `GET :id` enforces must also gate the WRITE — otherwise a region-restricted
    // operator refused reading a branch in another region could still edit it (the same read/write
    // asymmetry found on the schedule transition). Branches are the region anchor, so assert by id.
    await this.regionGuard.assertBranchInScope(id, scope);
    /**
     * …and the region this edit is MOVING IT TO, which is the other half and was missing.
     *
     * The assertion above reads the branch's current region. `BranchService.update` then
     * overwrites `branch.region` from `dto.region` (or from `dto.state`, which the region
     * follows) with nothing checking the new value. So a scoped operator could take a branch
     * inside their own ceiling and push it out of it: region laundering, and the loss is
     * permanent from their side — the row is now invisible to the only account that was
     * looking at it. Confirmed live: an EAST-assigned OPERATIONS account sent
     * `PUT /branches/<east id> {"region":"WEST"}`, got 200, and `branches.region` read `WEST`;
     * `{"state":"Maharashtra"}` did the same thing without naming a region at all.
     *
     * Both checks run before `branchService.update`, so an out-of-scope caller is refused before
     * any state validation — a 403 about access, not a 400 about a SOL ID they were never
     * entitled to be told about.
     */
    const current = await this.branchService.regionAnchorOf(id);
    this.regionGuard.assertRegionSettable(branchRegionAfterUpdate(dto, current), scope);
    const branch = await this.branchService.update(id, dto, req.user.id);
    return { success: true, data: branch };
  }

  @Delete(':id')
  @Roles(SystemRole.ADMIN)
  @RequirePermissions('branch:delete:organization')
  @ApiOperation({ summary: 'Soft delete branch' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // Same region ceiling as the read/update above — a region-restricted ADMIN must not delete an
    // out-of-region branch it cannot see.
    await this.regionGuard.assertBranchInScope(id, scope);
    await this.branchService.remove(id, req.user.id);
    return { success: true, data: { message: 'Branch deleted successfully' } };
  }

  // -----------------------------------------------------------------------
  // Contacts
  // -----------------------------------------------------------------------

  /**
   * The contact and document routes below all carry the branch's own ceiling.
   *
   * They are the branch's child rows: a contact is a named person at a bank branch with their
   * direct line, a document is that branch's paperwork. `GET /branches/:id` is 403 across the
   * region boundary, so reading and writing this branch's contents through a nested route must be
   * too — otherwise the ceiling is only on the parent's own columns, which is not a boundary.
   *
   * Note WHICH id each one asserts on. The three routes keyed on a child id (`:contactId`,
   * `:documentId`) assert on the CHILD, not on the `:id` in the path, because the handlers load
   * by the child id alone — `branchService.updateContact(contactId, …)` never looks at `:id`. A
   * guard on the path's branch id would have been satisfied by any branch the caller does hold
   * while the row it actually edits sits in a region they do not. `assertBranchContactInScope`
   * and `assertBranchDocumentInScope` exist for exactly this and were what these routes lacked.
   */
  @Get(':id/contacts')
  @ApiOperation({ summary: 'List branch contacts' })
  async findContacts(@Param('id', ParseUUIDPipe) id: string, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.regionGuard.assertBranchInScope(id, scope);
    const contacts = await this.branchService.findContacts(id);
    return { success: true, data: contacts };
  }

  @Post(':id/contacts')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('branch:create:organization')
  @ApiOperation({ summary: 'Add branch contact' })
  async addContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateContactRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertBranchInScope(id, scope);
    const contact = await this.branchService.addContact(id, dto, req.user.id);
    return { success: true, data: contact };
  }

  @Put(':id/contacts/:contactId')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('branch:edit:organization')
  @ApiOperation({ summary: 'Update branch contact' })
  async updateContact(
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() dto: UpdateContactRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertBranchContactInScope(contactId, scope);
    const contact = await this.branchService.updateContact(contactId, dto, req.user.id);
    return { success: true, data: contact };
  }

  @Delete(':id/contacts/:contactId')
  @Roles(SystemRole.ADMIN)
  @RequirePermissions('branch:delete:organization')
  @ApiOperation({ summary: 'Remove branch contact' })
  async removeContact(
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertBranchContactInScope(contactId, scope);
    await this.branchService.removeContact(contactId, req.user.id);
    return { success: true, data: { message: 'Contact removed successfully' } };
  }

  // -----------------------------------------------------------------------
  // Documents
  // -----------------------------------------------------------------------

  @Get(':id/documents')
  @ApiOperation({ summary: 'List branch documents' })
  async findDocuments(@Param('id', ParseUUIDPipe) id: string, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.regionGuard.assertBranchInScope(id, scope);
    const documents = await this.branchService.findDocuments(id);
    return { success: true, data: documents };
  }

  @Post(':id/documents')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('branch:create:organization')
  @ApiOperation({ summary: 'Add branch document' })
  async addDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateDocumentRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertBranchInScope(id, scope);
    const doc = await this.branchService.addDocument(id, dto, req.user.id);
    return { success: true, data: doc };
  }

  @Delete(':id/documents/:documentId')
  @Roles(SystemRole.ADMIN)
  @RequirePermissions('branch:delete:organization')
  @ApiOperation({ summary: 'Remove branch document' })
  async removeDocument(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertBranchDocumentInScope(documentId, scope);
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
