/**
 * FAPOMS — Assayer Module
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AssayerEntity } from './assayer.entity';
import { AssayerService } from './assayer.service';
import { AssayerController } from './assayer.controller';

@Module({
  imports: [TypeOrmModule.forFeature([AssayerEntity])],
  controllers: [AssayerController],
  providers: [AssayerService],
  exports: [AssayerService],
})
export class AssayerModule {}
