import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ValidationQueryEntity } from '../validation-query/validation-query.entity';
import { ValidationQueryMessageEntity } from '../validation-query/validation-query-message.entity';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';

/**
 * In-app voice calls on clarification threads (assayer ↔ data-entry desk).
 * Media: self-hosted LiveKit (docker-compose `livekit`). This module owns identity,
 * authorisation, call lifecycle, and the call log written into the query thread.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ValidationQueryEntity, ValidationQueryMessageEntity])],
  controllers: [CallsController],
  providers: [CallsService],
})
export class CallsModule {}
