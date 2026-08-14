import { Global, Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PlatformSettingEntity } from './platform-setting.entity';
import { PlatformSettingsService } from './platform-settings.service';
import { PlatformSettingsController } from './platform-settings.controller';
import { AuditModule } from '../../core/audit/audit.module';
import { setAppPublicUrl } from '../notifications/email-provider';

/**
 * Global on purpose.
 *
 * Configuration is consulted by pricing, billing, expenses, scheduling and delivery — modules
 * with no other reason to know about each other. Making every one of them import a settings
 * module would add edges to the dependency graph purely to read a number, and the first time
 * two of those modules also referenced each other it would become a cycle. A global provider
 * is the shape this actually is: one read-mostly map that everything may ask.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([PlatformSettingEntity]), AuditModule],
  controllers: [PlatformSettingsController],
  providers: [PlatformSettingsService],
  exports: [PlatformSettingsService],
})
export class PlatformSettingsModule implements OnModuleInit {
  constructor(private readonly settings: PlatformSettingsService) {}

  async onModuleInit(): Promise<void> {
    /**
     * `appPublicUrl()` is a plain function called from render helpers that have no injector, so
     * the value is pushed to it rather than pulled. Applied once at boot and again whenever it
     * changes, which is what stops a saved address from taking effect only after a restart.
     */
    const apply = async () => {
      const url = await this.settings.get<string>('app.publicUrl').catch(() => null);
      setAppPublicUrl(url ?? null);
    };
    await apply();
    this.settings.onChange('app.publicUrl', apply);
  }
}
