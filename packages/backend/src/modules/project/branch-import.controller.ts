/**
 * FAPOMS — importing a client's branch master from a spreadsheet.
 *
 * ## Why these routes are `/branches/…` but live in the project module
 *
 * There is now exactly one branch-sheet importer, and it is
 * `ProjectService.uploadBranchesFromExcel` — the one with prefetch-by-key, per-distinct-value
 * memoisation, per-row skip reasons, published progress and a queue behind it. The Branches page
 * used to call a second one (`BranchService.importExcel`) that did a geography check, a `findOne`
 * and a geocode **per row, inside the HTTP request**; on the real 3,759-row client file that is
 * thousands of sequential round trips against a 300-second socket timeout, which the operator
 * experiences as the page freezing and then as an upload that "failed" and needs redoing — while
 * the first one is still running.
 *
 * `BranchModule` cannot reach `ProjectService`, because `ProjectModule` imports *it*; that
 * dependency direction is exactly why the duplicate importer grew in the first place. A controller
 * is not bound to the module whose URL prefix it serves, so this one is registered by
 * `ProjectModule`, where both the importer and the queue are already in scope, and serves the
 * `/branches` routes the web app already calls. The queue itself was moved out to a leaf
 * `ImportModule` so nothing has to repeat this dance to enqueue.
 *
 * The remaining structural step — moving the importer out of `ProjectService` into
 * `modules/import/` so this controller can live beside it — is a file move with no behaviour
 * change, and is deliberately not bundled with the behaviour fix above.
 */

import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import type { Response } from 'express';
import { SystemRole } from '@fapoms/shared';

import { ProjectService } from './project.service';
import { ImportJobService } from '../import/import-job.service';
import type { ImportScope } from '../import/import.contract';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { MAX_UPLOAD_BYTES } from '../document/upload-validation';

/** Same shape as `documentUploadMulterOptions` in document.controller.ts — see that file. */
const branchUploadMulterOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
};

@ApiTags('Branches')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('branches')
export class BranchImportController {
  constructor(
    private readonly projectService: ProjectService,
    private readonly importJobService: ImportJobService,
  ) {}

  /**
   * Import or correct a client's branch master from a workbook.
   *
   * Identical in every respect to a project upload except that no project link or assessment is
   * created — see `ImportScope`. Large files are accepted with 202 and a job id rather than held
   * open; the threshold is the file's own shape, not a flag the caller sets, because the case that
   * needs queueing is precisely the case whose operator does not know it does.
   */
  @Post('import/:clientId')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('branch:create:organization')
  @UseInterceptors(FileInterceptor('file', branchUploadMulterOptions), FileScanInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: "Import branches into a client's branch master; large files are queued and return 202 with a job id",
  })
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  async importBranches(
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    // A submitted form with no file attached arrives as `undefined`; reading `.buffer` off it
    // threw a TypeError the operator saw as "Internal server error".
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file was uploaded. Choose a file and try again.');
    }

    // Parsed in the request either way, so an unreadable file — or the assayer roster uploaded to
    // the wrong screen — is still an immediate, specific 400 rather than a cheerful 202 followed
    // by a failure the operator has to go looking for.
    const scope: ImportScope = { kind: 'CLIENT', id: clientId };
    const preflight = await this.projectService.preflightBranchExcel(scope, file.buffer);

    if (ImportJobService.shouldQueue(preflight)) {
      const job = await this.importJobService.enqueueBranchImport({
        scope,
        userId: req.user.id,
        fileBuffer: file.buffer,
        fileName: file.originalname ?? null,
        totalRows: preflight.totalRows,
        rowsNeedingGeocode: preflight.rowsNeedingGeocode,
      });

      // 202: accepted, not done. The body says where to watch.
      res.status(202);
      return {
        success: true,
        data: {
          ...job,
          queued: true,
          statusUrl: `/branches/import/${clientId}/jobs/${job.jobId}`,
          message:
            `This file has ${preflight.totalRows} row(s), ${preflight.rowsNeedingGeocode} of which need a location ` +
            `looked up. Address lookups are limited to about one per second by the mapping providers, so this ` +
            `import is running in the background — it does not need this page kept open. Check its progress at ` +
            `the status URL.`,
        },
      };
    }

    const report = await this.projectService.uploadBranchesFromExcel(scope, file.buffer, req.user.id);
    return {
      success: true,
      data: {
        totalRows: report.totalRows,
        created: report.created,
        updated: report.updated,
        unchanged: report.unchanged,
        skipped: report.skipped,
        imprecise: report.imprecise,
        // Archived branches this file restored — see `BranchImportOutcome.revived`.
        revived: report.revived,
        // Facts about the FILE, not a row — chiefly a heading nobody read, whose data was
        // therefore dropped in silence. See `BranchImportOutcome.notes`.
        notes: report.notes,
        /**
         * Kept because the Branches page has always read it.
         *
         * The old importer counted every row it wrote, created or updated alike, and called that
         * `importedCount`. Reproduced exactly rather than redefined, so the message the operator
         * reads after an import does not change meaning on the day this endpoint did.
         */
        importedCount: report.created + report.updated + report.unchanged,
      },
    };
  }

  /**
   * State, progress and result of a queued branch-master import.
   *
   * The client id is checked against the job's own payload: Bull job ids are a per-queue
   * incrementing integer, so without that check anyone able to read one client could walk
   * `1, 2, 3…` and pull back other clients' import results, which name real branches and
   * addresses.
   */
  @Get('import/:clientId/jobs/:jobId')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('branch:create:organization')
  @ApiOperation({ summary: 'State, progress and result of a queued branch-master import' })
  async getImportJob(@Param('clientId', ParseUUIDPipe) clientId: string, @Param('jobId') jobId: string) {
    return {
      success: true,
      data: await this.importJobService.getBranchImportStatus({ kind: 'CLIENT', id: clientId }, jobId),
    };
  }
}
