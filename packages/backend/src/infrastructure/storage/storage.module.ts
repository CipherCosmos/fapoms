import { Module, Provider } from '@nestjs/common';
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
    const driver = config.get<string>('STORAGE_DRIVER', 'local');
    if (driver === 's3') {
      return new S3StorageService(config);
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
