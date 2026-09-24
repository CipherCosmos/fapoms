import { Controller, Get, Post, Param, Query, UseGuards, ParseUUIDPipe, Req, UseInterceptors, UploadedFile, DefaultValuePipe, ParseIntPipe, HttpCode, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import type { BackgroundJobAccepted } from '@fapoms/shared';
import { diskUploadMulterOptions, MAX_UPLOAD_BYTES } from '../document/upload-validation';
import { DiskUploadScanInterceptor } from '../document/disk-upload-scan.interceptor';
import { ParseLimitPipe } from '../../infrastructure/http/parse-limit.pipe';
import { GlobalScopeFilter, GlobalScope, assignedRegions } from '../../infrastructure/scope/global-scope';
import { AuditRead } from '../../core/audit/audit-read.decorator';
import { BackgroundJobsService } from '../../infrastructure/background-jobs/background-jobs.service';
import { jobActorFrom } from '../../infrastructure/queue/job-actor';
import { CustomerMasterService } from './customer-master.service';
import { CUSTOMER_MASTER_IMPORT_KIND } from './customer-master-import.job';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

/** On disk, like every background upload: the file goes straight to storage, never held in memory. */
const customerMasterUploadMulterOptions = diskUploadMulterOptions({ maxBytes: MAX_UPLOAD_BYTES, maxFiles: 1 });

/**
 * The job parameters a background upload sends as the multipart `params` field (JSON text — see
 * `uploadJob` in the web client). Query parameters, the route's older shape, win where both are sent.
 */
function multipartParams(req: any): Record<string, unknown> {
  const raw = req?.body?.params;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new BadRequestException('params must be a JSON object.');
  }
}

@ApiTags('Customer Master')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('customer-master')
export class CustomerMasterController {
  constructor(
    private readonly customerMasterService: CustomerMasterService,
    private readonly backgroundJobs: BackgroundJobsService,
  ) {}

