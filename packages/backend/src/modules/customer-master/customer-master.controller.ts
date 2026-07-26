import { Controller, Get, Post, Param, Query, UseGuards, ParseUUIDPipe, Req, UseInterceptors, UploadedFile, DefaultValuePipe, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { CustomerMasterService } from './customer-master.service';
import { LocalStorageService } from '../../infrastructure/storage/local-storage.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

@ApiTags('Customer Master')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('customer-master')
export class CustomerMasterController {
  constructor(
    private readonly customerMasterService: CustomerMasterService,
    private readonly localStorageService: LocalStorageService,
  ) {}

  @Post('upload')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.DOCUMENT_EXECUTIVE, SystemRole.OPERATIONS_MANAGER)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload customer master Excel file, run database branch reconciliation, and register new version' })
  async upload(
    @UploadedFile() file: any,
    @Query('projectId', ParseUUIDPipe) projectId: string,
    @Req() req: any,
  ) {
    const savedPath = await this.localStorageService.saveFile(file.originalname, file.buffer);
    const report = await this.customerMasterService.uploadAndReconcile(
      projectId,
      file.originalname,
      savedPath,
      file.buffer,
      req.user.id,
    );

    return {
      success: true,
      data: report,
    };
  }

  @Post('versions/:versionId/approve')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
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

  @Get('projects/:projectId/versions')
  @ApiOperation({ summary: 'List version history for a project mandate' })
  async findByProject(@Param('projectId', ParseUUIDPipe) projectId: string) {
    const list = await this.customerMasterService.findByProject(projectId);
    return {
      success: true,
      data: list,
    };
  }

  @Get('versions/:versionId/records')
  @ApiOperation({ summary: 'Get paginated customer records inside a version' })
  async findRecords(
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    const result = await this.customerMasterService.findRecords(versionId, page, limit);
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
