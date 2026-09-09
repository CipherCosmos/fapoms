import { Controller, Get, Post, Body, Param, Query, UseGuards, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OcrProcessingService } from './ocr-processing.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, RoleOnly } from '../../modules/auth/guards';
import { SystemRole } from '@fapoms/shared';
import { IsString, IsNotEmpty, IsObject, MaxLength } from 'class-validator';

/**
 * The body the external OCR engine posts back when a scan finishes.
 *
 * Both properties were declared bare and this file imported nothing from class-validator, so the
 * class carried no validation metadata at all. That does not mean "unvalidated" — it means the
 * route was closed. The global pipe still treats a custom class as something to validate, ES2022
 * class-field emit puts both declared keys on every instance class-transformer builds, and
 * `whitelist` + `forbidNonWhitelisted` (main.ts) then refuse each of them by name. Every callback
 * this endpoint has ever received came back
 * `400 property externalJobId should not exist, property ocrPayload should not exist` — naming
 * the two fields the engine had just sent correctly. No OCR payload has ever been stored through
 * this route and no scan has ever reached a human reviewer from it.
 *
 * Nest's `ValidationPipe` sets `forbidUnknownValues: false`, overriding class-validator's own
 * default, so the "no metadata for this target" guard that would otherwise have caught a class
 * in this state never fired either. Nothing was going to notice this but a caller.
 */
class ReceiveOcrResultsDto {
  /** 150 is the width of `ocr_jobs.external_job_id`, which this is copied into verbatim. */
  @IsString() @IsNotEmpty() @MaxLength(150)
  externalJobId: string;

  /**
   * The engine's own result document. It is stored verbatim in `ocr_jobs.ocr_payload` (jsonb) and
   * handed to the validation case as its OCR_PROCESSING evidence, so its inner shape belongs to
   * the engine and nothing here asserts one. It must still be an object: a null, a bare string or
   * an omitted payload would mark the job COMPLETED and open a HUMAN_REVIEW case with nothing in
   * it for the reviewer to check the scanned document against, which is the one outcome an audit
   * trail cannot absorb. `@Allow()` would satisfy the whitelist while permitting exactly that,
   * which is why it is not used here.
   */
  @IsObject()
  ocrPayload: Record<string, unknown>;
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
