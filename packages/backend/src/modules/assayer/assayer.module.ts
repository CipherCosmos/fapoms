/**
 * FAPOMS — Assayer Module
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AssayerEntity } from './assayer.entity';
import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from './workforce-attribute.entity';
import { AssayerService } from './assayer.service';
import { AssayerController } from './assayer.controller';

@Module({
  imports: [TypeOrmModule.forFeature([AssayerEntity, AssayerCommercialProfileEntity, WorkforceAttributeEntity])],
  controllers: [AssayerController],
  providers: [AssayerService],
  exports: [AssayerService, TypeOrmModule],
})
export class AssayerModule {}
