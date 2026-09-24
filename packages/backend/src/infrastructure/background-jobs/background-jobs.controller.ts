/**
 * FAPOMS — `/jobs`: the Jobs tray's API, and the generic door a background upload comes in by.
 *
 * Every route here is `@AnyAuthenticated()`, and that is a decision, not an omission: each answers
 * only with the caller's own jobs (or, for an administrator asking with `all=true`, the jobs inside
 * their regions), so there is no audience to narrow. Who may START a kind is decided per kind —
 * `BackgroundJobDefinition.start.permissions`, checked by `assertMayStart` against the live
 * principal — because a single `@RequirePermissions` here would have to be the union of every
 * kind's, which is the one answer guaranteed to be wrong for all of them.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { BACKGROUND_JOB_KINDS, type BackgroundJobKind } from '@fapoms/shared';
import { AnyAuthenticated, JwtAuthGuard, PermissionsGuard, RolesGuard } from '../../modules/auth/guards';
import { roleNames } from '../scope/region-guard.service';
import { assignedRegions, GlobalScopeFilter, type GlobalScope } from '../scope/global-scope';
import { jobActorFrom } from '../queue/job-actor';
import { ParseLimitPipe } from '../http/parse-limit.pipe';
import { diskUploadMulterOptions, MAX_UPLOAD_BYTES } from '../../modules/document/upload-validation';
import { DiskUploadScanInterceptor } from '../../modules/document/disk-upload-scan.interceptor';
import { BackgroundJobsService, parseListInclude, type JobReader } from './background-jobs.service';

/** One file per job; the ceiling every other upload route has. On disk, so a 50 MB sheet is not held in memory. */
const jobUploadMulterOptions = diskUploadMulterOptions({ maxBytes: MAX_UPLOAD_BYTES, maxFiles: 1 });

/**
 * The multipart fields of `POST /jobs`. Multipart carries strings, so `params` is JSON text and
 * parsed here — a kind's `prepare` validates what is inside it.
 */
export class StartBackgroundJobDto {
  @IsIn(BACKGROUND_JOB_KINDS as unknown as string[])
  kind: BackgroundJobKind;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  scopeType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  scopeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  params?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;
}

export class CommitReviewedJobDto {
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}

@ApiTags('Background jobs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('jobs')
export class BackgroundJobsController {
  constructor(private readonly jobs: BackgroundJobsService) {}

  /**
   * The Jobs tray's one read, made on every page load: what is still going, and what finished
   * lately. `status` is `active`, `recent`, or both (the default). A page watching one upload passes
   * `kind`, `scopeType` and `scopeId` to get only the jobs that are its own.
   */
  @Get()
  @AnyAuthenticated()
  @ApiOperation({ summary: 'My background jobs — active (in flight or awaiting review) and recently finished' })
  async list(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('kind') kind?: string,
    @Query('scopeType') scopeType?: string,
    @Query('scopeId') scopeId?: string,
    @Query('all') all?: string,
    @Query('limit', new ParseLimitPipe({ default: 10, max: 50 })) limit?: number,
  ) {
    return this.jobs.list(readerFrom(req), {
      include: parseListInclude(status),
      all: all === 'true',
      kind: kind || undefined,
      scopeType: scopeType || undefined,
      scopeId: scopeId || undefined,
      limit: limit ?? 10,
    });
  }

  /**
   * Start a job: the file is stored and the job queued, and the answer is 202 with the job — before
   * any of the work is done. Refreshing the page after this is safe; the job is on the server.
   */
  @Post()
  @AnyAuthenticated()
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('file', jobUploadMulterOptions), DiskUploadScanInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a file and start a background job over it; answers 202 as soon as the file is stored' })
  async start(
    @Req() req: any,
    @Body() dto: StartBackgroundJobDto,
    @UploadedFile() file?: Express.Multer.File,
    @GlobalScopeFilter() globalScope?: GlobalScope,
  ) {
    this.jobs.assertMayStart(dto.kind, req.user);
    if (!!dto.scopeId && !dto.scopeType) throw new BadRequestException('scopeId needs a scopeType.');
    return this.jobs.create({
      kind: dto.kind,
      actor: jobActorFrom(req),
      regions: assignedRegions(req.user),
      scope: dto.scopeType ? { type: dto.scopeType, id: dto.scopeId || null } : null,
      params: parseParams(dto.params),
      title: dto.title || undefined,
      globalScope,
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

  @Get(':id')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'One background job' })
  async get(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.get(readerFrom(req), id);
  }

  /** The job's stored report (skipped rows and why), when it produced one. */
  @Get(':id/result')
  @AnyAuthenticated()
  @ApiOperation({ summary: "Download a background job's report file" })
  async result(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.jobs.openResult(readerFrom(req), id);
    res.set({
      'Content-Type': file.mimeType,
      'Content-Disposition': `attachment; filename="${file.fileName.replace(/["\\\r\n]/g, '_')}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(file.stream);
  }

  /** Stop a waiting job, ask a running one to stop at its next checkpoint, or discard a rehearsal. */
  @Post(':id/cancel')
  @AnyAuthenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a background job' })
  async cancel(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.cancel(readerFrom(req), id);
  }

  /**
   * Accept a rehearsal: start the real run over the same file. The kind's own `prepare` runs again
   * against the person committing, so a commit is authorised exactly as a fresh start would be.
   */
  @Post(':id/commit')
  @AnyAuthenticated()
  @HttpCode(202)
  @ApiOperation({ summary: 'Commit a reviewed rehearsal (AWAITING_REVIEW) as a real run' })
  async commit(@Req() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CommitReviewedJobDto) {
    const reader = readerFrom(req);
    const parent = await this.jobs.get(reader, id);
    this.jobs.assertMayStart(parent.kind, req.user);
    return this.jobs.commitReviewed(reader, jobActorFrom(req), id, dto.params ?? {});
  }
}

export function readerFrom(req: any): JobReader {
  return {
    userId: req.user?.id,
    roleNames: roleNames(req.user?.roles),
    regions: assignedRegions(req.user),
    organizationId: req.user?.organizationId ?? null,
  };
}

function parseParams(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException('params must be a JSON object.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequestException('params must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}
