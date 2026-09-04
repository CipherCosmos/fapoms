/**
 * FAPOMS — Auth Module
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { SessionService } from './session.service';
import { SessionController } from './session.controller';
import { UserSessionEntity } from './user-session.entity';
import { MfaService } from './mfa.service';
import { MfaController } from './mfa.controller';
import { UserMfaEntity } from './user-mfa.entity';
import { MfaRecoveryCodeEntity } from './mfa-recovery-code.entity';
import { UserEntity } from '../user/user.entity';
import { RefreshTokenEntity } from './refresh-token.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
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
    TypeOrmModule.forFeature([UserEntity, RefreshTokenEntity, AssayerEntity, UserSessionEntity, UserMfaEntity, MfaRecoveryCodeEntity]),
    // For the lockout alert. Safe direction: NotificationsModule pulls guards as plain
    // class imports, never this module.
    NotificationsModule,
  ],
  controllers: [AuthController, SessionController, MfaController],
  providers: [AuthService, JwtStrategy, SessionService, MfaService],
  exports: [AuthService, JwtStrategy, PassportModule, SessionService],
})
export class AuthModule {}
