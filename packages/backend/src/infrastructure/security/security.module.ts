import { Global, Module } from '@nestjs/common';
import { FileScanService } from './file-scan.service';
import { FileScanInterceptor } from './file-scan.interceptor';

/**
 * Cross-cutting data-protection services. Global so any controller can apply `FileScanInterceptor` or
 * inject `FileScanService` without re-importing. (Field-level column encryption is a pure ORM
 * transformer with no DI, so it lives outside this module.)
 */
@Global()
@Module({
  providers: [FileScanService, FileScanInterceptor],
  exports: [FileScanService, FileScanInterceptor],
})
export class SecurityModule {}
