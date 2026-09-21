import { Logger, Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LocalStorageService } from './local-storage.service';
import { S3StorageService } from './s3-storage.service';

/**
 * Provides the active StorageEngine implementation based on the STORAGE_DRIVER
 * environment variable:
 *
 *   STORAGE_DRIVER=s3    → S3StorageService  (MinIO in dev, AWS S3 in prod)
 *   STORAGE_DRIVER=local → LocalStorageService  (unit-test / bare-metal fallback only)
 *
 * All modules that need to persist or retrieve binary files import StorageModule
 * and inject the 'StorageEngine' token — never a concrete service class.
 */
const storageProvider: Provider = {
  provide: 'StorageEngine',
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const configured = config.get<string>('STORAGE_DRIVER');
    if (configured === 's3') {
      return new S3StorageService(config);
    }

    /**
     * Falling back to local disk is said out loud.
     *
     * `assertProductionSafeConfig` (main.ts) already refuses to boot in production unless this
     * is `s3`, so the dangerous case is narrower than "no guard": it is a deployment whose
     * NODE_ENV is not `production`, which makes that whole guard return early. That is not
     * hypothetical — `.env.docker` carried `NODE_ENV=development` on a publicly reachable stack
     * until 2026-09-19, which silently disabled every production assertion at once.
     *
     * Local disk is a legitimate choice for tests and bare metal, so this does not throw — that
     * would fail the suites this fallback exists to serve. But an UNSET driver is a
     * configuration someone forgot rather than one they chose, and audit PDFs written to a
     * container's filesystem disappear with the container and 404 from every other replica. So
     * the two cases are distinguished, and the forgotten one leaves a trail.
     */
    if (!configured) {
      new Logger('StorageModule').warn(
        'STORAGE_DRIVER is not set — storing files on LOCAL DISK. Uploaded audit documents and '
        + 'KYC scans will be lost when this container is replaced and will 404 from any other '
        + 'replica. Set STORAGE_DRIVER=s3 for any deployment that keeps its evidence.',
      );
    }
    return new LocalStorageService();
  },
};

@Module({
  imports: [ConfigModule],
  providers: [LocalStorageService, S3StorageService, storageProvider],
  // Export the token so any importing module can inject @Inject('StorageEngine').
  // LocalStorageService is kept available for tests that inject it directly.
  exports: ['StorageEngine', LocalStorageService],
})
export class StorageModule {}
