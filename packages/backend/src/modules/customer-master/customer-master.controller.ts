import { Controller, Get, Post, Param, Query, UseGuards, ParseUUIDPipe, Req, UseInterceptors, UploadedFile, DefaultValuePipe, ParseIntPipe, Inject, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { assertUploadAllowed, UPLOAD_INTERCEPTOR_OPTIONS } from '../document/upload-validation';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { CustomerMasterService } from './customer-master.service';
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
    @UseInterceptors(FileInterceptor('file', UPLOAD_INTERCEPTOR_OPTIONS), FileScanInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload customer master Excel file, run database branch reconciliation, and register new version' })
  async upload(
    @UploadedFile() file: any,
    @Query('projectId', ParseUUIDPipe) projectId: string,
    @Req() req: any,
    // The audit date this batch covers. The client sends one file the day before
    // for all branches scheduled that day, so the date is what identifies the run.
    @Query('auditDate') auditDate?: string,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file was uploaded. Choose a file and try again.');
    }
    // Same gap as the branch import: no size cap and no type check before the Excel parser. The
    // interceptor now bounds the buffer; this rejects a wrong type before reconciliation runs.
    assertUploadAllowed({ contentType: file.mimetype, size: file.size, hint: 'Upload the customer-master Excel file.' });
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
  ) {
    return { success: true, data: await this.customerMasterService.dailyRun(projectId, auditDate) };
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
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('branchId') branchId?: string,
  ) {
    const result = await this.customerMasterService.findRecords(versionId, page, limit, branchId);
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
