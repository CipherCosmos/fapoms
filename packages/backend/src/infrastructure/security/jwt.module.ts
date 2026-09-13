import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

/**
 * The one `JwtModule.registerAsync` registration every access-token consumer imports.
 *
 * Auth, the realtime gateway, and the global rate-limiter guard each used to hold their own copy
 * of this exact secret/expiry configuration — one registered here properly, one re-registered
 * identically in `RealtimeModule`, and one hand-built with `new JwtService(...)` in the throttler
 * guard specifically to avoid importing the whole auth module graph into a global guard. Three
 * places a `JWT_ACCESS_EXPIRATION` or signing change had to be made in lockstep by hand, with
 * nothing that would catch it if one were missed. Importing this module is the same size cost the
 * throttler guard was originally avoiding — a small, dependency-free registration — without the
 * duplication.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET', 'dev-secret'),
        signOptions: {
          expiresIn: configService.get<number>('JWT_ACCESS_EXPIRATION', 900),
        },
      }),
    }),
  ],
  exports: [JwtModule],
})
export class AppJwtModule {}
