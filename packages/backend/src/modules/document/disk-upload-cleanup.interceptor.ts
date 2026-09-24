import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { discardDiskUploads, uploadedFilesOf } from './disk-upload-scan.interceptor';

/**
 * The temp-file cleanup of `DiskUploadScanInterceptor`, WITHOUT its in-request scan — for the one
 * route whose files are scanned in the background job instead: `POST /documents/upload-generated-batch`.
 *
 * That route takes up to 100 packets of up to 50 MB and must answer the moment they are stored
 * (202), so scanning each one in the request — a ClamAV round trip per file — is exactly the wait
 * the move to a background job removes. `GeneratedDocumentBatchJob.fileOne` scans every file (the
 * malware scan and the byte-level content gate, `FileScanService.scanOrThrow`) before it is stored
 * as a document; `upload-scan-parity.spec.ts` pins both that call and that this is the only route
 * allowed to defer it.
 *
 * What is kept from the scanning interceptor is the part Nest does not do: deleting multer's temp
 * files however the request ends (stored and answered, refused by the kind's `prepare`, a pipe, or
 * an error). By then `BackgroundJobsService.create` has copied each file to object storage, so the
 * temp copies are never needed again.
 */
@Injectable()
export class DiskUploadCleanupInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const files = uploadedFilesOf(context.switchToHttp().getRequest());
    return next.handle().pipe(finalize(() => void discardDiskUploads(files)));
  }
}
