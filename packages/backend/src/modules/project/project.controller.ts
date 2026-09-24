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
  HttpCode,
  ForbiddenException,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';

import { IsString, IsNotEmpty, IsOptional, IsNumber, IsArray, IsObject, ArrayNotEmpty, IsUUID, IsDateString, IsEnum, MaxLength, Min, Validate, ValidatorConstraint, ValidatorConstraintInterface, ValidationArguments } from 'class-validator';
import { Transform } from 'class-transformer';
import { ProjectService, CreateProjectDto } from './project.service';
import { ASSIGNED_ASSIGNMENT_STATUSES } from '../assignment/assignment-workload';
import { BranchImportJob } from './branch-import/branch-import.job';
import { branchImportUploadOptions, CommitBranchImportDto, incomingFile } from './branch-import.controller';
import { readerFrom } from '../../infrastructure/background-jobs/background-jobs.controller';
import { jobActorFrom } from '../../infrastructure/queue/job-actor';
import { DiskUploadScanInterceptor } from '../document/disk-upload-scan.interceptor';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, RolesFallbackPermissions } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole, Priority, ProjectStatus } from '@fapoms/shared';
import { GlobalScopeFilter, GlobalScope, assignedRegions } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { ParseLimitPipe } from '../../infrastructure/http/parse-limit.pipe';

/**
 * Trim before validating, so a field of spaces fails `@IsNotEmpty` like the empty string it is.
 *
 * Without it `"   "` is a non-empty string to class-validator and to the browser's `required`
 * attribute alike, and a project could be created whose name renders as a blank row in every list
 * and as a nameless option in every picker.
 */
const TrimmedString = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/**
 * An audit window that ends before it starts is not a window.
 *
 * It was accepted, and the projects list then labelled the brand-new project "13d overdue" —
 * a false alarm on the same screen operations uses to triage what is actually late.
 */
@ValidatorConstraint({ name: 'endsAfterStart', async: false })
class EndsAfterStartConstraint implements ValidatorConstraintInterface {
  validate(endDate: string | undefined, args: ValidationArguments) {
    const startDate = (args.object as { startDate?: string }).startDate;
    if (!endDate || !startDate) return true;
    return new Date(endDate).getTime() >= new Date(startDate).getTime();
  }

  defaultMessage() {
    return 'endDate must be on or after startDate';
  }
}

export class CreateProjectRequestDto implements CreateProjectDto {
  @IsString() @TrimmedString() @IsNotEmpty() @MaxLength(255) name: string;
  /**
   * Optional: left blank, the service allocates the next `PRJ-<year>-###`. Backward-compatible —
   * a number that is sent is still used verbatim; only its absence is newly accepted.
   */
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsUUID() clientId: string;
  // Was @IsString()/@MaxLength(50): any string reached `riskScoreFromCategory`
  // (project.service.ts), which silently falls through to LOW risk for anything it does not
  // recognise — a malformed direct API call could create a CRITICAL-sounding project the risk
  // map quietly treats as the lowest tier. `Projects.tsx`'s own dropdown only ever sends a
  // `Priority` enum member, so this closes the gap without touching working UI behaviour.
  @IsEnum(Priority) priority: string;
  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() @Validate(EndsAfterStartConstraint) endDate?: string;
  @IsOptional() @IsNumber() @Min(0) budget?: number;
  @IsOptional() @IsString() @MaxLength(5000) scope?: string;
  @IsOptional() @IsArray() requiredSkills?: string[];
  @IsOptional() @IsArray() requiredCertifications?: string[];
  @IsOptional() @IsObject() sla?: Record<string, any>;
  @IsOptional() @IsObject() risks?: Record<string, any>;
  @IsOptional() @IsObject() milestones?: Record<string, any>;
  @IsOptional() @IsObject() dependencies?: Record<string, any>;
  // Never actually read by ProjectService.create — a new project always starts at DRAFT — but
  // still worth constraining to the real ProjectStatus enum rather than an unchecked string.
  @IsOptional() @IsEnum(ProjectStatus) status?: string;
}

