import { Module, Global } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventsGateway } from './events.gateway';
import { ScopeModule } from '../../infrastructure/scope/scope.module';
import { AssayerEntity } from '../assayer/assayer.entity';

@Global()
@Module({
  imports: [
    // RegionGuardService: room subscriptions must prove entitlement before joining.
    ScopeModule,
    // Just the entity, not AssayerModule — the gateway needs one lifecycle read per connection and
    // importing the module would pull its service graph into a @Global module and risk a cycle.
    TypeOrmModule.forFeature([AssayerEntity]),
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
