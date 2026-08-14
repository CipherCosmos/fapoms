import { Module, Global } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventsGateway } from './events.gateway';
import { ScopeModule } from '../../infrastructure/scope/scope.module';

@Global()
@Module({
  imports: [
    // RegionGuardService: room subscriptions must prove entitlement before joining.
    ScopeModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'dev-secret'),
        signOptions: { expiresIn: 900 },
      }),
    }),
  ],
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class RealtimeModule {}
