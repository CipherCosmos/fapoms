/**
 * FAPOMS — importing a client's branch master from a spreadsheet (the Branches page).
 *
 * Three routes, one background flow (`branch-import/branch-import.job.ts`):
 *
 *  - `POST /branches/import/:clientId` — upload; answers 202 with the rehearsal job the moment the
 *    file is stored. Nothing is written to the branch master yet.
 *  - `POST /branches/import/:clientId/jobs/:jobId/commit` — the person's review decisions; answers
 *    202 with the commit job.
 *  - `POST /branches/import/:clientId/jobs/:jobId/retry` — run a failed or cancelled job again.
 *
 * Progress, the stored review and the result are read from `/jobs` like every other background job,
 * so a refreshed page finds all of it again.
 *
 * ## Why these routes are `/branches/…` but live in the project module
 *
 * The importer needs the project-side entities (a project import links branches and opens
 * assessments), and `BranchModule` cannot reach `ProjectModule` — `ProjectModule` imports it. A
 * controller is not bound to the module whose URL prefix it serves, so this one is registered here.
 *
 * The old `reconcile/:clientId` and `commit-reconciled/:clientId` routes are gone: they ran a
 * 5,000-row file inside one request, and the commit trusted every coordinate, geo source and state
 * the browser sent back — with no region check at all.
 */

import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { IsObject } from 'class-validator';
import { SystemRole } from '@fapoms/shared';

import { assignedRegions } from '../../infrastructure/scope/global-scope';
import { jobActorFrom } from '../../infrastructure/queue/job-actor';
import { readerFrom } from '../../infrastructure/background-jobs/background-jobs.controller';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { diskUploadMulterOptions, MAX_UPLOAD_BYTES } from '../document/upload-validation';
import { DiskUploadScanInterceptor } from '../document/disk-upload-scan.interceptor';
import { BranchImportJob } from './branch-import/branch-import.job';

/** One file, on disk, scanned — the upload the Jobs foundation takes everywhere. */
export const branchImportUploadOptions = diskUploadMulterOptions({ maxBytes: MAX_UPLOAD_BYTES, maxFiles: 1 });

/** The review's decisions. Their contents are checked by `validateDecisions` (and again in the job). */
export class CommitBranchImportDto {
  @IsObject()
  decisions: Record<string, unknown>;
}

/** An uploaded file, as the Jobs foundation takes it. */
export function incomingFile(file?: Express.Multer.File) {
  return file
    ? {
        path: file.path,
        buffer: file.path ? undefined : file.buffer,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      }
    : null;
}

@ApiTags('Branches')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('branches')
export class BranchImportController {
  constructor(private readonly branchImport: BranchImportJob) {}

  @Post('import/:clientId')
  @HttpCode(202)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('branch:create:organization')
  @UseInterceptors(FileInterceptor('file', branchImportUploadOptions), DiskUploadScanInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({ summary: "Upload a client's branch list; answers 202 with the rehearsal job (nothing is written until it is reviewed and committed)" })
  async importBranches(
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Req() req: any,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.branchImport.start({
      scopeType: 'CLIENT',
      scopeId: clientId,
      actor: jobActorFrom(req),
      regions: assignedRegions(req.user),
      file: incomingFile(file),
    });
  }

  @Post('import/:clientId/jobs/:jobId/commit')
  @HttpCode(202)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('branch:create:organization')
  @ApiOperation({ summary: 'Commit a reviewed branch import: the review decisions are applied to the stored rehearsal in the background' })
  async commitImport(
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() dto: CommitBranchImportDto,
    @Req() req: any,
  ) {
    return this.branchImport.commit(readerFrom(req), jobActorFrom(req), 'CLIENT', clientId, jobId, dto.decisions);
  }

  @Post('import/:clientId/jobs/:jobId/retry')
  @HttpCode(202)
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('branch:create:organization')
  @ApiOperation({ summary: 'Run a failed or cancelled branch import again over the same stored file' })
  async retryImport(
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Req() req: any,
  ) {
    return this.branchImport.retry(readerFrom(req), jobActorFrom(req), 'CLIENT', clientId, jobId);
  }
}
