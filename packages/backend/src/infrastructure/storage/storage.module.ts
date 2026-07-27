import { Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocalStorageService } from './local-storage.service';
import { S3StorageService } from './s3-storage.service';
import { StorageEngine } from './storage-engine.interface';

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
  providers: [LocalStorageService, S3StorageService, storageProvider],
  exports: ['StorageEngine'],
})
export class StorageModule {}
