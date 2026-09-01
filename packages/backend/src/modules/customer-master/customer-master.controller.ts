import { Controller, Get, Post, Param, Query, UseGuards, ParseUUIDPipe, Req, UseInterceptors, UploadedFile, DefaultValuePipe, ParseIntPipe, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { MAX_UPLOAD_BYTES } from '../document/upload-validation';
import { ParseLimitPipe } from '../../infrastructure/http/parse-limit.pipe';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { CustomerMasterService } from './customer-master.service';

/** Same shape as `documentUploadMulterOptions` in document.controller.ts — see that file. */
const customerMasterUploadMulterOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
};
import { StorageEngine } from '../../infrastructure/storage/storage-engine.interface';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

@ApiTags('Customer Master')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('customer-master')
export class CustomerMasterController {
  constructor(
    private readonly customerMasterService: CustomerMasterService,
    @Inject('StorageEngine') private readonly storage: StorageEngine,
  ) {}

  @Post('upload')
  @Roles(SystemRole.ADMIN, SystemRole.DESK, SystemRole.OPERATIONS)
    @UseInterceptors(FileInterceptor('file', customerMasterUploadMulterOptions), FileScanInterceptor)
  @ApiConsumes('multipart/form-data')
  // No region ceiling here, deliberately: one file covers every branch the client scheduled for
  // an audit date (see `dailyRun`'s doc comment), so there is no single branchId the caller
  // supplies to check a region against — reconciliation resolves a branch per ROW, from the
  // spreadsheet's own SOL ID column, potentially spanning many branches and regions in one
  // upload by design. The records this creates are read back through `findRecords`, which does
  // carry the ceiling; gating the write here would not close a read gap, only add a check with
  // no single id to check it against.
  @ApiOperation({ summary: 'Upload customer master Excel file, run database branch reconciliation, and register new version' })
  async upload(
    @UploadedFile() file: any,
    @Query('projectId', ParseUUIDPipe) projectId: string,
    @Req() req: any,
    // The audit date this batch covers. The client sends one file the day before
    // for all branches scheduled that day, so the date is what identifies the run.
    @Query('auditDate') auditDate?: string,
  ) {
    const savedPath = await this.storage.saveFile(
      file.originalname,
      file.buffer,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    const report = await this.customerMasterService.uploadAndReconcile(
      projectId,
      file.originalname,
      savedPath,
      file.buffer,
      req.user.id,
      auditDate,
    );

    return {
      success: true,
      data: report,
    };
  }

  @Post('versions/:versionId/approve')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
    @ApiOperation({ summary: 'Approve a reconciled customer master version and supersede prior active version' })
  async approveVersion(
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Req() req: any,
  ) {
    const version = await this.customerMasterService.approveVersion(versionId, req.user.id);
    return {
      success: true,
      data: version,
    };
  }

  @Get('projects/:projectId/daily-run')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.AUDITOR)
  @ApiOperation({ summary: "A single audit date's run: the client batch, its branches, and where each branch's PDF has reached" })
  async dailyRun(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('auditDate') auditDate: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    return { success: true, data: await this.customerMasterService.dailyRun(projectId, auditDate, scope) };
  }

  @Get('projects/:projectId/versions')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.AUDITOR)
  @ApiOperation({ summary: 'List version history for a project mandate' })
  async findByProject(@Param('projectId', ParseUUIDPipe) projectId: string) {
    const list = await this.customerMasterService.findByProject(projectId);
    return {
      success: true,
      data: list,
    };
  }

  @Get('versions/:versionId/records')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.AUDITOR)
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
