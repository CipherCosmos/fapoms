import { CallHandler, ExecutionContext, Injectable, InternalServerErrorException, NestInterceptor } from '@nestjs/common';
import { promises as fsp } from 'fs';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { FileScanService } from '../../infrastructure/security/file-scan.service';

/** The multer file fields this interceptor reads. */
interface UploadedFileLike {
  originalname?: string;
  path?: string;
  buffer?: Buffer;
}

/** Every file a multipart request carries, whichever multer interceptor put it there. */
export function uploadedFilesOf(req: any): UploadedFileLike[] {
  const files: UploadedFileLike[] = [];
  if (req?.file) files.push(req.file);
  if (Array.isArray(req?.files)) files.push(...req.files);
  else if (req?.files && typeof req.files === 'object') {
    for (const value of Object.values(req.files)) {
      if (Array.isArray(value)) files.push(...(value as UploadedFileLike[]));
    }
  }
  return files;
}

/** Delete the temp files behind a disk-backed upload. Never throws: cleanup must not mask the answer. */
export async function discardDiskUploads(files: UploadedFileLike[]): Promise<void> {
  await Promise.all(
    files.map((f) => (f?.path ? fsp.rm(f.path, { force: true }).catch(() => undefined) : undefined)),
  );
}

/**
 * The malware scan and the cleanup for a route whose uploads multer wrote to disk
 * (`diskUploadMulterOptions`). Use it directly after the multer interceptor, in place of
 * `FileScanInterceptor`.
 *
 * **Why not `FileScanInterceptor`.** It scans `file.buffer`, and skips a file without one. A
 * disk-backed file has no buffer, so on such a route it would let every file through unscanned while
 * looking, in the decorator list, exactly like the control that stops them. This scans each file from
 * its temp path — one at a time, so the batch never sits in memory whole — and refuses a file it can
 * find neither a path nor a buffer for, rather than passing it.
 *
 * **Why the cleanup is here.** Nest does not delete multer's temp files. Anything that ends the
 * request after multer has written them — this scan refusing a file, a pipe refusing a query
 * parameter, the handler throwing, or the handler succeeding — would leave customer paperwork in the
 * container's temp directory. `finalize` runs on every one of those outcomes, and the scan's own
 * refusal cleans up before it is thrown.
 *
 * Same rule as `FileScanInterceptor` otherwise: the first infected file rejects the whole request,
 * before the handler has filed anything.
 */
@Injectable()
export class DiskUploadScanInterceptor implements NestInterceptor {
  constructor(private readonly scanner: FileScanService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const files = uploadedFilesOf(context.switchToHttp().getRequest());

    try {
      for (const file of files) {
        const bytes = file.path ? await fsp.readFile(file.path) : file.buffer;
        if (!bytes) {
          throw new InternalServerErrorException(
            `"${file.originalname ?? 'upload'}" could not be scanned, so it was not accepted.`,
          );
        }
        await this.scanner.scanOrThrow(bytes, file.originalname);
      }
    } catch (err) {
      await discardDiskUploads(files);
      throw err;
    }

    return next.handle().pipe(finalize(() => void discardDiskUploads(files)));
  }
}