/**
 * Partial update. Every field is optional so a caller can change one thing without
 * resending — and without overwriting — the rest of the record.
 */
export class UpdateProjectRequestDto {
  @IsOptional() @IsString() @TrimmedString() @IsNotEmpty() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsUUID() clientId?: string;
  // Same reasoning as CreateProjectRequestDto.priority above.
  @IsOptional() @IsEnum(Priority) priority?: string;
  @IsOptional() @IsDateString() startDate?: string;
  // Same window rule as create — an edit must not be able to invert what create refused.
  @IsOptional() @IsDateString() @Validate(EndsAfterStartConstraint) endDate?: string;
  @IsOptional() @IsNumber() @Min(0) budget?: number;
  @IsOptional() @IsString() @MaxLength(5000) scope?: string;
  @IsOptional() @IsArray() requiredSkills?: string[];
  @IsOptional() @IsArray() requiredCertifications?: string[];
  @IsOptional() @IsObject() sla?: Record<string, any>;
  @IsOptional() @IsObject() risks?: Record<string, any>;
  @IsOptional() @IsObject() milestones?: Record<string, any>;
  @IsOptional() @IsObject() dependencies?: Record<string, any>;
}

/** A lifecycle move, with the reason recorded on the audit trail. */
class TransitionProjectRequestDto {
  @IsString() @IsNotEmpty() targetStatus: string;
  @IsOptional() @IsString() reason?: string;
}

/** Attaching existing branches to a project. */
class AddProjectBranchesRequestDto {
  @IsArray() @ArrayNotEmpty() @IsUUID('4', { each: true })
  branchIds: string[];
}

class MarkUnableToCoverRequestDto {
  // Required, not optional: this status exists so the cause is reportable to the client.
  @IsString() @IsNotEmpty() reason: string;
}

