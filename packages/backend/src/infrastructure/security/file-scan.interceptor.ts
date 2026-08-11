import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { FileScanService } from './file-scan.service';

/**
 * Malware-scans every file a multipart request carries before the route handler runs. Applied right
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
      if (f?.buffer) await this.scanner.scanOrThrow(f.buffer, f.originalname);
    }
    return next.handle();
  }
}
