import { Controller, Get, Post, Body, Param, Query, UseGuards, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OcrProcessingService } from './ocr-processing.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, RoleOnly } from '../../modules/auth/guards';
import { SystemRole } from '@fapoms/shared';

class ReceiveOcrResultsDto {
  externalJobId: string;
  ocrPayload: any;
}

@ApiTags('OCR Integration Boundary')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('ocr-boundary')
export class OcrBoundaryController {
  constructor(private readonly ocrProcessingService: OcrProcessingService) {}

  @Post('jobs')
  // DEVELOPER, not ADMIN (2026-09-05): the OCR boundary is a developer-only integration surface.
  @Roles(SystemRole.DEVELOPER)
  @RequirePermissions('ocr:create:organization')
  // Deliberate tightening: a custom role holding ocr:* no longer slips in via the permission fallback.
  @RoleOnly()
  @ApiOperation({ summary: 'Create a new OCR tracking job request' })
  async createJob(
    @Query('documentId', ParseUUIDPipe) documentId: string,
    @Req() req: any,
  ) {
    const job = await this.ocrProcessingService.createJob(documentId, req.user.id);
    return {
      success: true,
      data: job,
    };
  }

  @Post('jobs/:id/results')
  @Roles(SystemRole.DEVELOPER)
  @RequirePermissions('ocr:edit:organization')
  @RoleOnly() // Same tightening as createJob above.
  @ApiOperation({ summary: 'Callback endpoint to receive external OCR engine scan results' })
  async callbackOcr(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceiveOcrResultsDto,
    @Req() req: any,
  ) {
    const job = await this.ocrProcessingService.receiveOcrResults(id, dto.externalJobId, dto.ocrPayload, req.user.id);
    return {
      success: true,
      data: job,
    };
  }

  /**
   * Reading a job's status, which nobody could do.
   *
   * This carried no `@Roles`, and the class runs `RolesGuard` — which denies by default, so a
   * route naming no audience is refused for everyone including an administrator. Its three
   * siblings all name one; this one was simply missed, and the failure mode is silent because
   * a 403 from a missing list is indistinguishable from a 403 on purpose.
   *
   * It takes the audience and the grant of the route below it, which is the other half of the
   * same job. `ocr:view` would be the truer name, but no role holds it — and inventing a
   * permission nobody grants is how a route becomes uncallable, which is the bug being fixed.
   */
  @Get('jobs/:id')
  // DESK stays: reading a job's status is part of the desk's own workflow, not the integration.
  @Roles(SystemRole.DEVELOPER, SystemRole.DESK)
  @RequirePermissions('ocr:edit:organization')
  @RoleOnly() // Same tightening as createJob above.
  @ApiOperation({ summary: 'Get status tracking details of an OCR job' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const job = await this.ocrProcessingService.findOne(id);
    return {
      success: true,
      data: job,
    };
  }

  @Post('jobs/:id/retry')
  @Roles(SystemRole.DEVELOPER, SystemRole.DESK)
  @RequirePermissions('ocr:edit:organization')
  @RoleOnly() // Same tightening as createJob above.
  @ApiOperation({ summary: 'Retry a failed OCR job request' })
  async retryJob(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const job = await this.ocrProcessingService.retryJob(id, req.user.id);
    return {
      success: true,
      data: job,
    };
  }
}