  @Post('upload')
  @HttpCode(202)
  @Roles(SystemRole.ADMIN, SystemRole.DESK, SystemRole.OPERATIONS)
  // The customer master arrives as a spreadsheet, so this is the file-upload permission rather
  // than a project one — the version it registers is approved separately, below.
  @RequirePermissions('document:upload:organization')
  // On disk, and scanned (malware + the byte-level content gate) from disk before the handler runs.
  @UseInterceptors(FileInterceptor('file', customerMasterUploadMulterOptions), DiskUploadScanInterceptor)
  @ApiConsumes('multipart/form-data')
  // No region ceiling here, deliberately: one file covers every branch the client scheduled for
  // an audit date (see `dailyRun`'s doc comment), so there is no single branchId the caller
  // supplies to check a region against — reconciliation resolves a branch per ROW, from the
  // spreadsheet's own SOL ID column, potentially spanning many branches and regions in one
  // upload by design. The records this creates are read back through `findRecords`, which does
  // carry the ceiling; gating the write here would not close a read gap, only add a check with
  // no single id to check it against.
  @ApiOperation({ summary: 'Upload the client customer master file; answers 202 with the background job that reconciles it and registers the version' })
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: any,
    // Either as query parameters (the route's original shape) or in the multipart `params` JSON.
    // The audit date is what identifies the run: the client sends one file the day before for all
    // branches scheduled that day.
    @Query('projectId') projectIdQuery?: string,
    @Query('auditDate') auditDateQuery?: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ): Promise<BackgroundJobAccepted> {
    const params = multipartParams(req);
    const projectId = projectIdQuery ?? params.projectId;
    const auditDate = auditDateQuery ?? params.auditDate ?? null;

    /**
     * Accepted, not done. The file is stored and a background job recorded; reconciliation runs in
     * the worker (`CustomerMasterImportJob`) and its report is the job's result, read back from
     * `GET /jobs` — so a refresh, or a closed tab, loses nothing.
     *
     * What must answer at once still does: the file type (spreadsheet only), size, the malware scan,
     * the byte-level content gate, the project and the caller's client ceiling are all checked
     * before anything is stored (the interceptors above and the kind's `prepare`), so a wrong file
     * is refused right here with a specific error rather than a cheerful 202.
     */
    return this.backgroundJobs.create({
      kind: CUSTOMER_MASTER_IMPORT_KIND,
      actor: jobActorFrom(req),
      regions: assignedRegions(req.user),
      scope: { type: 'PROJECT', id: typeof projectId === 'string' ? projectId : null },
      params: { projectId, auditDate },
      globalScope: scope,
      file: file
        ? {
            path: file.path,
            buffer: file.path ? undefined : file.buffer,
            originalName: file.originalname,
            mimeType: file.mimetype,
            size: file.size,
          }
        : null,
    });
  }

  @Post('versions/:versionId/approve')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  // Approving a version supersedes the population the project is audited against, so it is a
  // change to the project rather than to a document. There is no CUSTOMER_MASTER permission.
  @RequirePermissions('project:edit:organization')
    @ApiOperation({ summary: 'Approve a reconciled customer master version and supersede prior active version' })
  async approveVersion(
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Req() req: any,
  ) {
    const version = await this.customerMasterService.approveVersion(versionId, req.user.id);
    return version;
  }

  @Get('projects/:projectId/daily-run')
  // CLIENT_USER named explicitly — see `findByProject` below for why.
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.AUDITOR, SystemRole.CLIENT_USER)
  @RequirePermissions('project:view:organization')
  @ApiOperation({ summary: "A single audit date's run: the client batch, its branches, and where each branch's PDF has reached" })
  async dailyRun(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('auditDate') auditDate: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    return await this.customerMasterService.dailyRun(projectId, auditDate, scope);
  }

  @Get('projects/:projectId/versions')
  // CLIENT_USER named explicitly, not left to the permission fallback: it used to reach these
  // three routes only by coincidence (its dashboard-only PROJECT:VIEW:PLATFORM grant happening
  // to satisfy `project:view:organization`), with zero client_id ceiling on any of them — a
  // client-user could pull another bank's customer-master batches and PII-bearing records by
  // project/version id alone. `findByProject`/`findRecords`/`dailyRun` now all call
  // `assertClientAllowed`, so this grant is deliberate: a client reviewing the batch of their
  // own customers' records they submitted, nothing more.
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.AUDITOR, SystemRole.CLIENT_USER)
  @RequirePermissions('project:view:organization')
  @ApiOperation({ summary: 'List version history for a project mandate' })
  async findByProject(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    const list = await this.customerMasterService.findByProject(projectId, scope);
    return list;
  }

  @Get('versions/:versionId/records')
  // CLIENT_USER named explicitly — see `findByProject` above for why.
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.AUDITOR, SystemRole.CLIENT_USER)
  @RequirePermissions('project:view:organization')
  // Bank customer records (account number, name, pledged-gold weight) — data we hold as Processor
  // for the bank. Reading them is access to personal data; log who opened which version's records.
  @AuditRead({ resource: 'CUSTOMER_RECORD', idParam: 'versionId' })
  @ApiOperation({ summary: 'Get paginated customer records inside a version, optionally filtered by branchId' })
  async findRecords(
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    // Previously ParseIntPipe alone — a valid but unbounded integer, so `?limit=5000000` reached
    // `findRecords`'s `take:` unclamped. ParseLimitPipe keeps the existing default of 50 and
    // adds a 200 ceiling; see parse-limit.pipe.ts.
    @Query('limit', new ParseLimitPipe({ default: 50, max: 200 })) limit: number,
    @Query('branchId') branchId?: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    const result = await this.customerMasterService.findRecords(versionId, page, limit, branchId, scope);
    return {
      success: true,
      data: result.records,
      meta: {
        total: result.total,
        page,
        limit,
      },
    };
  }
}
