import { BadRequestException, CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { ASSAYER_ERROR_CODES } from '@fapoms/shared';
import { withCode } from '../http/api-error';
import { Observable } from 'rxjs';
import { FileScanService } from './file-scan.service';

/**
 * Malware-scans every file a multipart request carries, and verifies its bytes are the format it
 * claims (see `FileScanService.scanOrThrow`), before the route handler runs. Applied right
 * after `FileInterceptor`/`FilesInterceptor` so `request.file` / `request.files` are populated, it
 * scans each buffer and throws (rejecting the request) on the first infected file — the single, DRY
 * guard that makes "scan everywhere a file is uploaded" true for all the multipart upload routes.
 *
 * Usage: `@UseInterceptors(FileInterceptor('file'), FileScanInterceptor)`.
 */
@Injectable()
export class FileScanInterceptor implements NestInterceptor {
  constructor(private readonly scanner: FileScanService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const req = context.switchToHttp().getRequest();
    const files: any[] = [];
    if (req.file) files.push(req.file);
    if (Array.isArray(req.files)) files.push(...req.files);
    else if (req.files && typeof req.files === 'object') {
      for (const key of Object.keys(req.files)) {
        const v = req.files[key];
        if (Array.isArray(v)) files.push(...v);
      }
    }

    for (const f of files) {
      // Fail closed. This used to skip any file without an in-memory `buffer`, so a route whose
      // multer options stored to disk would have passed every upload unscanned and unchecked. A
      // disk-backed file is read back and inspected; a file with neither is refused.
      let bytes: Buffer | undefined = f?.buffer;
      if (!bytes && typeof f?.path === 'string') bytes = await readFile(f.path);
      if (!bytes) {
        throw withCode(
          new BadRequestException('The uploaded file could not be read for inspection. Please re-upload it.'),
          ASSAYER_ERROR_CODES.UPLOAD_REJECTED,
        );
      }
      await this.scanner.scanOrThrow(bytes, f.originalname, f.mimetype);
    }
    return next.handle();
  }
}
