import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsGateway } from './events.gateway';
import { ScopeModule } from '../../infrastructure/scope/scope.module';
import { AppJwtModule } from '../../infrastructure/security/jwt.module';
import { AssayerEntity } from '../assayer/assayer.entity';

@Global()
@Module({
  imports: [
    // RegionGuardService: room subscriptions must prove entitlement before joining.
    ScopeModule,
    // Just the entity, not AssayerModule — the gateway needs one lifecycle read per connection and
    // importing the module would pull its service graph into a @Global module and risk a cycle.
    // AppJwtModule below is the same reasoning applied to auth: the shared JwtModule registration,
    // not the whole AuthModule (which would pull in AuthService, MfaService, SessionService, its
    // controllers and NotificationsModule) — a @Global module has no business holding that graph.
    TypeOrmModule.forFeature([AssayerEntity]),
    AppJwtModule,
  ],
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class RealtimeModule {}