@ApiTags('Projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
// Internal book: staff only. Individual routes narrow this further.
@Roles(...STAFF_ROLES)
@Controller('projects')
export class ProjectController {
  constructor(
    private readonly projectService: ProjectService,
    private readonly branchImport: BranchImportJob,
    // The UserEntity repository that used to be injected here existed only to resolve
    // `negotiatedByName` on the branches queue; it left with in-app fee negotiation.
    private readonly regionGuard: RegionGuardService,
  ) {}

  @Post()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('project:create:organization')
  @ApiOperation({ summary: 'Create a new project linked to a client institution' })
  async create(@Body() dto: CreateProjectRequestDto, @Req() req: any) {
    const project = await this.projectService.create(dto, req.user.id, req.user.organizationId);
    return project;
  }

  // Was @Public(): the entire project portfolio was readable without a token.
  // The controller-level staff gate now applies.
  @Get()
  // A role built in Admin → Roles holding project:view reads the list (region-scoped by `scope`
  // below like everyone else). Fallback-only, not @RequirePermissions: PermissionsGuard would
  // enforce that on every STAFF_ROLES caller, some of whom hold no grants at all.
  @RolesFallbackPermissions('project:view:organization')
  @ApiOperation({ summary: 'Get paginated list of projects' })
  async findAll(
    @Query('page') page?: number,
    // `projectQueryService.findAll`'s `take: limit` had no ceiling, and the controller echoed
    // the requested number straight back in meta. ParseLimitPipe keeps the existing default 50.
    @Query('limit', new ParseLimitPipe({ default: 50, max: 200 })) limit?: number,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // `limit` has already been through ParseLimitPipe, so it is a positive integer inside the
    // ceiling. Re-deriving it here is what let meta report a number the query never used.
    const result = await this.projectService.findAll(page ? Number(page) : 1, limit, scope);
    return {
      success: true,
      data: result.projects,
      meta: {
        pagination: {
          page: page ? Number(page) : 1,
          limit,
          total: result.total,
        },
      },
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details for a single project by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @GlobalScopeFilter() scope?: GlobalScope) {
    const project = await this.projectService.findOne(id);
    /**
     * The detail row is readable exactly when the list would offer it: a region-assigned caller
     * sees a project with at least one active branch in their regions (`GET /projects` asks the
     * same question, through the same `findAll` predicate, so the two cannot drift). Not
     * `assertProjectInScope` — that refuses a project with ANY branch elsewhere, which would lock
     * a regional operator out of the national project their own branches sit in. Only the
     * account's region ceiling is applied; the header's zone/state convenience filters are not
     * an authorisation fact and must not turn an open into a 403.
     */
    if (scope?.regions?.length) {
      const visible = await this.projectService.findAll(1, 1, { regions: scope.regions, projectId: id });
      if (visible.total === 0) {
        throw new ForbiddenException('This project has no branches in the regions your account is assigned to.');
      }
    }
    return project;
  }

  @Put(':id')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('project:edit:organization')
  @ApiOperation({ summary: 'Update project details' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // A project-wide write: refused if the project reaches any branch outside the caller's
    // regions — the rule `assertProjectInScope` states for every whole-project operation.
    await this.regionGuard.assertProjectInScope(id, scope);
    const project = await this.projectService.update(id, dto, req.user.id);
    return project;
  }

  // Lifecycle moves used to ride on PUT, which meant resending the whole project
  // to change one field and produced a generic "updated" audit entry. This states
  // the intent, validates against the state machine, and records why.
  @Post(':id/transition')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('project:edit:organization')
  @ApiOperation({ summary: 'Move a project to another lifecycle status' })
  async transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionProjectRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // Same ceiling as `update`: a lifecycle move is a whole-project operation.
    await this.regionGuard.assertProjectInScope(id, scope);
    const project = await this.projectService.transition(id, dto.targetStatus, req.user.id, dto.reason);
    return project;
  }

  @Delete(':id')
  @Roles(SystemRole.ADMIN)
  @RequirePermissions('project:delete:organization')
  @ApiOperation({ summary: 'Soft delete a project' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.projectService.remove(id, req.user.id);
    return { message: 'Project deleted successfully' };
  }

  // Was @Public() — anyone reaching the API could read every project branch's assignment
  // fees and negotiation state without authenticating. Fixed alongside adding operator
  // attribution below, since that made the gap more consequential (it would have exposed
  // which staff member is handling which negotiation to an unauthenticated caller too).
  // Any staff role that can see the book can ask how a branch got where it is;
  // this is read-only history, and "why is this branch CLOSED" is a question
  // planning, validation and audit all legitimately need to answer.
  @Get('branches/:projectBranchId/history')
  @ApiOperation({ summary: 'Full timeline for one project branch: status, assignments, documents, validation' })
  async getBranchHistory(
    @Param('projectBranchId', ParseUUIDPipe) projectBranchId: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // Full history of one branch — status, assignments, fees, negotiation. Region-ceilinged
    // like every other detail read: the coverage list is narrowed, so this must be too.
    await this.regionGuard.assertProjectBranchInScope(projectBranchId, scope);
    return await this.projectService.getBranchHistory(projectBranchId);
  }

  // Declaring a branch unstaffable is an operational decision with client-SLA consequences,
  // so it sits with the roles that own coverage — not with everyone who can read the book.
  @Post('branches/:projectBranchId/unable-to-cover')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('project:edit:organization')
  @ApiOperation({ summary: 'Record that a branch cannot be staffed, with a reason' })
  async markBranchUnableToCover(
    @Param('projectBranchId', ParseUUIDPipe) projectBranchId: string,
    @Body() dto: MarkUnableToCoverRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    /**
     * The same ceiling `getBranchHistory` asserts on this exact id, one route above.
     *
     * Declaring a branch unstaffable is a client-facing coverage decision — it is what the
     * coverage report shows the bank as the reason their branch was not audited — and a
     * region-scoped operator could make it for a branch in another region that they are refused
     * a plain `GET /projects/branches/:id/history` on. Confirmed live: `cert_ops_east` marked a
     * Maharashtra project branch unable-to-cover, 201, and could not then read the row it wrote.
     */
    await this.regionGuard.assertProjectBranchInScope(projectBranchId, scope);
    return await this.projectService.markBranchUnableToCover(projectBranchId, req.user.id, dto.reason);
  }

  @Post('branches/:projectBranchId/reopen-coverage')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('project:edit:organization')
  @ApiOperation({ summary: 'Return an uncoverable branch to the planning pool' })
  async reopenBranchCoverage(
    @Param('projectBranchId', ParseUUIDPipe) projectBranchId: string,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // The undo of `unable-to-cover`, and it had the identical hole: putting another region's
    // branch back into the planning pool is as much a coverage decision as taking it out.
    await this.regionGuard.assertProjectBranchInScope(projectBranchId, scope);
    return await this.projectService.reopenBranchCoverage(projectBranchId, req.user.id);
  }

  /**
   * Must admit every role the frontend `/projects` route allows, or the page's detail pane 403s.
   *
   * This listed five roles against the page's eleven, and `Projects.tsx` loads the project and
   * its branches inside one `try`, so the 403 on the second call landed in a `catch` that does
   * `setDetail(null)`. Six roles — validation, data entry, documents, finance, HR — could open
   * `/projects`, click a project, and get an empty pane with nothing but a console error. The
   * page's own comment says why they need it: "Everyone who works the book needs to see which
   * project a branch belongs to."
   *
   * Reading which branches sit in a project is not a privileged act; `STAFF_ROLES` already gates
   * `GET /projects` and `GET /projects/:id` on this same controller.
   */
  @Get(':id/branches')
  @Roles(...STAFF_ROLES)
  @ApiOperation({ summary: 'Get unassigned and planning branches queue for project' })
  async getProjectBranches(
    @Param('id', ParseUUIDPipe) id: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    const branches = await this.projectService.findProjectBranches(id, scope);

    // Sorted-descending most-recently-touched assignment per branch, computed once and reused
    // below rather than recomputed per field.
    const activeAssignmentByBranch = new Map(
      branches.map(b => [
        b.id,
        b.assignments
          // "Whose branch is this?" — the shared set. The Command Centre's branch query and the
          // coverage workbook ask the same question and used to carry their own copies of it.
          ?.filter(a => (ASSIGNED_ASSIGNMENT_STATUSES as string[]).includes(a.status))
          ?.sort((a, b2) => new Date(b2.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
          ?.[0],
      ]),
    );

    const data = branches.map(b => {
      const activeAssignment = activeAssignmentByBranch.get(b.id);
      return {
        ...b,
        assignment: activeAssignment ? {
          id: activeAssignment.id,
          status: activeAssignment.status,
          proposedFee: activeAssignment.proposedFee,
          agreedFee: activeAssignment.agreedFee,
          /**
           * The breakdown behind `proposedFee`, so the desk can see what a number is MADE of.
           *
           * Only the total was sent, and the counter-offer modal seeded its input from it while
           * submitting that value as `counterTravelFee` — travel only. Every counter therefore
           * re-proposed base + the whole previous total, and the screen could not show the base
           * fee it was silently inflating because it had never been told it.
           *
           * `counterTravelFee` is whatever travel figure is currently on the table (null until
           * somebody counters); `quotedTravelFee` is what the rate card originally priced.
           */
          quotedBaseFee: activeAssignment.quotedBaseFee,
          quotedTravelFee: activeAssignment.quotedTravelFee,
          counterTravelFee: activeAssignment.counterTravelFee,
          scheduledDate: activeAssignment.scheduledDate,
          remarks: activeAssignment.remarks,
          // `negotiatedByName` (and the users query that resolved it) left with in-app fee
          // negotiation: there is no negotiation for a colleague to own any more, so the
          // per-request name lookup was a cost with no reader. `negotiationCount` stays for one
          // release as a historical fact — the operations inbox still uses it to route
          // ex-negotiation offers into the call lane.
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('project:create:organization')
  @ApiOperation({ summary: 'Associate branches with a project' })
  async associateBranches(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddProjectBranchesRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    /**
     * The region ceiling, per branch id, exactly as `getBranchHistory` above enforces it for a
     * read of one branch.
     *
     * This route took neither `@GlobalScopeFilter()` nor an assertion, and it is the write half
     * of a boundary whose read half has always been closed. Verified live: a NORTH-scoped
     * OPERATIONS account refused `GET /branches/<west id>` with 403 "That record belongs to a
     * region your account is not assigned to" put that same branch into a project one second
     * later — a `project_branches` row and an `assessments` row, both stamped `created_by` with
     * the out-of-region caller — and then could still not see the link it had just made, because
     * `GET /projects/:id/branches` filters by the same ceiling the write ignored. A boundary that
     * one verb honours and its neighbour does not is not a boundary.
     *
     * Asserted for every id before any of them is associated, so a list containing one
     * out-of-scope branch is refused whole rather than half-applied — the shape
     * `assayer.bulkTransitionLifecycle` already uses.
     */
    for (const branchId of dto.branchIds) {
      await this.regionGuard.assertBranchInScope(branchId, scope);
    }
    const list = await this.projectService.associateBranches(id, dto.branchIds, req.user.id);
    return list;
  }

  /**
   * Upload a branch list for this project. Answers 202 with the rehearsal job as soon as the file is
   * stored; the rows are read, matched and placed in the background and wait for review — nothing is
   * written until the review is committed (see `branch-import/branch-import.job.ts`).
   *
   * Replaces `/branches/upload` (the queued importer, with no review), `/branches/reconcile` and
   * `/branches/commit-reconciled` (a synchronous preview, then a commit that trusted every row the
   * browser sent back, and checked a state NAME against a list of region CODES). The region ceiling
   * is enforced in the job's `prepare` — on the file's states and on the branches it names — and
   * again per row in the worker.
   */
  @Post(':id/branches/import')
  @HttpCode(202)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('project:create:organization')
  @UseInterceptors(FileInterceptor('file', branchImportUploadOptions), DiskUploadScanInterceptor)
  @ApiOperation({ summary: 'Upload a branch list for a project; answers 202 with the rehearsal job to review' })
  async importBranches(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.branchImport.start({
      scopeType: 'PROJECT',
      scopeId: id,
      actor: jobActorFrom(req),
      regions: assignedRegions(req.user),
      file: incomingFile(file),
    });
  }

  @Post(':id/branches/import/:jobId/commit')
  @HttpCode(202)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('project:create:organization')
  @ApiOperation({ summary: "Commit a reviewed branch import into this project; answers 202 with the commit job" })
  async commitBranchImport(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() dto: CommitBranchImportDto,
    @Req() req: any,
  ) {
    return this.branchImport.commit(readerFrom(req), jobActorFrom(req), 'PROJECT', id, jobId, dto.decisions);
  }

  @Post(':id/branches/import/:jobId/retry')
  @HttpCode(202)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('project:create:organization')
  @ApiOperation({ summary: 'Run a failed or cancelled branch import for this project again' })
  async retryBranchImport(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Req() req: any,
  ) {
    return this.branchImport.retry(readerFrom(req), jobActorFrom(req), 'PROJECT', id, jobId);
  }

  @Get(':id/branches/template')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('branch:import:organization')
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
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('project:delete:organization')
  @ApiOperation({ summary: 'Remove a branch association from a project' })
  async removeBranch(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('pbId', ParseUUIDPipe) pbId: string,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    /**
     * The destructive mirror of `associateBranches`, and it had the same hole.
     *
     * `getBranchHistory` above asserts this exact ceiling on the exact same id for a READ.
     * Verified live: a NORTH-scoped OPERATIONS account got 403 from
     * `GET /projects/branches/<pbId>/history` and then removed that same WEST project branch
     * through this route — 200, `is_active` true → false, `updated_by` its own id.
     */
    await this.regionGuard.assertProjectBranchInScope(pbId, scope);
    const list = await this.projectService.removeProjectBranch(id, pbId, req.user.id);
    return list;
  }
}
