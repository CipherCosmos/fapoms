import {
  BadRequestException, Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, Res,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { SystemRole, InterviewOutcome } from '@fapoms/shared';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { AssayerInterviewService } from './assayer-interview.service';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { assertUploadAllowed, uploadMulterOptions, SCAN_UPLOAD_TYPES, MAX_UPLOAD_BYTES } from '../document/upload-validation';
import { deriveFileIntegrity } from '../document/document-integrity';
import type { StorageEngine } from '../../infrastructure/storage/storage-engine.interface';
import { AuditRead } from '../../core/audit/audit-read.decorator';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';

class RecordInterviewRequestDto {
  @IsString() @MinLength(1) @MaxLength(200)
  candidateName: string;

  @IsString() @MinLength(1) @MaxLength(20)
  mobile: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;

  @IsEnum(InterviewOutcome)
  outcome: InterviewOutcome;

  /** Set when a candidate who did not pass is being interviewed again. */
  @IsOptional() @IsUUID()
  previousInterviewId?: string;

  /** Who referred the candidate. Checked in full by the shared `normalizeSourceReferral`. */
  @IsOptional() @IsObject()
  sourceReferral?: Record<string, unknown> | null;
}

/**
 * What a candidate's name, number or email may be corrected to after the fact. The outcome is not
 * here and never will be: a PASS has already sent somebody a link and a FAIL is a decision that
 * was made, so neither is a typo to fix — record a second interview instead.
 */
class AmendInterviewRequestDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200)
  candidateName?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(20)
  mobile?: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;
}

/**
 * The Appraiser Recruitment spec's Module 1 — an internal-only interview gate that decides who
 * gets a self-registration invite. See `AssayerInterviewService` for the pass → invite hand-off.
 */
@ApiTags('Assayer interviews')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('assayer-interviews')
export class AssayerInterviewController {
  constructor(
    private readonly interviews: AssayerInterviewService,
    @Inject('StorageEngine') private readonly storage: StorageEngine,
    /**
     * The region ceiling (audit F5, 2026-09-24): an interview reaches a region through the
     * application its PASS opened — see `RegionGuardService.assertInterviewInScope`. Reads honour
     * `security.regionScope.mode`; writes always enforce.
     */
    private readonly regionGuard: RegionGuardService,
  ) {}

  @Post()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:create:organization')
  @ApiOperation({ summary: 'Record an interview outcome; a PASS sends the candidate a registration link' })
  async record(@Body() dto: RecordInterviewRequestDto, @Req() req: any) {
    const interview = await this.interviews.record(
      dto,
      req.user.id,
      req.user.displayName ?? req.user.username ?? req.user.email ?? undefined,
      req.user.organizationId,
    );
    return interview;
  }

  /**
   * Correct what was typed, while the candidate has not yet opened their link.
   *
   * This controller had `@Post()` and `@Get()` and nothing else, so a mistyped mobile number could
   * only be repaired by recording a second interview — which sent a second invite and left the log
   * claiming the candidate had been interviewed twice.
   */
  @Patch(':id')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:edit:organization')
  @ApiOperation({ summary: 'Correct a candidate\'s details before they open their link' })
  async amend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AmendInterviewRequestDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.regionGuard.assertInterviewInScope(id, scope, 'write');
    return await this.interviews.amend(id, dto, req.user.id);
  }

  /**
   * Keep a file with an interview — the test paper, an answer sheet. Through the same door as every
   * other upload (allow-list, size cap, virus scan, storage engine), never around it.
   */
  @Post(':id/file')
  @HttpCode(201)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:create:organization')
  @UseInterceptors(FileInterceptor('file', uploadMulterOptions({ maxBytes: MAX_UPLOAD_BYTES })), FileScanInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Keep a test paper or other file with an interview' })
  async attachFile(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: any,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    // Before the file is scanned or stored: another region's interview gets nothing kept against it.
    await this.regionGuard.assertInterviewInScope(id, scope, 'write');
    if (!file?.buffer?.length) throw new BadRequestException('No file was uploaded. Choose a file and try again.');
    assertUploadAllowed({
      contentType: file.mimetype,
      fileName: file.originalname,
      size: file.size,
      allowed: SCAN_UPLOAD_TYPES,
      hint: 'Scan or photograph the paper, or upload it as a PDF.',
    });
    const integrity = deriveFileIntegrity(file.buffer, file.mimetype);
    const key = await this.storage.saveFile(file.originalname, file.buffer, file.mimetype, file.size);
    return await this.interviews.attachFile(id, {
      storageKey: key,
      fileName: String(file.originalname ?? 'file'),
      mimeType: integrity.effectiveMimeType ?? file.mimetype ?? null,
      size: integrity.byteLength,
      sha256: integrity.sha256,
    }, req.user.id, req.user.displayName ?? req.user.username ?? null);
  }

  /** One of an interview's files, streamed like every personnel scan: opaque, never cached. */
  @Get(':id/file/:index')
  @AuditRead({ resource: 'ASSAYER_INTERVIEW', idParam: 'id', eventType: 'ASSAYER_INTERVIEW_FILE_VIEWED' })
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'Fetch one file kept with an interview' })
  async getFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index') index: string,
    @Res() res: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ): Promise<void> {
    await this.regionGuard.assertInterviewInScope(id, scope, 'read');
    const found = await this.interviews.fileKey(id, Number(index));
    if (!found) throw new NotFoundException('No such file on this interview.');
    const stream = await this.storage.getFileStream(found.key);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline; filename="interview-file"');
    res.setHeader('Cache-Control', 'private, no-store');
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  @Get()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'The interview log' })
  async list() {
    return await this.interviews.list();
  }
}
