import { Module } from '@nestjs/common';
import { AppLinksController } from './app-links.controller';

/** `/.well-known` app-link files — see AppLinksController. PlatformSettingsService comes from the global PlatformSettingsModule. */
@Module({
  controllers: [AppLinksController],
})
export class AppLinksModule {}
